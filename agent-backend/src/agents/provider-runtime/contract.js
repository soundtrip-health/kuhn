/**
 * Experimental provider-runtime contract (PLA-222/223).
 *
 * This file deliberately contains no Pi or Claude imports. It describes the
 * model-execution seam below runAgentTask(); Kuhn's jobs, authorization,
 * storage, suggestions, questions, budgets, and UI events stay above it.
 *
 * @typedef {object} RuntimeUsage
 * @property {number|null} inputTokens
 * @property {number|null} outputTokens
 * @property {number|null} cacheReadTokens
 * @property {number|null} cacheWriteTokens
 * @property {number|null} totalTokens
 *
 * @typedef {object} RuntimeIdentity
 * @property {string} provider
 * @property {string} model
 * @property {string} [api]
 * @property {string} [endpoint]
 *
 * @typedef {object} RuntimeError
 * @property {string} code
 *   - Normalized PROVIDER FAILURES (the PROVIDER_ERROR_CODES vocabulary):
 *     'auth', 'invalid_request', 'rate_limit', 'overloaded', 'server',
 *     'network', 'timeout', 'context_overflow', 'safety', 'tool',
 *     'cancelled', 'provider_error' — an upstream failure surfaced while
 *     the turn was in flight; `retryable` marks the transient ones.
 *   - TURN TERMINATIONS: the provider finished the turn and reported why
 *     (e.g. 'max_turns', 'during_execution' from Claude result subtypes) —
 *     never retryable, outside the PROVIDER_ERROR_CODES set.
 * @property {string} message
 * @property {boolean} retryable
 * @property {number|null} status
 *
 * @typedef {object} RuntimeTool
 * @property {string} name
 * @property {string} description
 * @property {object} parameters JSON Schema supplied by Kuhn
 * @property {(toolCallId: string, args: object, signal?: AbortSignal) => Promise<{content: Array<object>, details?: unknown}>} execute
 *
 * Kuhn's tool registry (agents/tools/) supplies RuntimeTool instances with
 * these additional provider-neutral metadata fields:
 *
 *   - grants:   the DB tool slugs (agent_tools assignments) that expose the
 *     tool; one broad grant may expose several generated variants;
 *   - readOnly: true when the tool has no product-side effects;
 *   - effect:   'read' | 'write' | 'external-read' | 'external' | 'control';
 *   - kind:     'kuhn' (an execute callback) or 'provider_builtin'
 *     (execute is null — the provider must supply the capability natively,
 *     e.g. Claude's WebSearch/WebFetch behind the web_search grant; adapters
 *     that cannot supply it must omit the tool);
 *   - visible:  optional (ctx) => boolean predicate (e.g. dispatch_agent is
 *     withheld at the max dispatch depth).
 *
 * Tool event semantics: `tool_call` records that the model requested a tool
 * with particular arguments — an attempted call, before Kuhn's schema
 * validation. The validation/execution outcome is always the matching
 * `tool_result`; invalid arguments produce `tool_result.isError === true` and
 * the Kuhn `execute` implementation is never invoked for them.
 *
 * Event vocabulary: `provider` (identity — provider/model/api, plus
 * `sessionId` once the provider has allocated a session), `text_delta`,
 * `text`, `tool_call`, `tool_result`, per-turn `usage` (canonical
 * RuntimeUsage), and exactly one terminal event: `done` (cumulative
 * `usage` + canonical `continuation`) or `error` (normalized `error`, plus
 * the cumulative `usage` and the partial canonical `continuation` when the
 * transcript exists, so a retried attempt keeps the record complete).
 *
 * Continuation is the canonical Kuhn schema defined in continuation.js —
 * never raw provider or framework messages.
 *
 * @typedef {object} RuntimeTurn
 * @property {string} input
 * @property {AbortSignal} [signal]
 * @property {{version: 1, messages: Array<object>}} [continuation] canonical Kuhn continuation (continuation.js)
 * @property {string} [systemPrompt] - Kuhn's server-built system prompt; the
 *   adapter owns how the provider receives it
 * @property {string|null} [resume] - opaque provider-native resume token
 *   (e.g. a Claude session id). Diagnostics/optimization only — the
 *   canonical continuation is the correctness-critical state.
 *
 * @typedef {object} AgentRuntime
 * @property {(turn: RuntimeTurn) => AsyncIterable<object>} runTurn
 * @property {() => void} [cancel] - interrupt the in-flight turn (teardown,
 *   budget cutoff); the adapter still yields its one terminal `error`
 *   (code 'cancelled') for the in-flight stream
 */

import { validateContinuation } from './continuation.js';

export const TERMINAL_RUNTIME_EVENTS = new Set(['done', 'error']);

