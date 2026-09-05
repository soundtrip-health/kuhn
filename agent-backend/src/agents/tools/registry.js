/**
 * Neutral Kuhn tool registry (STH-1).
 *
 * The model-callable tools the agents can use, described once in
 * provider-neutral form:
 *
 *   {
 *     name:        stable model-facing tool name (the MCP tool name on
 *                  Claude, e.g. `mcp__kuhn__read_file`),
 *     grants:      the DB tool slugs (agent_tools assignments) that expose
 *                  it — one broad grant may expose several generated
 *                  variants (manage_references → update_reference +
 *                  remove_reference, manage_comments → list/reply/resolve,
 *                  run_script → list_scripts + run_script),
 *     description: model-facing description,
 *     parameters:  JSON Schema (the model-facing argument contract),
 *     readOnly:    true when the tool has no product-side effects,
 *     effect:      'read' | 'write' | 'external-read' | 'external' | 'control',
 *     execute(toolCallId, args, signal) → the normalized envelope
 *                  (tools/envelope.js),
 *   }
 *
 * These modules import neither Claude nor Pi: the executors use only Kuhn
 * server modules (storage service, reference store, comment store,
 * sandbox, question registry, …). Adapters project the descriptors into
 * provider form — the Claude tool adapter (provider-runtime/claude-tools.js)
 * compiles the JSON Schemas to Zod and wraps `execute` in the SDK `tool()`
 * handler; a Pi adapter (STH-8) consumes the descriptors and `validateArgs`
 * directly.
 *
 * Project/user/org identity is derived server-side from the context and
 * never model-supplied: the org comes from the task's project row, the user
 * attribution from the session, and there is deliberately no tenant
 * parameter on any tool.
 */

import { createFileTools } from './files.js';
import { createReferenceTools } from './references.js';
import { createCommentTools } from './comments.js';
import { createLiteratureTools } from './literature.js';
import { createScriptTools } from './scripts.js';
import { createInteractionTools } from './interaction.js';
import { createProjectTools } from './project.js';
import { createSlideTools } from './slides.js';

// Domain order is the stable enumeration order (deterministic for tests and
// for the tool list a provider sees).
const DOMAIN_TOOL_FACTORIES = [
  createFileTools,
  createReferenceTools,
  createCommentTools,
  createLiteratureTools,
  createScriptTools,
  createInteractionTools,
  createProjectTools,
  createSlideTools,
];

/**
 * The web_search grant maps to the provider's NATIVE web tools, not a Kuhn
 * executor: on Claude the adapter passes the SDK built-ins (WebSearch +
 * WebFetch) instead of an MCP tool. Described here so enumeration by
 * role/mode is complete and every other adapter can implement or filter it
 * deliberately. `execute` is null by contract — a provider_builtin tool has
 * no Kuhn executor; adapters that cannot supply it natively must omit it.
 */
export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  grants: ['web_search'],
  kind: 'provider_builtin',
  readOnly: true,
  effect: 'external-read',
  description: 'General web search for documents, guidelines, and references',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Maximum results to return' },
    },
    required: ['query'],
  },
  execute: null,
};

/**
 * Server-derived execution context for a single agent task. Everything a
 * tool executor needs that must NOT come from the model.
 *
 * @typedef {object} ToolContext
 * @property {{ slug: string, name: string, system_prompt: string, model: string|null, tools: string[] }} agent
 *   - the role row with the DB tool grants, AFTER product-level filtering
 *     (e.g. compose mode has already removed the mutation grants)
 * @property {number|string} projectId
 * @property {number} depth - 0 for the root task; sub-agent dispatches recurse
 * @property {{ used: number, limit: number, baseWeight?: number }} budget - shared with the whole dispatch tree
 * @property {{ id: number }} parentJob - the job this task belongs to (attribution)
 * @property {import('../events.js').EventChannel} channel - the task's product event channel
 * @property {number|null} userId - session user for attribution (story 007-001)
 * @property {boolean} seeding - seeding-pipeline bypass (story 008-001)
 * @property {object|null} context - editor context slice for dispatch inheritance (STH-43)
 * @property {(task: object, internal?: object) => AsyncGenerator<object>} dispatch
 *   - the runAgentTask boundary, injected by the runtime caller
 * @property {AbortSignal|null} signal - the owning run's abort signal (issue
 *   #136): fires when the run is stopped (user, disconnect, budget), so a
 *   dispatched sub-agent is torn down with its parent
 */

/**
 * @param {object} args - ToolContext fields (all required; `dispatch` is the
 *   runAgentTask generator, passed by runTask)
 * @returns {ToolContext}
 */
export function createToolContext({
  agent, projectId, depth, budget, parentJob, channel,
  userId = null, seeding = false, context = null, dispatch, signal = null,
}) {
  if (!agent || !Array.isArray(agent.tools)) throw new Error('createToolContext: agent row with tool grants is required');
  if (typeof dispatch !== 'function') {
    throw new Error('createToolContext: dispatch (the runAgentTask boundary) is required');
  }
  return {
    agent,
    projectId,
    depth: depth ?? 0,
    budget,
    parentJob,
    channel,
    userId,
    seeding,
    context,
    dispatch,
    signal,
  };
}

function granted(ctx, tool) {
  return tool.grants.some((slug) => ctx.agent.tools.includes(slug));
}

/**
 * Enumerate the model-callable tools for a task context: every Kuhn tool
 * whose grant the role holds, in stable domain order, with per-tool
 * visibility predicates applied (dispatch_agent is withheld at the max
 * dispatch depth). The provider_builtin web_search descriptor is included
 * last so adapters can map it to their native web tools.
 *
 * @param {ToolContext} ctx
 * @returns {Array<object>} neutral tool descriptors (execute bound to ctx)
 */
export function listTools(ctx) {
  const tools = [];
  for (const factory of DOMAIN_TOOL_FACTORIES) {
    for (const tool of factory(ctx)) {
      if (!granted(ctx, tool)) continue;
      if (tool.visible && !tool.visible(ctx)) continue;
      tools.push(tool);
    }
  }
  if (ctx.agent.tools.includes(WEB_SEARCH_TOOL.grants[0])) {
    tools.push(WEB_SEARCH_TOOL);
  }
  return tools;
}

/**
 * @param {ToolContext} ctx
 * @param {string} name - neutral tool name
 * @returns {object|undefined} the descriptor (or undefined)
 */
export function findTool(ctx, name) {
  return listTools(ctx).find((tool) => tool.name === name);
}
