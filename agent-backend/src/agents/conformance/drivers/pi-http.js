/**
 * OpenAI-compatible HTTP conformance driver (issue #112).
 *
 * The same shape as the Pi driver (drivers/pi.js) — kind 'pi', observations
 * per runtime turn, transcripts of normalized events — but the runtime
 * behind the app is the REAL OpenAI-compatible Pi runtime
 * (createOpenAICompatiblePiRuntime) talking over REAL HTTP to the scripted
 * chat-completions server (fake-openai-server.js). Nothing between the
 * product seam and the socket is faked: pi-ai's `openai` client, streaming
 * parse, tool-call assembly, usage accounting, abort propagation, and error
 * surfacing all run as they would against a vLLM / Ollama / LiteLLM
 * deployment. Only the model's decisions are scripted, by the scenario.
 *
 * Each task's scripted model is registered on the server under a unique
 * model id; the runtime built for that task requests exactly that id, so
 * the server needs no prompt parsing to find the script.
 */
import { config } from '../../../config.js';
import { createFakeOpenAIServer } from '../fake-openai-server.js';

export const PI_HTTP_PROVIDER = 'pi-conformance-http';
const ROLE_PATTERN = /You are running as the "(\w+)" agent/;

let server = null;
let realCompatibleConstructor = null;
let taskCounter = 0;

/**
 * The test file hands over the real constructor (its vi.mock of pi-adapter
 * replaces the export the production factory sees) and starts the server.
 */
export async function startPiHttpDriver({ createOpenAICompatiblePiRuntime }) {
  realCompatibleConstructor = createOpenAICompatiblePiRuntime;
  server = createFakeOpenAIServer();
  await server.listen();
  return server;
}

export async function stopPiHttpDriver() {
  await server?.close();
  server = null;
  realCompatibleConstructor = null;
}

/** The server's observed requests (for wire-level assertions). */
export function piHttpRequests() {
  return server?.requests ?? [];
}

export function createPiHttpDriver(scenario) {
  if (!server || !realCompatibleConstructor) {
    throw new Error('pi-http driver: startPiHttpDriver() must run before the suite');
  }
  server.reset();
  const driver = {
    name: 'pi-openai-compatible-http',
    kind: 'pi',
    observations: [],
    transcripts: [],
    _roleQueues: new Map(),
    buildRuntime: (options) => buildRuntime(driver, options),
  };
  for (const task of scenario.tasks) {
    const queue = driver._roleQueues.get(task.role) ?? [];
    queue.push(task.model);
    driver._roleQueues.set(task.role, queue);
  }
  // The deployment default in 'pi' mode is the preview profile; pointing it
  // at the fake server makes the production factory build the compatible
  // runtime — whose (mocked) constructor hands the options to this driver.
  config.agentRuntime = {
    kind: 'pi',
    pi: { provider: 'openai-compatible', model: 'kuhn-conformance', baseUrl: server.url, apiKeyEnv: '' },
    allowPrivateEndpoints: true,
  };
  return driver;
}

function buildRuntime(driver, options) {
  const state = { inner: null, role: null, attempt: 0, modelId: null };
  const runtime = {
    get identity() {
      if (state.inner) return state.inner.identity;
      return { provider: PI_HTTP_PROVIDER, model: 'kuhn-conformance', api: 'openai-completions', endpoint: server.url };
    },
    cancel: () => { if (state.inner) state.inner.cancel(); },
    runTurn: (turn) => {
      ensureInner(driver, state, options, turn);
      const observation = {
        role: state.role,
        sessionId: null,
        prompt: turn.input,
        systemPrompt: turn.systemPrompt ?? null,
        cwd: null,
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

function ensureInner(driver, state, options, turn) {
  if (state.inner) return;
  const role = (turn?.systemPrompt?.match(ROLE_PATTERN) ?? [])[1] ?? null;
  if (!role) throw new Error('pi-http driver: systemPrompt does not identify a Kuhn agent role');
  state.role = role;
  const modelScript = driver._roleQueues.get(role)?.shift();
  if (!modelScript) {
    throw new Error(`pi-http driver: no scripted model left for role ${role} — scenario/tasks mismatch`);
  }
  taskCounter += 1;
  state.modelId = `kuhn-conformance-${taskCounter}`;
  server.register(state.modelId, buildResponses(modelScript));
  state.inner = realCompatibleConstructor({
    baseUrl: server.url,
    providerId: PI_HTTP_PROVIDER,
    modelId: state.modelId,
    apiKey: 'conformance-test-key',
    tools: options.tools ?? [],
    systemPrompt: turn.systemPrompt ?? '',
    maxTurns: options.maxTurns ?? null,
    contextWindow: 128_000,
  }).runtime;
}

/** The scenario's scripted model, flattened across attempts, as server entries. */
export function buildResponses(script) {
  const responses = [];
  for (const [ai, attempt] of (script.attempts ?? []).entries()) {
    for (const [ti, turn] of (attempt.turns ?? []).entries()) {
      if (turn.pauseUntilAbort) {
        responses.push({ kind: 'pause' });
        continue;
      }
      const deltas = turn.deltas ?? (turn.text ? [turn.text] : []);
      responses.push({
        kind: 'message',
        deltas,
        toolCalls: (turn.toolCalls ?? []).map((call, ci) => ({ id: `t${ai}.${ti}.${ci}`, name: call.tool, args: call.args ?? {} })),
        usage: turn.usage ?? { input: 0, output: 0 },
      });
    }
    if (attempt.error) responses.push({ kind: 'error', code: attempt.error.code });
  }
  return responses;
}
