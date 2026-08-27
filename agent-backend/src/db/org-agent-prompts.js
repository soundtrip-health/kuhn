// Org agent-prompt additions (issue #67): per-agent, org-wide guardrail text
// appended to the agent's system prompt at task time. Synchronous (querySync)
// so the agent runtime can fetch an addition without another await on the
// task hot path, matching db/org-settings.js.

import { querySync } from '../db.js';

// Guardrails, not essays: keeps the addition a bounded slice of the context
// window (~1k tokens) and the org-admin textarea honest.
export const MAX_ADDITION_CHARS = 4000;

/** Field-level validation failure — routes map to 400 { error, field }. */
export class PromptValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

/**
 * The org's addition for one agent.
 * @returns {object|null} row { org_id, agent_slug, addition, updated_by, updated_at } or null
 */
export function getOrgAgentPrompt(orgId, agentSlug) {
  const { rows } = querySync(
    'SELECT * FROM org_agent_prompts WHERE org_id = $1 AND agent_slug = $2',
    [orgId, agentSlug],
  );
  return rows[0] ?? null;
}

/** All of an org's additions, keyed for a join against the agents list. */
export function listOrgAgentPrompts(orgId) {
  const { rows } = querySync(
    `SELECT p.*, u.email AS updated_by_email
     FROM org_agent_prompts p
     LEFT JOIN users u ON u.id = p.updated_by
     WHERE p.org_id = $1`,
    [orgId],
  );
  return rows;
}

/**
 * Set (upsert) or clear one agent's addition. Trims; an empty/whitespace
 * addition deletes the row. Validates length only — the caller resolves the
 * agent slug against the agents table (this module stays slug-agnostic).
 * @returns {{cleared: boolean, row: object|null}}
 * @throws {PromptValidationError} non-string or over MAX_ADDITION_CHARS
 */
export function setOrgAgentPrompt(orgId, agentSlug, addition, userId = null) {
  if (typeof addition !== 'string') {
    throw new PromptValidationError('addition must be a string', 'addition');
  }
  const trimmed = addition.trim();
  if (trimmed.length > MAX_ADDITION_CHARS) {
    throw new PromptValidationError(
      `addition must be at most ${MAX_ADDITION_CHARS} characters`, 'addition',
    );
  }
  if (!trimmed) {
    querySync(
      'DELETE FROM org_agent_prompts WHERE org_id = $1 AND agent_slug = $2',
      [orgId, agentSlug],
    );
    return { cleared: true, row: null };
  }
  const { rows } = querySync(
    `INSERT INTO org_agent_prompts (org_id, agent_slug, addition, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, agent_slug) DO UPDATE SET
       addition   = excluded.addition,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING *`,
    [orgId, agentSlug, trimmed, userId],
  );
  return { cleared: false, row: rows[0] ?? null };
}
