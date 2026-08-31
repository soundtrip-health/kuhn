/**
 * vi.mock factory target for '@anthropic-ai/claude-agent-sdk'.
 *
 * The production runtime.js imports { query, tool, createSdkMcpServer } from
 * the SDK; this module replaces them with a bridge registry. The active
 * conformance driver (installed by the test file via installBridge) supplies
 * query(); the rest is faithful plumbing:
 *
 * - tool() returns the Kuhn tool definition untouched, so drivers can see the
 *   name, description, zod schema and handler exactly as buildMcpTools made
 *   them;
 * - createSdkMcpServer() records every server the app builds; drivers pair a
 *   server with the query that follows it (LIFO: runTask builds the server,
 *   then immediately starts the query, and a child run's server/query pair
 *   nests inside the parent's);
 * - query() hands the app's { prompt, options } to the active driver, which
 *   returns an async iterable carrying an interrupt() method, exactly the
 *   surface the production runtime consumes.
 *
 * Drivers own all provider specifics (message shapes, tool-name translation,
 * error classification). Scenarios and assertions never see this module.
 */
export const sdkMockState = {
  bridge: null,
  mcpServers: [], // captured createSdkMcpServer configs, in build order
};

export function installBridge(bridge) {
  sdkMockState.bridge = bridge;
}

export function resetBridge() {
  sdkMockState.bridge = null;
  sdkMockState.mcpServers.length = 0;
}

export function query(args) {
  if (!sdkMockState.bridge) {
    throw new Error('conformance: sdkQuery called before a driver was installed');
  }
  return sdkMockState.bridge.query(args, sdkMockState);
}

export function tool(name, description, schema, handler) {
  return { name, description, schema, handler };
}

export function createSdkMcpServer(cfg) {
  sdkMockState.mcpServers.push(cfg);
  return { type: 'sdk', name: cfg.name };
}
