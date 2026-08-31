/**
 * Claude SDK conformance driver (STH-5).
 *
 * Plays scripted model turns through the production runAgentTask() by
 * standing in for '@anthropic-ai/claude-agent-sdk' (see ../mock-sdk.js). This
 * file is the ONLY place in the harness that knows Claude SDK message shapes,
 * `mcp__kuhn__*` tool names, or `sdkQuery` — scenarios and assertions speak
 * Kuhn tool slugs and domain events only, so the same scenario file runs
 * unchanged against the Pi bridge.
 *
 * What is REAL in this driver:
 *   - every Kuhn tool handler executes for real (storage, pending edits,
 *     references, comments, jobs, conversations, org knowledge, dispatch,
 *     ask_user) — the app code under test is untouched;
 *   - zod schema validation of tool arguments (invalid args -> isError
 *     tool_result, handler never invoked), matching the SDK's in-process MCP
 *     layer;
 *   - the app's retry loop, budget accounting, and teardown are the
 *     production implementations.
 *
 * What is SCRIPTED: the model itself — which tools it calls, what it says,
 * the token usage it reports, and when a provider failure happens. Usage is
 * declared per turn by the scenario so both drivers feed the app's budget
 * logic identical inputs.
 *
 * Query/run pairing. One runTask makes one or more sdkQuery calls (retries),
 * and a chat follow-up makes a fresh run that resumes an earlier session:
 *   - a query WITHOUT `resume` starts a new run: the next model script for
 *     its role (the role is read from the app's own system prompt, which
 *     embeds the agent slug) becomes the run's script;
 *   - a query WITH `resume: <session>` and a prompt identical to the run
 *     that emitted that session is a RETRY of that run: it consumes the
 *     next `attempts[]` entry and re-emits the same session id;
 *   - a query WITH `resume` but a different prompt is a FOLLOW-UP: a new
 *     run (next model script for the role) that inherits the session id and
 *     the prior run's canonical continuation, exactly like resuming a live
 *     provider session.
 * Dispatched child runs nest inside the parent's query; the per-role FIFO
 * handles them because the child's system prompt carries the child's slug,
 * and the LIFO MCP-server index gives each nested run its own toolset.
 *
 * Interruption. The production runtime ends a run two ways: sdk.interrupt()
 * (teardown, budget) or dropping the consumer. Both surface as the generator
 * being .return()'d from the outside; the wrapper sets the interrupt flag
 * before delegating, and the generator's finally records the normalized
 * `cancelled` terminal so every query transcript is contract-complete.
 */
import { normalizeProviderError } from '../../provider-runtime/contract.js';
import { createContinuation } from '../../provider-runtime/continuation.js';
import { renderedError } from './error-rendering.js';
import { z } from 'zod';

/** The SDK's tool() takes a raw zod shape and wraps it in z.object()
 * internally; the captured definitions keep the raw shape, so normalize
 * before validating (handles `{}` = no parameters). */
function toZodSchema(schema) {
  if (schema && (typeof schema.safeParse === 'function' || schema._def)) return schema;
  return z.object(schema ?? {});
}

const ROLE_PATTERN = /You are running as the "(\w+)" agent/;

export function createClaudeBridge(scenario) {
  const bridge = {
    name: 'claude-sdk',
    kind: 'claude',
    observations: [], // one per sdkQuery call
    transcripts: [],  // one normalized transcript per sdkQuery call
    _roleQueues: new Map(),
    _runs: new Map(), // sessionId -> run record
    _seq: 0,
  };
  // Per-role FIFO of model scripts, in scenario task order. A dispatched
  // child run consumes its own role's queue when its nested query starts.
  for (const task of scenario.tasks) {
    const queue = bridge._roleQueues.get(task.role) ?? [];
    queue.push(task.model);
    bridge._roleQueues.set(task.role, queue);
  }

  bridge.query = (args, mockState) => {
    let signalRes;
    const ctl = {
      interrupted: false,
      signal: new Promise((resolve) => { signalRes = resolve; }),
    };
    const gen = claudeQuery(bridge, args, mockState, ctl);
    // The app's teardown calls sdk.interrupt() and then the for-await
    // .return()'s the iterator. Either way, record the interruption before
    // the generator settles so its finally writes the cancelled terminal.
    gen.interrupt = () => {
      ctl.interrupted = true;
      signalRes();
      return Promise.resolve();
    };
    const innerReturn = gen.return?.bind(gen);
    gen.return = (...a) => {
      ctl.interrupted = true;
      return innerReturn?.(...a);
    };
    return gen;
  };
  return bridge;
}

