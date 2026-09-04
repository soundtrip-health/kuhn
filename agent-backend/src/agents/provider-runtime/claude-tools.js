/**
 * Claude tool adapter (STH-1): the only production code that turns Kuhn's
 * neutral tool descriptors (agents/tools/) into Claude Agent SDK `tool()` /
 * MCP-server form. Claude-specific names and types live ONLY here:
 *
 * - JSON Schema (neutral) → Zod (the SDK's native validation schema);
 * - MCP server name/version and the `mcp__kuhn__<name>` allowlist naming;
 * - the provider-native web tools (WebSearch + WebFetch) behind the
 *   web_search grant;
 * - the neutral execute envelope → SDK tool result shape.
 *
 * Adapters for other providers (Pi, STH-8) do NOT use this module: they
 * consume the neutral descriptors and `validateArgs` directly.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const CLAUDE_MCP_SERVER_NAME = 'kuhn';
export const CLAUDE_MCP_SERVER_VERSION = '1.0.0';

// Kuhn tool name → Claude SDK built-in tool names. The built-ins are selected
// via the SDK `tools` option (allowedTools alone does not restrict anything
// under permissionMode: 'bypassPermissions').
const PROVIDER_BUILTIN_MAP = {
  web_search: ['WebSearch', 'WebFetch'],
};

// Claude built-in (provider-native) tool names → the neutral Kuhn grant
// name they ride. The canonical runtime contract carries neutral names;
// Claude's built-in spellings are adapter-internal.
const CLAUDE_BUILTIN_TO_NEUTRAL = new Map([
  ['WebSearch', 'web_search'],
  ['WebFetch', 'web_search'],
]);

/**
 * Compile a neutral JSON Schema (the subset Kuhn's tool schemas use — see
 * tools/validate.js) to a Zod schema. Optionality and defaults are applied
 * at the object level from the `required` list, matching how the original
 * Claude-side zod schemas were written.
 *
 * @param {object} schema
 * @param {Set<string>|null} required - required property names (object level)
 * @param {string|null} property - the property name being compiled (for
 *   optionality), when compiling a member of an object
 * @returns {import('zod').ZodTypeAny}
 */
function jsonSchemaToZod(schema, required = null, property = null) {
  if (!schema || typeof schema !== 'object') return z.unknown();

  let base;
  if (schema.enum) {
    base = z.enum(schema.enum);
  } else switch (schema.type) {
    case 'string': {
      base = z.string();
      if (schema.minLength != null) base = base.min(schema.minLength);
      if (schema.pattern != null) base = base.regex(new RegExp(schema.pattern), schema.patternMessage);
      break;
    }
    case 'number':
    case 'integer': {
      base = schema.type === 'integer' ? z.number().int() : z.number();
      if (schema.minimum != null) base = base.min(schema.minimum);
      if (schema.maximum != null) base = base.max(schema.maximum);
      break;
    }
    case 'boolean':
      base = z.boolean();
      break;
    case 'array': {
      base = z.array(schema.items ? jsonSchemaToZod(schema.items) : z.unknown());
      if (schema.minItems != null) base = base.min(schema.minItems);
      if (schema.maxItems != null) base = base.max(schema.maxItems);
      break;
    }
    case 'object': {
      const props = schema.properties ?? {};
      const subRequired = new Set(schema.required ?? []);
      const shape = {};
      for (const [key, sub] of Object.entries(props)) {
        shape[key] = jsonSchemaToZod(sub, subRequired, key);
      }
      base = z.object(shape);
      break;
    }
    default:
      base = z.unknown();
  }

  if (schema.description) base = base.describe(schema.description);
  if (schema.default !== undefined) return base.default(schema.default);
  if (required != null && property != null && !required.has(property)) return base.optional();
  return base;
}

 /**
  * Top-level parameters: the SDK `tool()` takes a ZodRawShape (property →
  * schema), not a z.object() — build the shape from the neutral object
  * schema, applying optionality/defaults per property.
  *
  * @param {object} parameters - the neutral object schema
  * @returns {Record<string, import('zod').ZodTypeAny>}
  */
 export function jsonSchemaToShape(parameters) {
   const props = parameters?.properties ?? {};
   const required = new Set(parameters?.required ?? []);
   const shape = {};
   for (const [key, sub] of Object.entries(props)) {
     shape[key] = jsonSchemaToZod(sub, required, key);
   }
   return shape;
 }

