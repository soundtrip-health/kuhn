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
 * Load an agent's system prompt and assigned tool slugs.
 * @param {string} role - Role name or DB slug
 * @returns {Promise<{slug: string, name: string, system_prompt: string, tools: string[]}|null>}
 */
export async function getAgentWithTools(role) {
  const slug = resolveRoleSlug(role);
  const { rows } = await query(
    `SELECT a.slug, a.name, a.system_prompt,
            COALESCE(array_agg(t.slug) FILTER (WHERE t.slug IS NOT NULL), '{}') AS tools
     FROM agents a
     LEFT JOIN agent_tools at ON at.agent_id = a.id
     LEFT JOIN tools t ON t.id = at.tool_id
     WHERE a.slug = $1
     GROUP BY a.id`,
    [slug],
  );
  return rows[0] ?? null;
}