async function* claudeQuery(bridge, args, mockState, ctl) {
  const options = args.options ?? {};
  const role = (options.systemPrompt?.match(ROLE_PATTERN) ?? [])[1] ?? null;
  if (!role) {
    throw new Error('claude driver: systemPrompt does not identify a Kuhn agent role');
  }
  const resume = options.resume ?? null;

  // ---- Pair this query with its run ---------------------------------------
  let run;
  let isRetry = false;
  if (resume) {
    const candidate = bridge._runs.get(resume);
    if (candidate && candidate.prompt === args.prompt) {
      // Retry of the same run (the app's transient-error loop). The session
      // already carries the failed attempt's context, so the prompt is not
      // re-appended.
      run = candidate;
      run.attemptIndex += 1;
      isRetry = true;
    } else if (candidate) {
      // Follow-up: new run, same session, prior context inherited.
      run = freshRun(bridge, role, resume, candidate.messages);
      run.prompt = args.prompt;
      bridge._runs.set(resume, run);
    } else {
      throw new Error(`claude driver: resume references unknown session ${resume}`);
    }
  } else {
    run = freshRun(bridge, role, null, null);
    run.prompt = args.prompt;
    bridge._runs.set(run.sessionId, run);
  }
  const sessionId = run.sessionId;
  if (run.mcpIndex == null) {
    // runTask builds the MCP server immediately before its first query, so
    // the last captured server is this run's. A nested child run captures
    // its own index the same way while the parent is parked in dispatch.
    run.mcpIndex = mockState.mcpServers.length - 1;
    if (run.mcpIndex < 0) throw new Error('claude driver: query before createSdkMcpServer');
  }
  const attempt = run.modelScript.attempts[run.attemptIndex];
  if (!attempt) {
    throw new Error(`claude driver: role ${role} ran out of scripted attempts (attempt ${run.attemptIndex})`);
  }
  const toolsByName = new Map((mockState.mcpServers[run.mcpIndex]?.tools ?? []).map((t) => [t.name, t]));

  // ---- Observation: app-owned inputs this driver received ------------------
  const observation = {
    role,
    sessionId,
    prompt: args.prompt,
    systemPrompt: options.systemPrompt ?? null,
    cwd: options.cwd ?? null,
    model: options.model ?? null,
    resume,
    attempt: run.attemptIndex,
    allowedTools: [...(options.allowedTools ?? [])],
    builtinTools: [...(options.tools ?? [])],
    mcpToolNames: [...toolsByName.keys()],
    interrupted: false,
  };
  bridge.observations.push(observation);

  // ---- Normalized transcript (provider-runtime contract shape) -------------
  const transcript = [];
  bridge.transcripts.push(transcript);
  transcript.push({ type: 'provider', provider: 'claude', model: observation.model ?? 'claude', api: 'claude-sdk' });

  // Canonical continuation: everything the session has seen so far. A retry
  // reuses the session (the prompt is already in run.messages); a fresh run
  // or follow-up appends the prompt. continuationMessages aliases
  // run.messages so the terminal continuation is the cumulative context.
  if (!isRetry) {
    run.messages.push({ role: 'user', content: [{ type: 'text', text: args.prompt }] });
  }
  const continuationMessages = run.messages;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 0 };
  let terminalEmitted = false;
  const emitDone = () => {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
    const continuation = createContinuation(continuationMessages);
    run.continuation = continuation;
    terminalEmitted = true;
    transcript.push({ type: 'done', finishReason: 'stop', usage: { ...usage }, continuation });
  };
  const emitCancelled = () => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    observation.interrupted = true;
    const err = renderedError('cancelled');
    transcript.push({
      type: 'error',
      error: normalizeProviderError(err, { stopReason: 'aborted' }),
      usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
    });
  };

  // The app keys its retry and job session on the init message.
  yield { type: 'system', subtype: 'init', session_id: sessionId };

  try {
    for (const [ti, turn] of attempt.turns.entries()) {
      if (ctl.interrupted) { emitCancelled(); return; }
      if (turn.pauseUntilAbort) {
        // Park until the production teardown calls sdk.interrupt(): it
        // resolves the signal and the app then awaits the run's pump, which
        // only settles once this generator ends.
        await ctl.signal;
      }
      if (ctl.interrupted) { emitCancelled(); return; }
      for (const delta of turn.deltas ?? []) {
        transcript.push({ type: 'text_delta', content: delta });
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } };
        if (ctl.interrupted) { emitCancelled(); return; }
      }
      const toolCalls = turn.toolCalls ?? [];
      const assistantBlocks = [];
      if (turn.text) assistantBlocks.push({ type: 'text', text: turn.text });
      for (const [ci, call] of toolCalls.entries()) {
        assistantBlocks.push({
          type: 'tool_use',
          id: `t${run.attemptIndex}.${ti}.${ci}`,
          name: `mcp__kuhn__${call.tool}`,
          input: call.args,
        });
      }
      if (assistantBlocks.length > 0) {
        const turnUsage = turn.usage ?? { input: 0, output: 0 };
        usage.inputTokens += turnUsage.input;
        usage.outputTokens += turnUsage.output;
        yield {
          type: 'assistant',
          message: {
            content: assistantBlocks,
            usage: { input_tokens: turnUsage.input, output_tokens: turnUsage.output },
          },
        };
        if (turn.text) transcript.push({ type: 'text', content: turn.text });
        const assistantContent = [];
        if (turn.text) assistantContent.push({ type: 'text', text: turn.text });
        for (const [ci, call] of toolCalls.entries()) {
          const id = `t${run.attemptIndex}.${ti}.${ci}`;
          transcript.push({ type: 'tool_call', id, name: call.tool, arguments: call.args });
          assistantContent.push({ type: 'tool_call', id, name: call.tool, arguments: call.args });
        }
        continuationMessages.push({ role: 'assistant', content: assistantContent });
      }
      for (const [ci, call] of toolCalls.entries()) {
        const id = `t${run.attemptIndex}.${ti}.${ci}`;
        const result = await executeKuhnTool(toolsByName, call);
        if (ctl.interrupted) { emitCancelled(); return; }
        transcript.push({
          type: 'tool_result',
          id,
          name: call.tool,
          content: [{ type: 'text', text: result.text }],
          isError: result.isError === true,
        });
        continuationMessages.push({
          role: 'tool_result',
          toolCallId: id,
          toolName: call.tool,
          content: [{ type: 'text', text: result.text }],
          isError: result.isError === true,
        });
        yield {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: id,
              content: result.text,
              ...(result.isError ? { is_error: true } : {}),
            }],
          },
        };
      }
    }

    if (ctl.interrupted) { emitCancelled(); return; }
    if (attempt.error) {
      const code = attempt.error.code;
      const err = renderedError(code);
      terminalEmitted = true;
      transcript.push({
        type: 'error',
        error: normalizeProviderError(err, { stopReason: code === 'cancelled' ? 'aborted' : undefined }),
        usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
      });
      throw err;
    }
    yield {
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    };
    emitDone();
  } finally {
    // Externally ended (teardown/budget interrupt, consumer drop): the
    // provider side is a cancelled terminal; record it so the transcript
    // stays contract-complete even though the app never sees it.
    emitCancelled();
  }
}

