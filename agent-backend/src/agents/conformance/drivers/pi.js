/**
 * Pi conformance driver (STH-5, STH-47).
 *
 * Plays scripted model turns through the production runAgentTask() on the
 * production Pi AgentRuntime (provider-runtime/pi-adapter.js) with a
 * deterministic faux model (@earendil-works/pi-ai).
 *
 * This driver no longer translates Pi events into a Claude-SDK-shaped
 * message stream: the app post-#94 consumes the normalized provider-runtime
 * contract from whichever AgentRuntime the production factory
 * (provider-runtime/factory.js) builds. The driver's only role is to
 * script the MODEL behind the real adapter. It does that by installing
 * itself as the replacement for the Pi provider constructors (see
 * mock-pi-adapter.js + the vi.mock in conformance.test.js): the factory
 * runs exactly the way a 'pi' deployment would; every PiAgentRuntime the
 * factory returns is the driver's faux runtime.
 *
 * What is REAL here: the PiAgentRuntime (tool loop, event normalization,
 * canonical continuation, cancellation, max-turn cutoff, neutral argument
 * validation), all Kuhn tool handlers, and the app's retry/budget/teardown
 * logic. What is SCRIPTED: the faux model — which tools it calls, what it
 * says, its declared per-turn usage, and when the provider fails.
 *
 * This file is the ONLY place in the harness that knows Pi specifics
 * (faux model construction, the faux provider id, the per-runTurn identity
 * it reports). Scenarios and assertions speak Kuhn tool slugs and domain
 * events only.
 *
 * Pi has no provider-side sessions: observation.sessionId and resume are
 * always null, and cross-task continuity flows through the canonical
 * continuation the harness threads between follow-up tasks (the done
 * event's continuation) — the same mechanism the production rollback path
 * uses.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { config } from '../../../config.js';
import { createFauxPiRuntime } from '../../provider-runtime/pi-adapter.js';
import { renderedError } from './error-rendering.js';

const ROLE_PATTERN = /You are running as the "(\w+)" agent/;

/** The faux provider id the conformance Pi runtimes report. */
export const PI_CONFORMANCE_PROVIDER = 'pi-conformance';

export function createPiDriver(scenario) {
  const driver = {
    name: 'pi-adapter',
    kind: 'pi',
    observations: [],
    transcripts: [],
    _roleQueues: new Map(),
    buildRuntime: (options) => buildRuntime(driver, options),
  };
  // Per-role FIFO of model scripts, in scenario task order (the same
  // pairing rule the Claude driver uses: a dispatched child consumes its
  // own role's queue when its nested runtime is built).
  for (const task of scenario.tasks) {
    const queue = driver._roleQueues.get(task.role) ?? [];
    queue.push(task.model);
    driver._roleQueues.set(task.role, queue);
  }
  // Point the production factory at this driver: the conformance config's
  // 'pi' selection routes every agent task through createOpenRouterPiRuntime,
  // which conformance.test.js mocks to installPiFactory (mock-pi-adapter.js).
  config.agentRuntime = {
    kind: 'pi',
    pi: { provider: 'openrouter', model: 'kuhn-conformance', baseUrl: '', apiKeyEnv: '' },
  };
  return driver;
}

/**
 * Build the per-task runtime wrapper the production factory returns.
 *
 * @param {object} driver the active driver
 * @param {object} options the factory's product-side options
 *   ({ model, projectDir, tools, maxTurns, initialSessionId, systemPrompt? })
 * @returns {{ runtime: object }} the same envelope the real Pi provider
 *   constructors return (the factory consumes `.runtime`)
 */
