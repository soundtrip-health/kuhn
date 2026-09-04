// Org token budgets (issue #110, parts 3–4): the owner's usage report, per-user
// / per-project limit overrides, and the manual reset. Owner-gated through
// requireOrgRole like the rest of org administration; the org defaults and
// period are ordinary org settings (PATCH /api/orgs/:orgId/settings).

import { Router } from 'express';
import { querySync } from '../db.js';
import { requireOrgRole } from './guards.js';
import {
  BudgetValidationError,
  orgBudgetReport,
  resetBudget,
  setBudgetLimit,
} from '../db/org-budgets.js';
import { recordAuthEvent } from '../db/auth-events.js';

const router = Router();

/**
 * Resolve :scope/:id to a member of THIS org (user by membership, project by
 * org_id). 400 on a bad scope or id, 404 when the target is not the org's —
 * a budget row must never be minted for a stranger.
 * @returns {{ scope: string, scopeId: number }|null} null after responding
 */
function resolveTarget(req, res, orgId) {
  const { scope } = req.params;
  const scopeId = Number.parseInt(req.params.id, 10);
  if (scope !== 'user' && scope !== 'project') {
    res.status(400).json({ error: 'scope must be one of: user, project', field: 'scope' });
    return null;
  }
  if (!Number.isInteger(scopeId) || scopeId <= 0) {
    res.status(400).json({ error: 'id must be a positive integer', field: 'id' });
    return null;
  }
  const { rows } = scope === 'user'
    ? querySync('SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, scopeId])
    : querySync('SELECT 1 FROM projects WHERE org_id = $1 AND id = $2', [orgId, scopeId]);
  if (!rows[0]) {
    res.status(404).json({ error: `${scope} not found in this organization` });
    return null;
  }
  return { scope, scopeId };
}

/** GET /api/orgs/:orgId/budgets — defaults, period window, per-user and per-project usage. */
router.get('/api/orgs/:orgId/budgets', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  res.json(orgBudgetReport(ctx.orgId));
});

/**
 * PUT /api/orgs/:orgId/budgets/:scope/:id — body { limit_tokens }: a
 * non-negative integer overrides the org default for this user/project (0 =
 * unlimited); null removes the override.
 */
router.put('/api/orgs/:orgId/budgets/:scope/:id', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const target = resolveTarget(req, res, ctx.orgId);
  if (!target) return;
  const body = req.body ?? {};
  if (!('limit_tokens' in body)) {
    res.status(400).json({ error: 'limit_tokens is required (integer or null)', field: 'limit_tokens' });
    return;
  }
  try {
    const row = setBudgetLimit(ctx.orgId, target.scope, target.scopeId, body.limit_tokens);
    recordAuthEvent({
      type: 'org.budget_limit',
      actorUserId: req.user.id,
      orgId: ctx.orgId,
      meta: { scope: target.scope, scopeId: target.scopeId, limitTokens: body.limit_tokens },
    });
    res.json({ budget: row, report: orgBudgetReport(ctx.orgId) });
  } catch (err) {
    if (err instanceof BudgetValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }
});

/** POST /api/orgs/:orgId/budgets/:scope/:id/reset — usage counts from now (part 4). */
router.post('/api/orgs/:orgId/budgets/:scope/:id/reset', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const target = resolveTarget(req, res, ctx.orgId);
  if (!target) return;
  const row = resetBudget(ctx.orgId, target.scope, target.scopeId, req.user.id);
  recordAuthEvent({
    type: 'org.budget_reset',
    actorUserId: req.user.id,
    orgId: ctx.orgId,
    meta: { scope: target.scope, scopeId: target.scopeId },
  });
  res.json({ budget: row, report: orgBudgetReport(ctx.orgId) });
});

export default router;
