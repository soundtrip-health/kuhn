/**
 * Pi conformance driver (STH-5).
 *
 * Plays scripted model turns through the production runAgentTask() via the
 * Pi phase-one runtime (provider-runtime/pi-spike.js) with a deterministic
 * faux model (@earendil-works/pi-ai). This file is the ONLY place in the
 * harness that knows Pi event shapes or the translation from Pi to the
 * Claude-SDK-shaped message stream the app consumes — scenarios and
 * assertions speak Kuhn tool slugs and domain events only, so the same
 * scenario file runs unchanged against the Claude bridge.
 *
 * What is REAL in this driver:
 *   - every Kuhn tool handler executes for real (storage, pending edits,
 *     references, comments, jobs, conversations, org knowledge, dispatch,
 *     ask_user) — the app code under test is untouched;
 *   - the phase-one Pi runtime (PiRuntimeSpike): tool execution, normalized
 *     events, continuation conversion, abort handling;
 *   - the app's retry loop, budget accounting, and teardown are the
 *     production implementations.
 *
 * What is SCRIPTED: the model — fauxAssistantMessage() turns (which tools it
 * calls, what it says) and faux stop-reason 'error' messages for provider
 * failures. Usage is declared per turn by the scenario so both drivers feed
 * the app's budget logic identical inputs.
 *
 * Translation (the stand-in layer). The production app today consumes a
 * Claude-SDK-shaped stream; the Pi adapter that replaces that seam is owned
 * by the provider-runtime work. This driver stands in for that seam:
 *   - Pi `provider`        → `system`/`init` (session id from the run record);
 *   - Pi `text_delta`      → `stream_event` (content_block_delta);
 *   - Pi assistant message → `assistant` message (text + tool_uses blocks,
 *     declared per-turn usage), grouped with its tool_results into the
 *     Claude ordering: one assistant message, then one `user` tool_result
 *     per call;
 *   - Pi `done`            → `result`/success with the declared total usage;
 *   - Pi `error`           → throw the provider-native error the app's
 *     production isTransientApiError() will classify (retryable codes retry;
 *     non-retryable ones propagate as the terminal error event).
 * The raw Pi events are recorded verbatim in the bridge's transcripts — the
 * normalized provider-runtime stream the spike itself produced, untouched.
 *
 * Tool parity with the Claude bridge: the same Kuhn handlers, the same zod
 * validation before the handler runs (invalid args → error result, handler
 * never invoked), and the same tool-call ids (t<attempt>.<turn>.<call>) so
 * the messages table is comparable across drivers. Because pi-agent-core
 * records isError only for THROWN tool errors, the execute wrapper converts
 * Kuhn's `{ content, isError }` failures to throws — exactly the behavior
 * the production app-side RuntimeTool.execute wrapper will implement.
 *
 * Query/run pairing mirrors the Claude bridge: fresh query → next model
 * script for the role; `resume` with the same prompt → retry (next attempt,
 * same session, same context); `resume` with a new prompt → follow-up (new
 * script, inherited session id and canonical continuation).
 */