/** Raw usage fields (canonical names plus adapter aliases) read by normalizeUsage(). */
const USAGE_FIELDS = [
  'inputTokens', 'input',
  'outputTokens', 'output',
  'cacheReadTokens', 'cacheRead',
  'cacheWriteTokens', 'cacheWrite',
  'totalTokens',
];

/**
 * Normalize incomplete provider usage without inventing zeros. A provider that
 * omits cache fields is observably different from one that reports zero cache
 * tokens, which matters for later accounting work.
 *
 * The four component fields are defined as disjoint: `inputTokens` counts
 * non-cached input, and the cache fields count cached input separately, so a
 * derived total is the plain sum of known components. Adapters own that
 * invariant — a provider that reports cached tokens as a subset of its input
 * count (OpenAI-style `cached_tokens`) must be converted to disjoint fields
 * before reaching this contract, which Pi's model layer already does. A
 * provider-reported total always wins over derivation; cost/dollar
 * reconciliation stays out of scope until PLA-233.
 */
export function normalizeUsage(usage) {
  const value = usage ?? {};
  const inputTokens = finiteOrNull(value.inputTokens ?? value.input);
  const outputTokens = finiteOrNull(value.outputTokens ?? value.output);
  const cacheReadTokens = finiteOrNull(value.cacheReadTokens ?? value.cacheRead);
  const cacheWriteTokens = finiteOrNull(value.cacheWriteTokens ?? value.cacheWrite);
  const reportedTotal = finiteOrNull(value.totalTokens);
  const knownComponents = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]
    .filter((value) => value != null);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // An explicitly reported zero component must yield totalTokens 0, not
    // null: null is reserved for "nothing was reported at all".
    totalTokens: reportedTotal ?? (knownComponents.length > 0
      ? knownComponents.reduce((sum, value) => sum + value, 0)
      : null),
  };
}

