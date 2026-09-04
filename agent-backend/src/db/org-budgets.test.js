// Org token budgets (issue #110, parts 3–4): period windows, the ledger sum,
// overrides, resets, and the owner's report — real in-memory SQLite.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let budgets;
let settings;

const ORG = 1;
const OTHER_ORG = 2;
const ALICE = 1;
const BOB = 2;
const P1 = 10;
const P2 = 11;
const P_OTHER = 20;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  budgets = await import('./org-budgets.js');
  settings = await import('./org-settings.js');
});

function job({ user, project, weighted, createdAt, parent = null }) {
  querySync(
    `INSERT INTO jobs (project_id, user_id, role, input, status, weighted_tokens, parent_job_id, created_at)
     VALUES ($1, $2, 'writer', 'x', 'done', $3, $4, $5)`,
    [project, user, weighted, parent, createdAt],
  );
}

beforeEach(() => {
  for (const t of ['jobs', 'org_budgets', 'memberships', 'projects', 'users', 'organizations']) querySync(`DELETE FROM ${t}`);
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab'), (${OTHER_ORG}, 'Other', 'other')`);
  querySync(`INSERT INTO users (id, email) VALUES (${ALICE}, 'alice@lab.org'), (${BOB}, 'bob@lab.org')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${ALICE}, ${ORG}, 'owner'), (${BOB}, ${ORG}, 'editor'), (${ALICE}, ${OTHER_ORG}, 'editor')`);
  querySync(`INSERT INTO projects (id, org_id, name, project_type) VALUES (${P1}, ${ORG}, 'One', 'manuscript'), (${P2}, ${ORG}, 'Two', 'grant'), (${P_OTHER}, ${OTHER_ORG}, 'Elsewhere', 'manuscript')`);
});