import { Type, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { createContinuation } from '../../provider-runtime/continuation.js';
import { createFauxPiRuntime } from '../../provider-runtime/pi-spike.js';
import { renderedError } from './error-rendering.js';
import { z } from 'zod';

const ROLE_PATTERN = /You are running as the "(\w+)" agent/;

/** Kuhn tool failures the pi-agent-core loop can see as isError. */
class KuhnToolError extends Error {}

export function createPiBridge(scenario) {
  const bridge = {
    name: 'pi',
    kind: 'pi',
    observations: [], // one per runTurn call
    transcripts: [],  // one raw Pi normalized event stream per runTurn call
    _roleQueues: new Map(),
    _runs: new Map(), // sessionId -> run record
    _seq: 0,
  };
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
      abort: null, // set to the Pi turn's AbortController.abort
    };
    const gen = piQuery(bridge, args, mockState, ctl);
    gen.interrupt = () => {
      ctl.interrupted = true;
      ctl.abort?.();
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

async function* piQuery(bridge, args, mockState, ctl) {
  const options = args.options ?? {};
  const role = (options.systemPrompt?.match(ROLE_PATTERN) ?? [])[1] ?? null;
  if (!role) {
    throw new Error('pi driver: systemPrompt does not identify a Kuhn agent role');
  }
  const resume = options.resume ?? null;
  const usage = { inputTokens: 0, outputTokens: 0 };
  let terminalEmitted = false;
  let setupError = null;
  const observation = {
    role,
    sessionId: null,
    prompt: args.prompt,
    systemPrompt: options.systemPrompt ?? null,
    cwd: options.cwd ?? null,
    model: options.model ?? null,
    resume,
    attempt: null,
    allowedTools: [...(options.allowedTools ?? [])],
    builtinTools: [...(options.tools ?? [])],
    mcpToolNames: [],
    interrupted: false,
  };
  const transcript = [];
  bridge.observations.push(observation);
  bridge.transcripts.push(transcript);

  try {
    // ---- Pair this query with its run (same rules as the Claude bridge) ----
    let run;
    let isRetry = false;
    if (resume) {
      const candidate = bridge._runs.get(resume);
      if (candidate && candidate.prompt === args.prompt) {
        run = candidate;
        run.attemptIndex += 1;
        isRetry = true;
      } else if (candidate) {
        run = freshRun(bridge, role, resume, candidate.messages);
        run.prompt = args.prompt;
        bridge._runs.set(resume, run);
      } else {
        throw new Error(`pi driver: resume references unknown session ${resume}`);
      }
    } else {
      run = freshRun(bridge, role, null, null);
      run.prompt = args.prompt;
      bridge._runs.set(run.sessionId, run);
    }
    const sessionId = run.sessionId;
    observation.sessionId = sessionId;
    if (run.mcpIndex == null) {
      // runTask builds the MCP server immediately before its first query.
      run.mcpIndex = mockState.mcpServers.length - 1;
      if (run.mcpIndex < 0) throw new Error('pi driver: query before createSdkMcpServer');
    }
    const attempt = run.modelScript.attempts[run.attemptIndex];
    if (!attempt) {
      throw new Error(`pi driver: role ${role} ran out of scripted attempts (attempt ${run.attemptIndex})`);
    }
    observation.attempt = run.attemptIndex;
    const mcpTools = mockState.mcpServers[run.mcpIndex]?.tools ?? [];
    observation.mcpToolNames = mcpTools.map((t) => t.name);

    if (!isRetry) {
      run.messages.push({ role: 'user', content: [{ type: 'text', text: args.prompt }] });
    }
    const recordCancelled = () => {
      observation.interrupted = true;
    };

  // ---- Build the faux model script -----------------------------------------
  const responses = attempt.turns.map((turn, ti) => {
    if (turn.pauseUntilAbort) {
      // Park until the app's teardown interrupts the query. The agent's abort
      // signal resolves the parked response with an aborted message, so the
      // transcript ends in a cancelled terminal — the same semantics the
      // Claude driver implements with its `await ctl.signal`.
      return (_ctx, streamOptions) => new Promise((resolve) => {
        const finish = () => resolve(fauxAssistantMessage([], { stopReason: 'aborted' }));
        const signal = streamOptions?.signal;
        if (!signal || signal.aborted) { finish(); return; }
        signal.addEventListener('abort', finish, { once: true });
      });
    }
    const blocks = [];
    if (turn.text) blocks.push(fauxText(turn.text));
    for (const [ci, call] of (turn.toolCalls ?? []).entries()) {
      blocks.push(fauxToolCall(call.tool, call.args, { id: `t${run.attemptIndex}.${ti}.${ci}` }));
    }
    const hasCalls = (turn.toolCalls ?? []).length > 0;
    return fauxAssistantMessage(blocks.length > 0 ? blocks : fauxText(''), {
      stopReason: hasCalls ? 'toolUse' : 'stop',
    });
  });
  if (attempt.error) {
    const rendering = renderedError(attempt.error.code);
    responses.push(fauxAssistantMessage([], {
      stopReason: 'error',
      errorMessage: rendering.message,
    }));
  }

  // ---- Build Pi tools from the captured Kuhn MCP toolset --------------------
  const piTools = mcpTools.map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: zodToTypeBox(t.schema),
    execute: async (_toolCallId, callArgs) => {
      const parsed = toZodSchema(t.schema).safeParse(callArgs);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new KuhnToolError(`Invalid arguments for ${t.name}: ${message}`);
      }
      const result = await t.handler(parsed.data);
      if (result?.isError === true) {
        // pi-agent-core marks isError only for thrown errors; the production
        // app-side wrapper will behave the same way.
        throw new KuhnToolError(resultText(result));
      }
      return { content: contentBlocks(result) };
    },
  }));

  // ---- Run the turn through the phase-one Pi runtime ------------------------
  const { runtime } = createFauxPiRuntime({
    responses,
    tools: piTools,
    systemPrompt: options.systemPrompt ?? '',
    provider: 'pi-conformance',
    continuation: isRetry || (resume != null) ? makeContinuation(run.messages) : undefined,
  });
  const controller = new AbortController();
  ctl.abort = () => controller.abort();
  const turn = runtime.runTurn({ input: args.prompt, signal: controller.signal });

  // ---- Translate Pi events into the app's message stream -------------------
  // One scripted turn is one model call. The spike emits a 'text' event only
  // for turns that actually have text, so group by the scripted turn's shape
  // (text? calls?) rather than by text events — that also pins each flushed
  // assistant message to the turn's declared usage.
  const turnShapes = attempt.turns.map((t) => ({
    hasText: !!t.text,
    nCalls: (t.toolCalls ?? []).length,
  }));
  let shapeIndex = 0;
  let groupText = null;
  let groupCalls = [];
  let groupResults = [];

  const shapeComplete = () => {
    const shape = turnShapes[shapeIndex];
    if (!shape) return false;
    return groupResults.length === shape.nCalls
      && groupCalls.length === shape.nCalls
      && (!shape.hasText || groupText != null);
  };

  const flushGroup = function* () {
    if (groupText == null && groupCalls.length === 0) return;
    const turnUsage = attempt.turns[shapeIndex]?.usage ?? { input: 0, output: 0 };
    shapeIndex += 1;
    usage.inputTokens += turnUsage.input;
    usage.outputTokens += turnUsage.output;
    const content = [];
    if (groupText != null) content.push({ type: 'text', text: groupText });
    for (const call of groupCalls) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: `mcp__kuhn__${call.name}`,
        input: call.arguments,
      });
    }
    yield {
      type: 'assistant',
      message: {
        content,
        usage: { input_tokens: turnUsage.input, output_tokens: turnUsage.output },
      },
    };
    run.messages.push({
      role: 'assistant',
      content: [
        ...(groupText != null ? [{ type: 'text', text: groupText }] : []),
        ...groupCalls.map((c) => ({ type: 'tool_call', id: c.id, name: c.name, arguments: c.arguments })),
      ],
    });
    for (const r of groupResults) {
      const text = contentText(r.content);
      run.messages.push({
        role: 'tool_result',
        toolCallId: r.id,
        toolName: r.name,
        content: [{ type: 'text', text }],
        isError: r.isError === true,
      });
      yield {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: r.id,
            content: text,
            ...(r.isError ? { is_error: true } : {}),
          }],
        },
      };
    }
    groupText = null;
    groupCalls = [];
    groupResults = [];
  };

    for await (const ev of turn) {
      transcript.push(ev);
      switch (ev.type) {
        case 'provider':
          // The app keys its retry and job session on the init message.
          yield { type: 'system', subtype: 'init', session_id: sessionId };
          break;
        case 'text_delta':
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ev.content } } };
          break;
        case 'text':
          groupText = ev.content;
          if (shapeComplete()) yield* flushGroup();
          break;
        case 'tool_call':
          groupCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
          break;
        case 'tool_result':
          groupResults.push(ev);
          if (shapeComplete()) yield* flushGroup();
          break;
        case 'done': {
          yield* flushGroup();
          if (ctl.interrupted) {
            // The app's interrupt beat the terminal: the run ended cancelled,
            // not done — drop the terminal so the transcript stays contract-
            // shaped (exactly one terminal).
            transcript.pop();
            recordCancelled();
            return;
          }
          if (shapeIndex < turnShapes.length) {
            // Scripted turns remain (a trailing pauseUntilAbort park): the
            // app's view of this run is still in flight — the Claude
            // driver's stream is still open here, no result yet. Drop the
            // spike's done terminal and park until the app's teardown
            // interrupt lands (teardownOrDetach always calls
            // sdk.interrupt()); the finally records the single cancelled
            // terminal, exactly as the Claude driver does.
            transcript.pop();
            await ctl.signal;
            recordCancelled();
            return;
          }
          terminalEmitted = true;
          yield {
            type: 'result',
            subtype: 'success',
            session_id: sessionId,
            usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
          };
          return;
        }
        case 'error': {
          const code = ev.error?.code;
          if (code === 'cancelled') {
            // An interrupted run: the app owns the teardown (it called
            // interrupt); end quietly, exactly as the Claude driver does.
            // The raw event is already recorded in the transcript above.
            terminalEmitted = true;
            return;
          }
          // A provider failure: surface it to the app the way the SDK does —
          // throw, and let the app's production isTransientApiError() decide
          // whether the next scripted attempt is consumed.
          terminalEmitted = true;
          throw renderedError(code ?? 'provider_error');
        }
        default:
          break;
      }
    }
    // The spike always terminates with done|error; reaching here means the
    // stream ended without one — treat it as an interrupted run.
    recordCancelled();
  } catch (err) {
    // Provider-failure throws already set terminalEmitted (and their raw
    // error event is recorded in the transcript); a setup failure carries
    // nothing — capture the message so the finally records a real terminal.
    setupError = err;
    throw err;
  } finally {
    if (!terminalEmitted) {
      observation.interrupted = ctl.interrupted;
      transcript.push({
        type: 'error',
        error: {
          code: setupError ? 'driver_error' : 'cancelled',
          message: setupError ? setupError.message : 'interrupted',
          retryable: false,
          status: null,
        },
        usage: normalizeUsageShape(usage),
      });
    }
  }
}