/**
 * @param {object} neutralTool - neutral descriptor with `execute`
 * @returns {object} SDK tool() object: { name, description, schema, handler }
 */
function toClaudeTool(neutralTool) {
  const schema = jsonSchemaToShape(neutralTool.parameters);
  return tool(
    neutralTool.name,
    neutralTool.description,
    schema,
    async (args) => {
      const result = await neutralTool.execute(`claude-${neutralTool.name}`, args);
      return {
        content: (result?.content ?? []).map((block) => ({
          type: 'text',
          text: typeof block?.text === 'string' ? block.text : JSON.stringify(block?.text ?? null),
        })),
        ...(result?.isError === true ? { isError: true } : {}),
      };
    },
  );
}

/**
 * Project the neutral tool list into the Claude SDK's tool surface.
 *
 * @param {Array<object>} neutralTools - from tools/listTools()
 * @returns {{
 *   mcpServer: object|null,
 *   builtinTools: string[],
 *   allowedTools: string[],
 *   toolNames: string[],
 * }} mcpServer is null when the role holds no Kuhn-executed tools (the SDK
 *   query then omits mcpServers, as before); allowedTools is the full
 *   allowlist (built-ins + `mcp__kuhn__<name>`); toolNames lists the MCP tool
 *   names (provider_builtin tools are NOT here — they ride the built-ins).
 */
export function buildClaudeToolSet(neutralTools = []) {
  const kuhnTools = neutralTools
    .filter((t) => t.kind !== 'provider_builtin' && typeof t.execute === 'function')
    .map(toClaudeTool);
  const builtinTools = neutralTools
    .filter((t) => t.kind === 'provider_builtin')
    .flatMap((t) => PROVIDER_BUILTIN_MAP[t.name] ?? []);
  const mcpServer = kuhnTools.length > 0
    ? createSdkMcpServer({ name: CLAUDE_MCP_SERVER_NAME, version: CLAUDE_MCP_SERVER_VERSION, tools: kuhnTools })
    : null;
  const allowedTools = [
    ...builtinTools,
    ...kuhnTools.map((t) => `mcp__${CLAUDE_MCP_SERVER_NAME}__${t.name}`),
  ];
  // Reverse map Claude MCP-qualified name → neutral Kuhn name. Built from
  // the actual projected tool surface (authoritative), consumed by the
  // adapter when emitting normalized events and canonical continuation.
  const claudeToNeutral = new Map(kuhnTools.map((t) => [`mcp__${CLAUDE_MCP_SERVER_NAME}__${t.name}`, t.name]));
  return {
    mcpServer,
    builtinTools,
    allowedTools,
    toolNames: kuhnTools.map((t) => t.name),
    claudeToNeutral,
  };
}

/**
 * Reverse-map a Claude SDK/MCP tool name to the stable neutral Kuhn tool
 * name (STH-47): `mcp__kuhn__write_file` → `write_file`, `WebSearch` →
 * `web_search`. The canonical runtime contract (normalized `tool_call` /
 * `tool_result` events and canonical continuation) must carry the neutral
 * name so a continuation produced by Claude resumes on Pi without any
 * name translation outside the adapters. Unknown names (other MCP
 * servers, unlisted built-ins) pass through unchanged.
 *
 * @param {string} claudeToolName name as the Claude SDK reports it
 * @param {Map<string, string>} [claudeToNeutral] from buildClaudeToolSet()
 * @returns {string} the neutral Kuhn tool name
 */
export function toNeutralToolName(claudeToolName, claudeToNeutral = new Map()) {
  return claudeToNeutral.get(claudeToolName)
    ?? CLAUDE_BUILTIN_TO_NEUTRAL.get(claudeToolName)
    ?? claudeToolName;
}