export function addUsage(left, right) {
  const a = normalizeUsage(left);
  const b = normalizeUsage(right);
  return {
    inputTokens: addKnown(a.inputTokens, b.inputTokens),
    outputTokens: addKnown(a.outputTokens, b.outputTokens),
    cacheReadTokens: addKnown(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: addKnown(a.cacheWriteTokens, b.cacheWriteTokens),
    totalTokens: addKnown(a.totalTokens, b.totalTokens),
  };
}

 /**
  * The normalized provider-failure vocabulary: codes normalizeProviderError()
  * can return for an upstream failure, as opposed to a provider-reported
  * turn termination (max_turns, …). The product layer (agents/runtime.js)
  * uses this set to shape terminal errors — the story-029 friendly
  * overload message and `reason: 'provider_overloaded'` tag apply only to
  * codes in this set, rendered from the provider message.
  */
 export const PROVIDER_ERROR_CODES = new Set([
   'auth', 'invalid_request', 'rate_limit', 'overloaded', 'server', 'network',
   'timeout', 'context_overflow', 'safety', 'tool', 'cancelled', 'provider_error',
 ]);

 /**
  * Normalize provider-specific failures before product retry policy sees
  * them. The retryable set preserves story 029's historical behavior
  * (408/409/425/429/5xx/529 statuses, ETIMEDOUT/ECONNRESET/ECONNREFUSED/
  * ENOTFOUND/EAI_AGAIN/socket wording, and "overloaded"/"rate limit"
  * wording) — a retry here is safe because these failures are upstream and
  * stateless.
  */
 export function normalizeProviderError(error, { stopReason } = {}) {
   const message = String(error?.message ?? error?.errorMessage ?? error ?? 'Provider error');
   const status = finiteOrNull(error?.status ?? error?.statusCode ?? error?.response?.status);
   const code = String(error?.code ?? '').toLowerCase();
   const haystack = `${code} ${message}`.toLowerCase();

   // Cancellation is classified only on strong signals (explicit abort types
   // and stop reasons), never on message wording: provider messages routinely
   // contain "cancelled"/"aborted" while describing rate limits or dropped
   // connections, and those must keep their retryable categories.
   if (stopReason === 'aborted' || error?.name === 'AbortError' || code === 'abort_err') {
     return runtimeError('cancelled', message, false, status);
   }
   if (status === 429 || /rate.?limit|too many requests/.test(haystack)) {
     return runtimeError('rate_limit', message, true, status);
   }
   if (status === 529 || /overload|capacity/.test(haystack)) {
     return runtimeError('overloaded', message, true, status);
   }
   // Content-safety refusals (a "content policy" 400, a safety block): not a
   // provider outage and not retryable — the model declined the turn.
   if (/content.?policy|safety|self.?block/.test(haystack)) {
     return runtimeError('safety', message, false, status);
   }
   if (status === 401 || status === 403
     || /unauthorized|forbidden|invalid api key|authentication|credential/.test(haystack)) {
     return runtimeError('auth', message, false, status);
   }
   if (status === 400 || /invalid (request|parameter|input)|malformed|unrecognized/.test(haystack)) {
     return runtimeError('invalid_request', message, false, status);
   }
   if (/context.{0,20}(length|window|overflow)|too many tokens|max(?:imum)? context/.test(haystack)) {
     return runtimeError('context_overflow', message, false, status);
   }
   if (status === 408 || /\btimeout\b|timed out|etimedout/.test(haystack)) {
     return runtimeError('timeout', message, true, status);
   }
   if (/econn|enotfound|network|socket|fetch failed|eai_again/.test(haystack)) {
     return runtimeError('network', message, true, status);
   }
   // 409 Conflict / 425 Too Early: historically in Kuhn's retryable set
   // (story 029) — treat them as upstream transients.
   if (status === 409 || status === 425 || (status != null && status >= 500)) {
     return runtimeError('server', message, true, status);
   }
   return runtimeError('provider_error', message, false, status);
 }

/**
 * Structural conformance check used by every experimental adapter. It returns
 * violations instead of throwing so tests can prove an incomplete adapter is
 * rejected without intentionally failing the suite itself.
 */
export function validateRuntimeEventSequence(events) {
  const violations = [];
  const terminalIndexes = [];
  const toolCalls = new Map();
  let identitySeen = false;
  let pendingDeltas = '';

  if (!Array.isArray(events) || events.length === 0) return ['runtime emitted no events'];

  events.forEach((event, index) => {
    if (!event || typeof event.type !== 'string') {
      violations.push(`event ${index} has no type`);
      return;
    }
    if (event.type === 'provider') {
      identitySeen = Boolean(event.provider && event.model);
      if (!identitySeen) violations.push('provider event must identify provider and model');
    } else if (!identitySeen) {
      violations.push(`${event.type} was emitted before provider identity`);
    }

    if (event.type === 'text_delta') pendingDeltas += event.content ?? '';
    if (event.type === 'text') {
      if (pendingDeltas && event.content !== pendingDeltas) {
        violations.push('final text does not equal the ordered text deltas for its turn');
      }
      pendingDeltas = '';
    }
    if (event.type === 'tool_call') {
      if (!event.id || !event.name) violations.push('tool_call must include id and name');
      else if (toolCalls.has(event.id)) violations.push(`tool_call ${event.id} is duplicated`);
      else toolCalls.set(event.id, { name: event.name, resulted: false });
    }
    if (event.type === 'tool_result') {
      const call = toolCalls.get(event.id);
      if (!call) violations.push(`tool_result ${event.id ?? '<missing>'} has no preceding tool_call`);
      else {
        if (call.resulted) violations.push(`tool_result ${event.id} is duplicated`);
        if (event.name !== call.name) violations.push(`tool_result ${event.id} does not match tool ${call.name}`);
        call.resulted = true;
      }
      if (typeof event.isError !== 'boolean') violations.push('tool_result must include isError');
    }
    if (TERMINAL_RUNTIME_EVENTS.has(event.type)) terminalIndexes.push(index);
  });

  // Delta closure is only required of a completed turn: an error terminal may
  // legally interrupt an open delta run (mid-stream provider failure).
  if (pendingDeltas && events.at(-1)?.type === 'done') {
    violations.push('text deltas must conclude with a final text event');
  }
  for (const [id, call] of toolCalls) {
    if (!call.resulted) violations.push(`tool_call ${id} has no tool_result`);
  }

  if (terminalIndexes.length !== 1) violations.push('runtime must emit exactly one terminal done or error event');
  if (terminalIndexes.length === 1 && terminalIndexes[0] !== events.length - 1) {
    violations.push('terminal event must be last');
  }

  const terminal = events.at(-1);
  if (terminal?.type === 'done') {
    if (!terminal.continuation) {
      violations.push('done must include canonical continuation messages');
    } else {
      for (const defect of validateContinuation(terminal.continuation)) {
        violations.push(`done continuation is not canonical: ${defect}`);
      }
    }
    // Validate the raw usage fields, not normalizeUsage() output: the
    // normalizer coerces garbage to null, which would make this unreachable.
    const rawUsage = terminal.usage ?? {};
    const rawUsageValues = USAGE_FIELDS.map((field) => rawUsage[field]);
    if (rawUsageValues.some((value) => value !== undefined && value !== null && !Number.isFinite(value))) {
      violations.push('done usage fields must be finite numbers or null');
    }
  }
  if (terminal?.type === 'error') {
    if (!terminal.error?.code || typeof terminal.error?.retryable !== 'boolean') {
      violations.push('error must include a normalized code and retryable flag');
    }
  }

  return [...new Set(violations)];
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function addKnown(a, b) {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function runtimeError(code, message, retryable, status) {
  return { code, message, retryable, status };
}
