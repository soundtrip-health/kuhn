// Org token budgets (issue #110, parts 3–4). The per-task budget
// (config.agent.tokenBudget) bounds one run; these bound a USER's or a
// PROJECT's spend across runs, per UTC calendar period, so a pause is a
// limit rather than a speed bump.
//
// Model: the org settings carry the defaults (`user_token_budget`,
// `project_token_budget`, 0 = unlimited) and the period (`budget_period`);
// org_budgets rows hold per-user / per-project OVERRIDES of the limit and the
// manual RESET marker (usage counts from the later of the period start and
// the reset). Usage is the sum of jobs.weighted_tokens — tokens weighted by
// model cost relative to the top tier (an Opus token counts 1, cheaper models
// less; see runtime.js ledgerWeight) — so a budget approximates spend.

import { querySync, transaction } from '../db.js';
import { getOrgSettings } from './org-settings.js';

export const BUDGET_SCOPES = ['user', 'project'];
export const BUDGET_PERIODS = ['day', 'week', 'month'];

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Field-level failure — routes map to 400 { error, field }. */
export class BudgetValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

/**
 * The UTC calendar window containing `now`: the day, the ISO week (Monday
 * start), or the month. `end` is when the budget resets.
 * @returns {{ start: string, end: string }} ISO timestamps
 */
