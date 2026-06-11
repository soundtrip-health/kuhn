// Story 011: Agent runtime on the Claude Agent SDK, behind the agent-task
// boundary. The rest of the system depends only on runAgentTask(); the SDK
// is an implementation detail of this module.

import { mkdir } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { query as sdkQuery, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { config } from '../config.js';
import { query as dbQuery } from '../db.js';
import { getAgentWithTools } from '../db/agents.js';
import { createConversation, logMessage } from '../db/conversation.js';
import { createJob, updateJob } from '../db/jobs.js';
import { EventChannel } from './events.js';
import { pubmedSearch, arxivSearch } from './search.js';

// DB tool slug → built-in SDK tool names. Tools not granted to a role are
// removed entirely via the SDK `tools` option (allowedTools alone does not
// restrict anything under permissionMode: 'bypassPermissions').
const BUILTIN_TOOL_MAP = {
  file_read: ['Read', 'Grep'],
  file_list: ['Glob'],
  file_write: ['Write', 'Edit'],
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
 *   { type: 'text', agent, content }
 *   { type: 'file_change', agent, path, kind: 'create'|'update'|'delete' }
 *   { type: 'question', agent, content }
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
      // Consumer stopped early (e.g. browser disconnected) — stop the SDK loop
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
      model: config.agent.model,
      maxTurns: MAX_TURNS,
      tools: builtinTools,           // removes every built-in tool not granted to this role
      allowedTools,
      permissionMode: 'bypassPermissions',
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
    `Your project workspace is ${projectDir} (your current working directory).`,
    'All file paths are relative to the workspace. Never read or write outside it.',
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
  const path = toolCall.input?.file_path ?? toolCall.input?.path;
  if (!path) return null;
  if (toolCall.name === 'Write') return { type: 'file_change', agent: agentSlug, path, kind: 'create' };
  if (toolCall.name === 'Edit') return { type: 'file_change', agent: agentSlug, path, kind: 'update' };
  return null;
}

/**
 * Resolve (and create) the workspace directory for a project. Uses
 * projects.root_path when set, else <projectsRoot>/<projectId>.
 */
export async function resolveProjectDir(projectId) {
  let dir = null;
  const { rows } = await dbQuery('SELECT root_path FROM projects WHERE id = $1', [projectId]);
  if (rows[0]?.root_path) {
    dir = isAbsolute(rows[0].root_path)
      ? rows[0].root_path
      : resolve(config.agent.projectsRoot, rows[0].root_path);
  } else {
    dir = join(config.agent.projectsRoot, String(projectId));
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

function buildMcpTools(agent, { projectId, depth, budget, parentJob, channel }) {
  const tools = [];

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