function freshRun(bridge, role, resumeSession, priorMessages) {
  const queue = bridge._roleQueues.get(role);
  const modelScript = queue?.shift();
  if (!modelScript) {
    throw new Error(`pi driver: no scripted model left for role ${role} — scenario/tasks mismatch`);
  }
  return {
    role,
    modelScript,
    attemptIndex: 0,
    mcpIndex: null,
    sessionId: resumeSession ?? `pi-sess-${role}-${bridge._seq++}`,
    prompt: null,
    messages: priorMessages ? [...priorMessages] : [],
  };
}

/** Canonical continuation envelope over the run's cumulative context. */
function makeContinuation(messages) {
  return createContinuation(messages);
}

function normalizeUsageShape(usage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
}

/** The Kuhn handler's SDK result content as text (parity with the Claude
 * bridge's resultText). */
function resultText(result) {
  if (typeof result?.content === 'string') return result.content;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  if (blocks.length === 0) return JSON.stringify(result?.content ?? '');
  return blocks.map((b) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('\n');
}

/** Pi tool result content blocks (text only in phase one). */
function contentBlocks(result) {
  if (typeof result?.content === 'string') return [{ type: 'text', text: result.content }];
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const out = blocks
    .map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b && typeof b.text === 'string' ? { type: 'text', text: b.text } : null))
    .filter((b) => b != null);
  if (out.length === 0) out.push({ type: 'text', text: JSON.stringify(result?.content ?? '') });
  return out;
}

