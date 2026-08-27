// Org-facing agent prompt view + additions (issue #67). Every org member can
// read the agents' base system prompts and the org's additions; owners edit
// the additions. Base prompts are seed-owned (db/prompts/*.md) and read-only
// here — this surface augments, never edits.

import express from 'express';

import { listAgentsWithTools } from '../db/agents.js';
import { recordAuthEvent } from '../db/auth-events.js';
import {
  MAX_ADDITION_CHARS,
  PromptValidationError,
  listOrgAgentPrompts,
  setOrgAgentPrompt,
} from '../db/org-agent-prompts.js';
import { requireOrgRole } from './guards.js';

const router = express.Router();

function additionPayload(row) {
  if (!row) return null;
  return {
    text: row.addition,
    updated_at: row.updated_at,
    updated_by_email: row.updated_by_email ?? null,
  };
}

/**
 * GET /api/orgs/:orgId/agent-prompts — every agent's base prompt, model, and
 * tool slugs, joined with this org's additions. Viewer role: the issue's
 * "view" half is for all members; only the addition is owner-writable.
 */
router.get('/api/orgs/:orgId/agent-prompts', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  const agents = await listAgentsWithTools();
  const additions = new Map(
    listOrgAgentPrompts(ctx.orgId).map((row) => [row.agent_slug, row]),
  );
  res.json({
    max_addition_chars: MAX_ADDITION_CHARS,
    agents: agents.map((a) => ({
      slug: a.slug,
      name: a.name,
      description: a.description,
      model: a.model,
      tools: a.tools,
      system_prompt: a.system_prompt,
      addition: additionPayload(additions.get(a.slug)),
    })),
  });
});

/**
 * PUT /api/orgs/:orgId/agent-prompts/:slug — owner sets (or clears, with an
 * empty string) the org's addition for one agent. 404 unknown slug (matches
 * the non-leaking refusal contract), 400 { error, field } on bad input.
 */
router.put('/api/orgs/:orgId/agent-prompts/:slug', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const slug = req.params.slug;
  const agents = await listAgentsWithTools();
  if (!agents.some((a) => a.slug === slug)) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  let result;
  try {
    result = setOrgAgentPrompt(ctx.orgId, slug, req.body?.addition, req.user.id);
  } catch (err) {
    if (err instanceof PromptValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }
  recordAuthEvent({
    type: result.cleared ? 'agent_prompt.cleared' : 'agent_prompt.updated',
    actorUserId: req.user.id,
    orgId: ctx.orgId,
    meta: { agent: slug, length: result.row?.addition.length ?? 0 },
  });
  res.json({
    agent: slug,
    addition: result.cleared
      ? null
      : additionPayload({ ...result.row, updated_by_email: req.user.email }),
  });
});

export default router;
