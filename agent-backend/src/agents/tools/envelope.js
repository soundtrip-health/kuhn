/**
 * Normalized tool result/error envelope (STH-1).
 *
 * Every Kuhn tool executor returns this shape regardless of provider:
 *
 *   { content: Array<{ type: 'text', text }>, isError?: true, details?: unknown }
 *
 * `content` is model-facing text (the one block type the phase-one runtime
 * seam supports — see provider-runtime/continuation.js). `isError` marks a
 * failed tool call for the model and for the conversation audit trail
 * (issue #42); it never throws — a Kuhn tool failure is data for the model,
 * not an exception (provider-level failures are the AgentRuntime's
 * normalized `error` terminal instead). `details` carries structured,
 * non-model-facing context for callers that want it (e.g. canonical move
 * paths); adapters may ignore it.
 */

/**
 * @param {string} text
 * @param {{ isError?: boolean, details?: unknown }} [opts]
 * @returns {{ content: Array<{type: 'text', text: string}>, isError?: true, details?: unknown }}
 */
export function toolResult(text, { isError = false, details } = {}) {
  const result = { content: [{ type: 'text', text: String(text) }] };
  if (isError) result.isError = true;
  if (details !== undefined) result.details = details;
  return result;
}

/** Success envelope. */
export function toolOk(text, details) {
  return toolResult(text, { ...(details !== undefined ? { details } : {}) });
}

/** Failure envelope: the model sees `text` as a tool error. */
export function toolError(text, details) {
  return toolResult(text, { isError: true, ...(details !== undefined ? { details } : {}) });
}
