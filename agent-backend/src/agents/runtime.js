// Story 011: Agent runtime on the Claude Agent SDK, behind the agent-task
// boundary. The rest of the system depends only on runAgentTask(); the SDK
// is an implementation detail of this module.

import { query as sdkQuery, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { config } from '../config.js';
import { getAgentWithTools } from '../db/agents.js';
import { createConversation, logMessage } from '../db/conversation.js';
import { createJob, updateJob } from '../db/jobs.js';
import { updateProjectConfig } from '../db/projects.js';
import {
  resolveProjectDir,
  readProjectFile,
  writeProjectFile,
  listProjectTree,
  searchProjectFiles,
} from '../storage.js';
import { EventChannel } from './events.js';
import { waitForReply, cancelQuestion } from './questions.js';
import { pubmedSearch, arxivSearch } from './search.js';

// DB tool slug → built-in SDK tool names. File access deliberately maps to
// no built-ins (story 018): agents get storage-backed MCP tools instead, so
// every file operation goes through the project-root-enforcing storage
// service. Tools not granted to a role are removed entirely via the SDK
// `tools` option (allowedTools alone does not restrict anything under
// permissionMode: 'bypassPermissions').
const BUILTIN_TOOL_MAP = {
  web_search: ['WebSearch', 'WebFetch'],
};

const MAX_TURNS = parseInt(process.env.AGENT_MAX_TURNS || '50');

/**
 * Run an agent task. The only contract the rest of the system sees.
 *
 * @param {object} task
 * @param {string} task.role - 'pm' | 'writer' | 'analyst' | 'advisor' | 'research'/'ra' | 'review'/'reviewer'
 * @param {number|string} task.projectId - Project whose workspace the task may touch
 * @param {string} task.input - User message or dispatch instruction
 * @param {object} [task.context] - Optional editor context: { selection, cursor: {line}, files }
 * @param {string} [task.sessionId] - Continue a prior SDK session
 * @param {object} [internal] - Used by dispatch_agent for sub-tasks; not part of the boundary
 * @returns {AsyncGenerator<AgentEvent>} Events:
 *   { type: 'text_delta', agent, content }   — token-level streaming (story 013)
 *   { type: 'text', agent, content }         — full text of the finished turn
 *   { type: 'file_change', agent, path, kind: 'create'|'update'|'delete' }
 *   { type: 'question', agent, jobId, content } — ask_user is waiting; reply via POST /api/agent/jobs/:jobId/reply
 *   { type: 'done', agent, jobId, sessionId, usage: { inputTokens, outputTokens } }
 *   { type: 'error', agent, jobId, message }
 */
export async function* runAgentTask(task, internal = {}) {
  const channel = new EventChannel();
  const state = { sdkQuery: null, finished: false, job: null };

  const pump = runTask(task, internal, channel, state)
    .catch(async (err) => {
      console.error('[agent] Task failed:', err);
      channel.push({ type: 'error', agent: task.role, jobId: state.job?.id, message: err.message });
      if (state.job) {
        await updateJob(state.job.id, { status: 'error', error: err.message }).catch(() => {});
      }
    })
    .finally(() => {
      state.finished = true;
      channel.end();
    });

  try {
    for await (const event of channel) {
      yield event;
    }
  } finally {
    if (!state.finished) {
      // Consumer stopped early (e.g. browser disconnected) — stop the SDK loop.
      // Unblock ask_user first: the SDK loop may be parked inside its handler.
      if (state.job) cancelQuestion(state.job.id);
      try {
        await state.sdkQuery?.interrupt();
      } catch { /* already stopped */ }
      if (state.job) {
        await updateJob(state.job.id, { status: 'cancelled' }).catch(() => {});
      }
    }
    await pump;
  }
}

async function runTask(task, internal, channel, state) {
  const { role, projectId, input, context = null, sessionId = null } = task;
  const depth = internal.depth ?? 0;
  const parentJobId = internal.parentJobId ?? null;
  const budget = internal.budget ?? { used: 0, limit: config.agent.tokenBudget };

  const agent = await getAgentWithTools(role);
  if (!agent) throw new Error(`Unknown agent role: ${role}`);

  const job = await createJob({ role: agent.slug, projectId, input, context, parentJobId });
  state.job = job;

  const conversation = await createConversation(agent.slug, projectId);
  await updateJob(job.id, { status: 'running', conversationId: conversation.id });
  await logMessage({ conversationId: conversation.id, role: 'user', content: input });

  const projectDir = await resolveProjectDir(projectId);

  // In-process MCP tools, filtered by the role's DB allowlist
  const mcpTools = buildMcpTools(agent, { projectId, depth, budget, parentJob: job, channel });
  const mcpServer = mcpTools.length > 0
    ? createSdkMcpServer({ name: 'kuhn', version: '1.0.0', tools: mcpTools })
    : null;

  const builtinTools = agent.tools.flatMap((slug) => BUILTIN_TOOL_MAP[slug] ?? []);
  const allowedTools = [
    ...builtinTools,
    ...mcpTools.map((t) => `mcp__kuhn__${t.name}`),
  ];

  const sdk = sdkQuery({
    prompt: buildPrompt(input, context),
    options: {
      systemPrompt: buildSystemPrompt(agent, projectDir),
      cwd: projectDir,
      // Per-agent model (story 021): each role runs on its DB-configured model
      // (sub-agents dispatched via dispatch_agent load their own row, so a
      // Haiku RA can serve an Opus PM); AGENT_MODEL is the global fallback.
      model: agent.model ?? config.agent.model,
      maxTurns: MAX_TURNS,
      tools: builtinTools,           // removes every built-in tool not granted to this role
      allowedTools,
      permissionMode: 'bypassPermissions',
      includePartialMessages: true,  // token-level text_delta events for the chat UI (story 013)
      settingSources: [],            // never load host CLAUDE.md / settings into agent context
      ...(mcpServer ? { mcpServers: { kuhn: mcpServer } } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });
  state.sdkQuery = sdk;

  const usage = { inputTokens: 0, outputTokens: 0 };
  let sdkSessionId = sessionId;

  for await (const message of sdk) {
    if (message.type === 'system' && message.subtype === 'init') {
      sdkSessionId = message.session_id;
      await updateJob(job.id, { sessionId: sdkSessionId });
      continue;
    }

    if (message.type === 'stream_event') {
      // Token-level streaming: forward text deltas as they arrive. The full
      // turn still follows as a single 'text' event (the chat UI replaces
      // accumulated deltas with it); logging/budgeting stay turn-based.
      const event = message.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        channel.push({ type: 'text_delta', agent: agent.slug, content: event.delta.text });
      }
      continue;
    }

    if (message.type === 'assistant') {
      const blocks = message.message?.content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = blocks.filter((b) => b.type === 'tool_use');

      await logMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: text || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        tokenCount: message.message?.usage?.output_tokens ?? null,
      });

      if (text) channel.push({ type: 'text', agent: agent.slug, content: text });
      for (const call of toolCalls) {
        const fileEvent = fileChangeEvent(agent.slug, call);
        if (fileEvent) channel.push(fileEvent);
      }

      const msgUsage = message.message?.usage;
      if (msgUsage) {
        const inputTokens = effectiveInputTokens(msgUsage);
        budget.used += inputTokens + (msgUsage.output_tokens ?? 0);
        usage.inputTokens += inputTokens;
        usage.outputTokens += msgUsage.output_tokens ?? 0;
      }
      if (budget.used > budget.limit) {
        await sdk.interrupt().catch(() => {});
        await updateJob(job.id, {
          status: 'error',
          error: 'token budget exceeded',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        channel.push({
          type: 'error',
          agent: agent.slug,
          jobId: job.id,
          message: `Token budget exceeded (${budget.used} > ${budget.limit}). Task stopped.`,
        });
        return;
      }
      continue;
    }

    if (message.type === 'user') {
      // Tool results echoed back into the loop
      for (const block of message.message?.content ?? []) {
        if (block.type === 'tool_result') {
          await logMessage({
            conversationId: conversation.id,
            role: 'tool',
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            toolCallId: block.tool_use_id,
          });
        }
      }
      continue;
    }

    if (message.type === 'result') {
      const resultUsage = message.usage ?? {};
      if (resultUsage.input_tokens != null) usage.inputTokens = effectiveInputTokens(resultUsage);
      if (resultUsage.output_tokens != null) usage.outputTokens = resultUsage.output_tokens;

      if (message.subtype === 'success') {
        await updateJob(job.id, {
          status: 'done',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        channel.push({ type: 'done', agent: agent.slug, jobId: job.id, sessionId: sdkSessionId, usage });
      } else {
        const reason = message.subtype.replace(/^error_/, '').replaceAll('_', ' ');
        await updateJob(job.id, {
          status: 'error',
          error: reason,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        channel.push({ type: 'error', agent: agent.slug, jobId: job.id, message: `Agent task stopped: ${reason}` });
      }
    }
  }
}

// Prompt-cache reads/writes are reported separately from input_tokens; count
// them all so budgets and job accounting reflect real context size.
function effectiveInputTokens(usage) {
  return (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
}

function buildSystemPrompt(agent, projectDir) {
  return [
    agent.system_prompt,
    '',
    '## Runtime environment',
    `You are running as the "${agent.slug}" agent inside the Kuhn writing tool.`,
    `Your project workspace is ${projectDir}.`,
    'Use the file tools (read_file, write_file, edit_file, list_files, search_files) for all',
    'file access; they take paths relative to the workspace root and cannot reach outside it.',
  ].join('\n');
}

function buildPrompt(input, context) {
  if (!context) return input;
  const parts = [input];
  if (context.selection) parts.push(`<selection>\n${context.selection}\n</selection>`);
  if (context.cursor?.line != null) parts.push(`The user's cursor is at line ${context.cursor.line}.`);
  if (context.files?.length) parts.push(`Relevant files: ${context.files.join(', ')}`);
  return parts.join('\n\n');
}

function fileChangeEvent(agentSlug, toolCall) {
  const path = toolCall.input?.path;
  if (!path) return null;
  if (toolCall.name === 'mcp__kuhn__write_file') return { type: 'file_change', agent: agentSlug, path, kind: 'create' };
  if (toolCall.name === 'mcp__kuhn__edit_file') return { type: 'file_change', agent: agentSlug, path, kind: 'update' };
  return null;
}

function buildMcpTools(agent, { projectId, depth, budget, parentJob, channel }) {
  const tools = [];

  // File tools (story 018): all project file access goes through the storage
  // service, which enforces the project root. Paths are workspace-relative.
  if (agent.tools.includes('file_read')) {
    tools.push(tool(
      'read_file',
      'Read a file from the project workspace. Path is relative to the workspace root.',
      { path: z.string().describe('Workspace-relative file path') },
      async ({ path }) => fileToolResult(async () => {
        const buf = await readProjectFile(projectId, path);
        return buf.toString('utf-8');
      }),
    ));
    tools.push(tool(
      'search_files',
      'Search project files for a regular expression. Returns matching lines as path:line: text.',
      {
        pattern: z.string().describe('JavaScript regular expression to search for'),
        path: z.string().default('.').describe('Workspace-relative directory to search in'),
      },
      async ({ pattern, path }) => fileToolResult(async () => {
        const matches = await searchProjectFiles(projectId, pattern, path);
        if (matches.length === 0) return 'No matches.';
        return matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
      }),
    ));
  }

  if (agent.tools.includes('file_list')) {
    tools.push(tool(
      'list_files',
      'List the project workspace file tree.',
      { path: z.string().default('.').describe('Workspace-relative directory to list') },
      async ({ path }) => fileToolResult(async () => {
        const tree = await listProjectTree(projectId, path);
        return JSON.stringify(tree, null, 2);
      }),
    ));
  }

  if (agent.tools.includes('file_write')) {
    tools.push(tool(
      'write_file',
      'Create or overwrite a file in the project workspace. Parent directories are created as needed.',
      {
        path: z.string().describe('Workspace-relative file path'),
        content: z.string().describe('Full file content'),
      },
      async ({ path, content }) => fileToolResult(async () => {
        const { created } = await writeProjectFile(projectId, path, content);
        return `${created ? 'Created' : 'Updated'} ${path}`;
      }),
    ));
    tools.push(tool(
      'edit_file',
      'Replace an exact string in a file. old_string must match exactly and, unless replace_all is true, exactly once.',
      {
        path: z.string().describe('Workspace-relative file path'),
        old_string: z.string().describe('Exact text to replace'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z.boolean().default(false).describe('Replace every occurrence'),
      },
      async ({ path, old_string, new_string, replace_all }) => fileToolResult(async () => {
        const content = (await readProjectFile(projectId, path)).toString('utf-8');
        const occurrences = content.split(old_string).length - 1;
        if (occurrences === 0) throw new Error(`old_string not found in ${path}`);
        if (occurrences > 1 && !replace_all) {
          throw new Error(`old_string occurs ${occurrences} times in ${path}; pass replace_all or a longer unique string`);
        }
        await writeProjectFile(projectId, path, content.replaceAll(old_string, new_string));
        return `Updated ${path} (${replace_all ? occurrences : 1} replacement${occurrences > 1 && replace_all ? 's' : ''})`;
      }),
    ));
  }

  if (agent.tools.includes('pubmed_search')) {
    tools.push(tool(
      'pubmed_search',
      'Search PubMed for peer-reviewed scientific papers. Call this whenever you need citations or evidence from the biomedical literature — never cite from memory.',
      {
        query: z.string().describe('Search query (keywords, MeSH terms, or author searches)'),
        max_results: z.number().int().min(1).max(50).default(10).describe('Maximum results to return'),
      },
      async ({ query, max_results }) => searchToolResult(() => pubmedSearch(query, max_results)),
    ));
  }

  if (agent.tools.includes('arxiv_search')) {
    tools.push(tool(
      'arxiv_search',
      'Search arXiv for preprints. Flag any preprint citations as needing verification of peer-reviewed publication status.',
      {
        query: z.string().describe('Search query'),
        max_results: z.number().int().min(1).max(50).default(10).describe('Maximum results to return'),
      },
      async ({ query, max_results }) => searchToolResult(() => arxivSearch(query, max_results)),
    ));
  }

  if (agent.tools.includes('ask_user')) {
    tools.push(tool(
      'ask_user',
      'Ask the user a question and wait for their reply. Use this for interview questions and any decision that needs user input. Ask one question at a time and adapt to earlier answers.',
      { question: z.string().describe('The question to show the user') },
      async ({ question }) => {
        // The reply round-trip (story 012): emit a question event carrying the
        // job id, then park until POST /api/agent/jobs/:id/reply delivers the
        // answer (or the timeout / task teardown unblocks us without one).
        channel.push({ type: 'question', agent: agent.slug, jobId: parentJob.id, content: question });
        const reply = await waitForReply(parentJob.id, config.agent.questionTimeoutMs);
        if (reply == null) {
          return {
            content: [{
              type: 'text',
              text: '[No reply received. Do not wait further: continue with sensible defaults and clearly note any assumptions you make.]',
            }],
          };
        }
        return { content: [{ type: 'text', text: reply }] };
      },
    ));
  }

  if (agent.tools.includes('project_config')) {
    tools.push(tool(
      'save_project_config',
      'Save the structured project configuration gathered in the intake interview. Updates the project record (name, type, config) and writes project.json to the workspace root. Call it once, after the interview is complete and before dispatching sub-agents.',
      {
        title: z.string().describe('Project title'),
        project_type: z.enum(['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'])
          .describe('Document type; pick the closest match for "other" projects'),
        research_question: z.string().describe('The central research question or document purpose'),
        deliverables: z.array(z.string()).min(1).describe('Key deliverables'),
        timeline: z.string().describe('Key milestones and dates (use absolute dates)'),
        source_materials: z.array(z.string()).default([])
          .describe('Source materials the user already has (guidance docs, prior protocols, key papers, data)'),
        notes: z.string().optional().describe('Anything else from the interview worth preserving'),
      },
      async (input) => {
        try {
          const projectConfig = {
            title: input.title,
            project_type: input.project_type,
            research_question: input.research_question,
            deliverables: input.deliverables,
            timeline: input.timeline,
            source_materials: input.source_materials ?? [],
            ...(input.notes ? { notes: input.notes } : {}),
          };
          await updateProjectConfig(projectId, {
            name: input.title,
            projectType: input.project_type,
            config: projectConfig,
          });
          const { created } = await writeProjectFile(
            projectId,
            'project.json',
            JSON.stringify(projectConfig, null, 2) + '\n',
          );
          channel.push({
            type: 'file_change',
            agent: agent.slug,
            path: 'project.json',
            kind: created ? 'create' : 'update',
          });
          return { content: [{ type: 'text', text: 'Project configuration saved to the project record and project.json.' }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to save project config: ${err.message}` }], isError: true };
        }
      },
    ));
  }

  if (agent.tools.includes('spawn_agent') && depth < config.agent.maxDispatchDepth) {
    tools.push(tool(
      'dispatch_agent',
      'Dispatch a sub-agent to perform a focused task (e.g. ra for literature research, advisor for domain review). Returns the sub-agent\'s final output.',
      {
        agent_slug: z.string().describe('Agent to dispatch: pm, writer, ra, advisor, reviewer, analyst'),
        task: z.string().describe('Task description for the sub-agent'),
        context: z.string().optional().describe('Additional context for the sub-agent'),
      },
      async ({ agent_slug, task, context }) => {
        const input = context ? `${task}\n\nContext: ${context}` : task;
        let finalText = '';
        let errorMessage = null;
        const child = runAgentTask(
          { role: agent_slug, projectId, input },
          { depth: depth + 1, parentJobId: parentJob.id, budget },
        );
        for await (const event of child) {
          if (event.type === 'text') finalText += (finalText ? '\n' : '') + event.content;
          if (event.type === 'error') errorMessage = event.message;
          // Forward child progress to the client; the parent emits the single
          // terminal 'done' for the whole task.
          if (event.type !== 'done') channel.push(event);
        }
        if (errorMessage) {
          return { content: [{ type: 'text', text: `Sub-agent failed: ${errorMessage}` }], isError: true };
        }
        return { content: [{ type: 'text', text: finalText || '(sub-agent produced no output)' }] };
      },
    ));
  }

  return tools;
}

async function searchToolResult(fn) {
  try {
    const results = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Search failed: ${err.message}` }], isError: true };
  }
}

async function fileToolResult(fn) {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}
