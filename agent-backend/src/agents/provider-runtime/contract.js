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
 * @property {'rate_limit'|'overloaded'|'server'|'network'|'timeout'|'cancelled'|'context_overflow'|'provider_error'} code
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
 * @typedef {object} RuntimeTurn
 * @property {string} input
 * @property {AbortSignal} [signal]
 * @property {{version: 1, messages: Array<object>}} [continuation]
 *
 * @typedef {object} AgentRuntime
 * @property {(turn: RuntimeTurn) => AsyncIterable<object>} runTurn
 */

export const TERMINAL_RUNTIME_EVENTS = new Set(['done', 'error']);

/**
 * Normalize incomplete provider usage without inventing zeros. A provider that
 * omits cache fields is observably different from one that reports zero cache
 * tokens, which matters for later accounting work.
 */
export function normalizeUsage(usage = {}) {
  const inputTokens = finiteOrNull(usage.inputTokens ?? usage.input);
  const outputTokens = finiteOrNull(usage.outputTokens ?? usage.output);
  const cacheReadTokens = finiteOrNull(usage.cacheReadTokens ?? usage.cacheRead);
  const cacheWriteTokens = finiteOrNull(usage.cacheWriteTokens ?? usage.cacheWrite);
  const reportedTotal = finiteOrNull(usage.totalTokens);
  const knownTotal = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]
    .filter((value) => value != null)
    .reduce((sum, value) => sum + value, 0);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: reportedTotal ?? (knownTotal > 0 ? knownTotal : null),
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

/** Normalize provider-specific failures before product retry policy sees them. */
export function normalizeProviderError(error, { stopReason } = {}) {
  const message = String(error?.message ?? error?.errorMessage ?? error ?? 'Provider error');
  const status = finiteOrNull(error?.status ?? error?.statusCode ?? error?.response?.status);
  const code = String(error?.code ?? '').toLowerCase();
  const haystack = `${code} ${message}`.toLowerCase();

  if (stopReason === 'aborted' || error?.name === 'AbortError' || /\babort(?:ed)?\b|\bcancel(?:led|ed)?\b/.test(haystack)) {
    return runtimeError('cancelled', message, false, status);
  }
  if (status === 429 || /rate.?limit|too many requests/.test(haystack)) {
    return runtimeError('rate_limit', message, true, status);
  }
  if (status === 529 || /overload|capacity/.test(haystack)) {
    return runtimeError('overloaded', message, true, status);
  }
  if (/context.{0,20}(length|window|overflow)|too many tokens|max(?:imum)? context/.test(haystack)) {
    return runtimeError('context_overflow', message, false, status);
  }
  if (status === 408 || /\btimeout\b|timed out/.test(haystack)) {
    return runtimeError('timeout', message, true, status);
  }
  if (/econn|enotfound|network|socket|fetch failed/.test(haystack)) {
    return runtimeError('network', message, true, status);
  }
  if (status != null && status >= 500) {
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

  if (pendingDeltas) violations.push('text deltas must conclude with a final text event');
  for (const [id, call] of toolCalls) {
    if (!call.resulted) violations.push(`tool_call ${id} has no tool_result`);
  }

  if (terminalIndexes.length !== 1) violations.push('runtime must emit exactly one terminal done or error event');
  if (terminalIndexes.length === 1 && terminalIndexes[0] !== events.length - 1) {
    violations.push('terminal event must be last');
  }

  const terminal = events.at(-1);
  if (terminal?.type === 'done') {
    if (!terminal.continuation || terminal.continuation.version !== 1 || !Array.isArray(terminal.continuation.messages)) {
      violations.push('done must include portable continuation messages');
    }
    const usage = normalizeUsage(terminal.usage);
    if (Object.values(usage).some((value) => value !== null && !Number.isFinite(value))) {
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
