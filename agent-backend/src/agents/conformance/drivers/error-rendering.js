/**
 * Provider-native rendering of normalized error codes (STH-5).
 *
 * Shared by the Claude and Pi conformance drivers: a scripted provider
 * failure is declared by the scenario with the normalized contract code
 * (provider-runtime/contract.js), and each driver renders it as the
 * provider-native failure its app surface expects. The renderings are chosen
 * so the production isTransientApiError() classifies them the way the code
 * intends — the app's retry policy is the production implementation in both
 * cases.
 */
const ERROR_RENDERINGS = {
  overloaded: { message: 'API Error: 529 Overloaded', status: 529 },
  rate_limit: { message: 'API Error: 429 rate limit', status: 429 },
  server: { message: 'API Error: 500 Internal Server Error', status: 500 },
  network: { message: 'read ECONNRESET', status: null },
  timeout: { message: 'Request timed out', status: 408 },
  context_overflow: { message: 'prompt is too long; the context window was exceeded', status: null },
  provider_error: { message: 'provider error: the model did not respond', status: null },
  cancelled: { message: 'This operation was aborted', status: null },
};

/** The error object the production isTransientApiError() will classify. */
export function renderedError(code) {
  const rendering = ERROR_RENDERINGS[code] ?? ERROR_RENDERINGS.provider_error;
  const err = new Error(rendering.message);
  if (rendering.status != null) err.status = rendering.status;
  if (code === 'cancelled') err.name = 'AbortError';
  return err;
}
