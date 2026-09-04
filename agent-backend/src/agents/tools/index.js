/**
 * Neutral Kuhn tool registry — public API (STH-1).
 *
 * Provider-neutral: nothing in this directory imports Claude or Pi. The
 * model-callable surface of the agents, described once and projected into
 * provider form by the runtime adapters:
 *
 *   createToolContext(...)  server-derived execution context
 *   listTools(ctx)          the role/mode-filtered tool descriptors
 *   findTool(ctx, name)     one descriptor by name
 *   validateArgs(schema, args)  neutral argument validation (JSON Schema subset)
 *   toolOk / toolError      the normalized result/error envelope
 *
 * The Claude tool adapter (../provider-runtime/claude-tools.js) and the
 * Claude AgentRuntime adapter (../provider-runtime/claude-runtime.js) are
 * the only production modules allowed to import the Claude SDK.
 */

export { createToolContext, listTools, findTool, WEB_SEARCH_TOOL } from './registry.js';
export { validateArgs } from './validate.js';
export { toolOk, toolError, toolResult } from './envelope.js';
export { inheritedContext } from './interaction.js';