export function periodWindow(period, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  let start;
  let end;
  if (period === 'day') {
    start = Date.UTC(y, m, d);
    end = Date.UTC(y, m, d + 1);
  } else if (period === 'week') {
    const sinceMonday = (now.getUTCDay() + 6) % 7;
    start = Date.UTC(y, m, d - sinceMonday);
    end = Date.UTC(y, m, d - sinceMonday + 7);
  } else {
    start = Date.UTC(y, m, 1);
    end = Date.UTC(y, m + 1, 1);
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function assertScope(scope) {
  if (!BUDGET_SCOPES.includes(scope)) {
    throw new BudgetValidationError(`scope must be one of: ${BUDGET_SCOPES.join(', ')}`, 'scope');
  }
}

/** The override/reset row for one scope member, or null. */
export function getBudgetRow(orgId, scope, scopeId) {
  assertScope(scope);
  const { rows } = querySync(
    'SELECT * FROM org_budgets WHERE org_id = $1 AND scope = $2 AND scope_id = $3',
    [orgId, scope, scopeId],
  );
  return rows[0] ?? null;
}

/**
 * Weighted tokens spent in `scope` since `since`. Users are scoped to the
 * org's projects (a user in two orgs has two ledgers); projects are their own
 * scope. Sub-agent jobs carry their own rows, so the sum covers the whole
 * dispatch tree.
 */
export function usedSince(orgId, scope, scopeId, since) {
  assertScope(scope);
  const { rows } = scope === 'user'
    ? querySync(
      `SELECT COALESCE(SUM(j.weighted_tokens), 0) AS used
       FROM jobs j JOIN projects p ON p.id = j.project_id
       WHERE p.org_id = $1 AND j.user_id = $2 AND j.created_at >= $3`,
      [orgId, scopeId, since],
    )
    : querySync(
      `SELECT COALESCE(SUM(j.weighted_tokens), 0) AS used
       FROM jobs j JOIN projects p ON p.id = j.project_id
       WHERE p.org_id = $1 AND j.project_id = $2 AND j.created_at >= $3`,
      [orgId, scopeId, since],
    );
  return Number(rows[0]?.used ?? 0);
}

function later(a, b) {
  return b && b > a ? b : a;
}

/**
 * One scope's budget state, or null when no limit applies (default 0 and no
 * positive override).
 */
function scopeState(orgId, scope, scopeId, defaultLimit, window) {
  if (scopeId == null) return null;
  const row = getBudgetRow(orgId, scope, scopeId);
  const limit = row?.limit_tokens ?? defaultLimit;
  if (!(limit > 0)) return null;
  const since = later(window.start, row?.reset_at ?? null);
  const used = usedSince(orgId, scope, scopeId, since);
  return {
    scope,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: window.end,
    since,
    resetAt: row?.reset_at ?? null,
  };
}

/**
 * The budgets that bound a run by `userId` in `projectId` right now.
 * Synchronous (querySync) — called from the runtime before a task starts.
 * @returns {{ period: string, window: {start, end}, user: object|null, project: object|null }}
 */
export function resolveBudgets({ orgId, userId = null, projectId = null, now = new Date() }) {
  const settings = getOrgSettings(orgId);
  if (!settings) return { period: 'month', window: periodWindow('month', now), user: null, project: null };
  const period = settings.budget_period;
  const window = periodWindow(period, now);
  return {
    period,
    window,
    user: scopeState(orgId, 'user', userId, settings.user_token_budget, window),
    project: scopeState(orgId, 'project', projectId, settings.project_token_budget, window),
  };
}

/**
 * Set (or clear, with null) a per-user / per-project override of the org
 * default. 0 means unlimited for that member; null means inherit.
 */
export function setBudgetLimit(orgId, scope, scopeId, limitTokens) {
  assertScope(scope);
  if (limitTokens !== null && !(Number.isInteger(limitTokens) && limitTokens >= 0)) {
    throw new BudgetValidationError('limit_tokens must be a non-negative integer or null', 'limit_tokens');
  }
  const { rows } = querySync(
    `INSERT INTO org_budgets (org_id, scope, scope_id, limit_tokens)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, scope, scope_id) DO UPDATE
       SET limit_tokens = excluded.limit_tokens, updated_at = ${NOW}
     RETURNING *`,
    [orgId, scope, scopeId, limitTokens],
  );
  return rows[0];
}

/**
 * Manual reset (part 4): usage counts from now on. The reset outlives the
 * period boundary only as a record — a later period start supersedes it.
 */
export function resetBudget(orgId, scope, scopeId, byUserId = null) {
  assertScope(scope);
  const { rows } = querySync(
    `INSERT INTO org_budgets (org_id, scope, scope_id, reset_at, reset_by)
     VALUES ($1, $2, $3, ${NOW}, $4)
     ON CONFLICT (org_id, scope, scope_id) DO UPDATE
       SET reset_at = ${NOW}, reset_by = excluded.reset_by, updated_at = ${NOW}
     RETURNING *`,
    [orgId, scope, scopeId, byUserId],
  );
  return rows[0];
}

/**
 * The owner's view (part 3/4 admin UI): defaults + period, and per-member /
 * per-project usage against the effective limit in the current window.
 * Members and projects come from the org tables, so a scope member with no
 * org_budgets row still appears (inheriting the default).
 */
export function orgBudgetReport(orgId, now = new Date()) {
  const settings = getOrgSettings(orgId);
  if (!settings) return null;
  const period = settings.budget_period;
  const window = periodWindow(period, now);
  return transaction(() => {
    const members = querySync(
      `SELECT m.user_id, u.email, u.display_name, m.role
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1
       ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, u.email`,
      [orgId],
    ).rows;
    const projects = querySync(
      'SELECT id, name FROM projects WHERE org_id = $1 ORDER BY id',
      [orgId],
    ).rows;
    const entry = (scope, id, defaultLimit) => {
      const row = getBudgetRow(orgId, scope, id);
      const limit = row?.limit_tokens ?? defaultLimit;
      const since = later(window.start, row?.reset_at ?? null);
      return {
        override: row?.limit_tokens ?? null,
        limit: limit > 0 ? limit : null, // null = unlimited
        used: usedSince(orgId, scope, id, since),
        reset_at: row?.reset_at ?? null,
      };
    };
    return {
      settings: {
        user_token_budget: settings.user_token_budget,
        project_token_budget: settings.project_token_budget,
        budget_period: period,
      },
      window,
      users: members.map((m) => ({
        user_id: m.user_id, email: m.email, display_name: m.display_name, role: m.role,
        ...entry('user', m.user_id, settings.user_token_budget),
      })),
      projects: projects.map((p) => ({
        project_id: p.id, name: p.name,
        ...entry('project', p.id, settings.project_token_budget),
      })),
    };
  });
}