function buildRuntime(driver, options) {
  const state = { inner: null, role: null, attempt: 0 };
  const runtime = {
    get identity() {
      ensureInner(driver, state, options, null);
      return state.inner.identity;
    },
    cancel: () => {
      if (state.inner) state.inner.cancel();
    },
    runTurn: (turn) => {
      ensureInner(driver, state, options, turn);
      const observation = {
        role: state.role,
        sessionId: null, // Pi has no provider-side sessions
        prompt: turn.input,
        systemPrompt: turn.systemPrompt ?? null,
        cwd: null, // Pi runs in-process; Kuhn's storage service scopes paths
        model: state.inner.identity.model,
        resume: turn.resume ?? null,
        continuation: turn.continuation != null,
        attempt: state.attempt,
        allowedTools: [],
        builtinTools: [],
        mcpToolNames: (options.tools ?? []).map((t) => t.name),
        interrupted: false,
      };
      state.attempt += 1;
      driver.observations.push(observation);
      const transcript = [];
      driver.transcripts.push(transcript);
      const inner = state.inner.runTurn(turn);
      return (async function* () {
        for await (const event of inner) {
          transcript.push(event);
          // The provider-side interruption is the cancelled terminal; the
          // app's own interruption (budget cutoff / consumer disconnect —
          // the product's controller signal is the turn signal) is visible
          // as soon as it fires, even if the adapter's terminal raced the
          // abort and is a done.
          if ((event.type === 'error' && event.error?.code === 'cancelled') || turn.signal?.aborted) {
            observation.interrupted = true;
          }
          yield event;
        }
      })();
    },
  };
  return { runtime };
}

/** Lazily build the faux PiAgentRuntime on the first turn (the role is
 * known from the turn's system prompt, which the product passes per turn). */
function ensureInner(driver, state, options, turn) {
  if (state.inner) return;
  const role = (turn?.systemPrompt?.match(ROLE_PATTERN) ?? [])[1] ?? null;
  if (!role) {
    throw new Error('pi driver: systemPrompt does not identify a Kuhn agent role');
  }
  state.role = role;
  const queue = driver._roleQueues.get(role);
  const modelScript = queue?.shift();
  if (!modelScript) {
    throw new Error(`pi driver: no scripted model left for role ${role} — scenario/tasks mismatch`);
  }
  const { responses, declaredUsage } = buildResponses(modelScript);
  const built = createFauxPiRuntime({
    responses,
    declaredUsage,
    tools: options.tools ?? [],
    systemPrompt: turn.systemPrompt ?? '',
    maxTurns: options.maxTurns ?? null,
    provider: PI_CONFORMANCE_PROVIDER,
    modelId: 'faux-1',
    thinkingLevel: 'off',
  });
  state.inner = built.runtime;
}

/**
 * Translate a scenario's scripted model (`task.model`) into the faux
 * provider's response queue, flattened across attempts:
 *
 * - each turn is one model response (text block + toolCall blocks); a turn
 *   with tool calls stops with 'toolUse', a final turn with 'stop';
 * - `pauseUntilAbort` turns park until the request's abort signal fires
 *   (the cancellation scenario);
 * - `attempt.error` appends a provider-failure response rendered the way
 *   this provider would surface it (error-rendering.js); the real adapter's
 *   normalizeProviderError() re-classifies it — the production path.
 *
 * `declaredUsage` mirrors the turn order: the faux provider estimates usage
 * from content, but the scenarios declare exact tokens (parity with the
 * Claude driver's scripted usage); a declared slot replaces the final
 * message's usage so the app's budget logic sees the declared numbers.
 */
function buildResponses(script) {
  const responses = [];
  const declaredUsage = [];
  for (const [ai, attempt] of (script.attempts ?? []).entries()) {
    for (const [ti, turn] of (attempt.turns ?? []).entries()) {
      if (turn.pauseUntilAbort) {
        responses.push((_context, options) => new Promise((resolve) => {
          const parked = fauxAssistantMessage('');
          const finish = () => resolve(parked);
          const signal = options?.signal;
          if (!signal || signal.aborted) {
            finish();
            return;
          }
          signal.addEventListener('abort', finish, { once: true });
        }));
        declaredUsage.push(null);
        continue;
      }
      const blocks = [];
      if (turn.text) blocks.push(fauxText(turn.text));
      (turn.toolCalls ?? []).forEach((call, ci) => {
        blocks.push(fauxToolCall(call.tool, call.args ?? {}, { id: `t${ai}.${ti}.${ci}` }));
      });
      const hasCalls = (turn.toolCalls?.length ?? 0) > 0;
      responses.push(fauxAssistantMessage(blocks.length > 0 ? blocks : [fauxText('')], {
        stopReason: hasCalls ? 'toolUse' : 'stop',
      }));
      const usage = turn.usage ?? { input: 0, output: 0 };
      declaredUsage.push({ input: usage.input, output: usage.output });
    }
    if (attempt.error) {
      responses.push(fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: renderedError(attempt.error.code).message,
      }));
      declaredUsage.push(null);
    }
  }
  return { responses, declaredUsage };
}