describe('periodWindow', () => {
  const now = new Date('2026-09-04T13:45:00Z'); // a Friday
  it('day / ISO week / month, in UTC', () => {
    expect(budgets.periodWindow('day', now)).toEqual({ start: '2026-09-04T00:00:00.000Z', end: '2026-09-05T00:00:00.000Z' });
    expect(budgets.periodWindow('week', now)).toEqual({ start: '2026-08-31T00:00:00.000Z', end: '2026-09-07T00:00:00.000Z' });
    expect(budgets.periodWindow('month', now)).toEqual({ start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' });
    // Week starting on a Sunday-dated now still snaps back to Monday.
    expect(budgets.periodWindow('week', new Date('2026-09-06T23:00:00Z')).start).toBe('2026-08-31T00:00:00.000Z');
    // Month roll-over at year end.
    expect(budgets.periodWindow('month', new Date('2026-12-15T00:00:00Z')).end).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('resolveBudgets', () => {
  const now = new Date('2026-09-04T12:00:00Z');

  it('applies no bound while the org defaults are 0 (unlimited)', () => {
    expect(budgets.resolveBudgets({ orgId: ORG, userId: ALICE, projectId: P1, now }))
      .toMatchObject({ period: 'month', user: null, project: null });
  });

  it('sums the weighted ledger for the user across the org\'s projects, in the period, sub-jobs included', () => {
    settings.updateOrgSettings(ORG, { user_token_budget: 1000, project_token_budget: 500 });
    job({ user: ALICE, project: P1, weighted: 300, createdAt: '2026-09-02T00:00:00.000Z' });
    job({ user: ALICE, project: P2, weighted: 200, createdAt: '2026-09-03T00:00:00.000Z' });
    job({ user: ALICE, project: P2, weighted: 50, createdAt: '2026-09-03T00:01:00.000Z', parent: 1 });
    job({ user: ALICE, project: P1, weighted: 900, createdAt: '2026-08-20T00:00:00.000Z' }); // last month
    job({ user: BOB, project: P1, weighted: 400, createdAt: '2026-09-03T00:00:00.000Z' });   // someone else
    job({ user: ALICE, project: P_OTHER, weighted: 999, createdAt: '2026-09-03T00:00:00.000Z' }); // other org

    const r = budgets.resolveBudgets({ orgId: ORG, userId: ALICE, projectId: P1, now });
    expect(r.user).toMatchObject({ scope: 'user', limit: 1000, used: 550, remaining: 450, resetsAt: '2026-10-01T00:00:00.000Z' });
    // Project spend counts every user's jobs in that project.
    expect(r.project).toMatchObject({ scope: 'project', limit: 500, used: 700, remaining: 0 });
  });

  it('a per-member override replaces the default; 0 means unlimited for that member', () => {
    settings.updateOrgSettings(ORG, { user_token_budget: 1000 });
    job({ user: ALICE, project: P1, weighted: 1500, createdAt: '2026-09-02T00:00:00.000Z' });
    expect(budgets.resolveBudgets({ orgId: ORG, userId: ALICE, projectId: P1, now }).user.remaining).toBe(0);

    budgets.setBudgetLimit(ORG, 'user', ALICE, 5000);
    expect(budgets.resolveBudgets({ orgId: ORG, userId: ALICE, projectId: P1, now }).user)
      .toMatchObject({ limit: 5000, used: 1500, remaining: 3500 });

    budgets.setBudgetLimit(ORG, 'user', ALICE, 0);
    expect(budgets.resolveBudgets({ orgId: ORG, userId: ALICE, projectId: P1, now }).user).toBeNull();

    budgets.setBudgetLimit(ORG, 'user', ALICE, null); // back to inheriting
    expect(budgets.resolveBudgets({ orgId: ORG, userId: ALICE, projectId: P1, now }).user.limit).toBe(1000);
  });

  it('a manual reset counts usage from the reset; a later period start supersedes it', () => {
    // reset_at is stamped with the DB clock, so the fixture runs on real time.
    const realNow = new Date();
    const minutesAgo = (n) => new Date(realNow.getTime() - n * 60_000).toISOString();
    settings.updateOrgSettings(ORG, { project_token_budget: 1000, budget_period: 'month' });
    job({ user: ALICE, project: P1, weighted: 800, createdAt: minutesAgo(5) });
    expect(budgets.resolveBudgets({ orgId: ORG, projectId: P1, now: realNow }).project.used).toBe(800);

    budgets.resetBudget(ORG, 'project', P1, ALICE);
    const afterReset = budgets.resolveBudgets({ orgId: ORG, projectId: P1, now: new Date() });
    expect(afterReset.project.used).toBe(0);
    expect(afterReset.project.resetAt).toBeTruthy();

    // Two months on: the window starts after the reset, so the reset no
    // longer matters and only that window's jobs count.
    const later = new Date(Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth() + 2, 10));
    const inWindow = new Date(Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth() + 2, 3)).toISOString();
    job({ user: ALICE, project: P1, weighted: 100, createdAt: inWindow });
    const twoMonthsOn = budgets.resolveBudgets({ orgId: ORG, projectId: P1, now: later }).project;
    expect(twoMonthsOn.used).toBe(100);
    expect(twoMonthsOn.since).toBe(budgets.periodWindow('month', later).start);
  });

  it('validates overrides and scopes', () => {
    expect(() => budgets.setBudgetLimit(ORG, 'user', ALICE, -5)).toThrow(budgets.BudgetValidationError);
    expect(() => budgets.setBudgetLimit(ORG, 'user', ALICE, 1.5)).toThrow(/non-negative integer/);
    expect(() => budgets.setBudgetLimit(ORG, 'org', 1, 5)).toThrow(/scope must be one of/);
    expect(() => budgets.resetBudget(ORG, 'team', 1)).toThrow(budgets.BudgetValidationError);
  });
});

describe('orgBudgetReport', () => {
  it('lists every member and project with effective limit, override, usage, and reset', () => {
    settings.updateOrgSettings(ORG, { user_token_budget: 1000, budget_period: 'week' });
    budgets.setBudgetLimit(ORG, 'user', BOB, 200);
    budgets.setBudgetLimit(ORG, 'project', P2, 3000);
    const createdAt = new Date().toISOString();
    job({ user: BOB, project: P1, weighted: 150, createdAt });
    job({ user: ALICE, project: P2, weighted: 20, createdAt });

    const report = budgets.orgBudgetReport(ORG);
    expect(report.settings).toEqual({ user_token_budget: 1000, project_token_budget: 0, budget_period: 'week' });
    expect(report.window.end > report.window.start).toBe(true);
    expect(report.users).toEqual([
      { user_id: ALICE, email: 'alice@lab.org', display_name: null, role: 'owner', override: null, limit: 1000, used: 20, reset_at: null },
      { user_id: BOB, email: 'bob@lab.org', display_name: null, role: 'editor', override: 200, limit: 200, used: 150, reset_at: null },
    ]);
    expect(report.projects).toEqual([
      { project_id: P1, name: 'One', override: null, limit: null, used: 150, reset_at: null },
      { project_id: P2, name: 'Two', override: 3000, limit: 3000, used: 20, reset_at: null },
    ]);
    expect(budgets.orgBudgetReport(999)).toBeNull();
  });
});