function freshRun(bridge, role, resumeSession, priorMessages) {
  const queue = bridge._roleQueues.get(role);
  const modelScript = queue?.shift();
  if (!modelScript) {
    throw new Error(`claude driver: no scripted model left for role ${role} — scenario/tasks mismatch`);
  }
  return {
    role,
    modelScript,
    attemptIndex: 0,
    mcpIndex: null,
    sessionId: resumeSession ?? `sess-${role}-${bridge._seq++}`,
    prompt: null,
    // Cumulative canonical context (a copy — the prior run's array stays
    // intact for its own records).
    messages: priorMessages ? [...priorMessages] : [],
    continuation: null,
  };
}

/** Execute a Kuhn tool exactly the way the SDK's in-process MCP layer would:
 * validate the arguments against the zod schema first (invalid -> isError
 * tool_result, handler never invoked), then invoke the real handler. */
async function executeKuhnTool(toolsByName, call) {
  const toolDef = toolsByName.get(call.tool);
  if (!toolDef) {
    return { isError: true, text: `Tool mcp__kuhn__${call.tool} is not available for this agent role.` };
  }
  const parsed = toZodSchema(toolDef.schema).safeParse(call.args);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join('; ');
    return { isError: true, text: `Invalid arguments for ${call.tool}: ${message}` };
  }
  try {
    const result = await toolDef.handler(parsed.data);
    if (result?.isError === true) {
      return { isError: true, text: resultText(result) };
    }
    return { isError: false, text: resultText(result) };
  } catch (err) {
    return { isError: true, text: `Tool failed: ${err.message}` };
  }
}

function resultText(result) {
  if (typeof result?.content === 'string') return result.content;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  if (blocks.length === 0) return JSON.stringify(result?.content ?? '');
  return blocks.map((b) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('\n');
}
