import { query } from '../db.js';

// Story 011 role names → DB agent slugs (seed.js uses ra/reviewer)
const ROLE_ALIASES = {
  research: 'ra',
  review: 'reviewer',
};

/** Normalize an agent-task role to its DB slug. */
export function resolveRoleSlug(role) {
  return ROLE_ALIASES[role] ?? role;
}

/**
 * Load an agent's system prompt, model, and assigned tool slugs.
 * @param {string} role - Role name or DB slug
 * @returns {Promise<{slug: string, name: string, system_prompt: string, model: string|null, tools: string[]}|null>}
 */
export async function getAgentWithTools(role) {
  const slug = resolveRoleSlug(role);
  const { rows } = await query(
    `SELECT a.slug, a.name, a.system_prompt, a.model,
            group_concat(t.slug) AS tools
     FROM agents a
     LEFT JOIN agent_tools at ON at.agent_id = a.id
     LEFT JOIN tools t ON t.id = at.tool_id
     WHERE a.slug = $1
     GROUP BY a.id`,
    [slug],
  );
  const row = rows[0];
  if (!row) return null;
  // group_concat ignores NULLs, so a tool-less agent yields tools = null.
  row.tools = row.tools ? row.tools.split(',') : [];
  return row;
}