function contentText(blocks) {
  if (typeof blocks === 'string') return blocks;
  const list = Array.isArray(blocks) ? blocks : [];
  return list.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
}

/** The SDK's tool() takes a raw zod shape and wraps it in z.object()
 * internally; captured definitions keep the raw shape, so normalize before
 * translating ({ } = no parameters). */
function toZodSchema(schema) {
  if (schema && (typeof schema.safeParse === 'function' || schema._def)) return schema;
  return z.object(schema ?? {});
}

/** Convert the zod subset Kuhn tool schemas use into TypeBox (the schema
 * language pi-agent-core validates against). Kuhn schemas are plain
 * object/string/number/boolean/array/enum trees with .describe(),
 * .optional() and .default(). Defaults are applied by the zod safeParse in
 * the execute wrapper, so the TypeBox side only needs to accept the key as
 * optional. */
function zodToTypeBox(schema) {
  let node = toZodSchema(schema);
  let optional = false;
  for (;;) {
    if (node.constructor.name === 'ZodOptional') { optional = true; node = node._def.innerType; }
    else if (node.constructor.name === 'ZodDefault') { optional = true; node = node._def.innerType; }
    else break;
  }
  let tb;
  const inner = node._def;
  switch (node.constructor.name) {
    case 'ZodString':
      tb = Type.String();
      break;
    case 'ZodNumber':
      tb = Type.Number();
      break;
    case 'ZodBoolean':
      tb = Type.Boolean();
      break;
    case 'ZodEnum': {
      // v4 stores the values in _def.entries (a value->value object);
      // v3 used a _def.values array.
      const values = Array.isArray(inner.values)
        ? inner.values
        : Object.keys(inner.entries ?? {});
      tb = Type.Union(values.map((v) => Type.Literal(v)));
      break;
    }
    case 'ZodArray':
      // v4 stores the element in _def.element; v3 kept it in _def.type.
      tb = Type.Array(zodToTypeBox(inner.element ?? inner.type));
      break;
    case 'ZodObject': {
      // v3 exposes shape() as a function; v4 stores a plain object.
      const shapeObj = typeof inner.shape === 'function' ? inner.shape() : inner.shape;
      tb = Type.Object(Object.fromEntries(
        Object.entries(shapeObj).map(([k, v]) => [k, zodToTypeBox(v)]),
      ));
      break;
    }
    default:
      throw new Error(`pi driver: unsupported zod schema node ${node.constructor.name}`);
  }
  if (typeof node.description === 'string' && node.description) tb.description = node.description;
  if (optional) return Type.Optional(tb);
  return tb;
}
