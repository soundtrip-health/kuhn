// Issue #68: script promotion records — pending-dedupe on (project, path) and
// the atomic decision claim, mirroring db/promotions.test.js.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let promotions;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  promotions = await import('./script-promotions.js');
});

beforeEach(() => {
  for (const table of ['script_promotion_requests', 'org_script_versions', 'org_scripts', 'projects', 'users', 'organizations']) {
    querySync(`DELETE FROM ${table}`);
  }
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Lab', 'lab'), (2, 'Rival', 'rival')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@lab.local'), (2, 'ed@lab.local')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (10, 1, 'Trial', 'manuscript')");
});

const file = (path = 'analyst/fit.R', extra = {}) => promotions.createScriptPromotion({
  orgId: 1, projectId: 10, path, language: 'r', suggestedBy: 2, ...extra,
});

describe('createScriptPromotion', () => {
  it('inserts a pending row with the joined fields', () => {
    const { request, existing } = file('analyst/fit.R', { title: 'GAMM fit', note: 'pls' });
    expect(existing).toBe(false);
    expect(request).toMatchObject({
      org_id: 1, project_id: 10, project_name: 'Trial', path: 'analyst/fit.R',
      language: 'r', title: 'GAMM fit', note: 'pls', target_script_id: null,
      suggested_by: 2, suggested_by_email: 'ed@lab.local',
      status: 'pending', decided_by: null, org_script_id: null,
    });
  });

  it('dedupes on a pending (project, path); a decided row frees the path', () => {
    const first = file();
    expect(file().existing).toBe(true);
    promotions.claimScriptPromotionDecision({
      id: first.request.id, orgId: 1, status: 'rejected', decidedBy: 1,
    });
    expect(file().existing).toBe(false);
  });

  it('joins the target script for update proposals', () => {
    querySync(`INSERT INTO org_scripts (id, org_id, slug, title, language, source)
               VALUES (5, 1, 'fit', 'Fit', 'r', 'project-promotion')`);
    const { request } = file('analyst/fit2.R', { targetScriptId: 5 });
    expect(request).toMatchObject({ target_script_id: 5, target_script_slug: 'fit' });
  });
});

describe('claimScriptPromotionDecision', () => {
  it('is atomic: exactly one claim wins; cross-org and decided rows refuse', () => {
    const { request } = file();
    const win = promotions.claimScriptPromotionDecision({
      id: request.id, orgId: 1, status: 'approved', decidedBy: 1, note: 'ok',
    });
    expect(win).toMatchObject({ id: request.id, status: 'approved', decision_note: 'ok' });
    expect(promotions.claimScriptPromotionDecision({
      id: request.id, orgId: 1, status: 'rejected', decidedBy: 1,
    })).toBeNull();
    const other = file('analyst/other.R');
    expect(promotions.claimScriptPromotionDecision({
      id: other.request.id, orgId: 2, status: 'approved', decidedBy: 1,
    })).toBeNull();
  });

  it('revert restores pending; result link sticks', () => {
    const { request } = file();
    promotions.claimScriptPromotionDecision({ id: request.id, orgId: 1, status: 'approved', decidedBy: 1 });
    promotions.revertScriptPromotionToPending(request.id);
    expect(promotions.getScriptPromotion(1, request.id)).toMatchObject({
      status: 'pending', decided_by: null, decided_at: null, decision_note: null,
    });
    querySync(`INSERT INTO org_scripts (id, org_id, slug, title, language, source)
               VALUES (7, 1, 'fit', 'Fit', 'r', 'project-promotion')`);
    promotions.setScriptPromotionResult(request.id, 7);
    expect(promotions.getScriptPromotion(1, request.id).org_script_id).toBe(7);
  });
});

describe('listScriptPromotions / getScriptPromotion', () => {
  it('filters by status and never crosses tenants', () => {
    const a = file('analyst/a.R');
    file('analyst/b.R');
    promotions.claimScriptPromotionDecision({ id: a.request.id, orgId: 1, status: 'rejected', decidedBy: 1 });
    expect(promotions.listScriptPromotions(1)).toHaveLength(2);
    expect(promotions.listScriptPromotions(1, { status: 'pending' })).toHaveLength(1);
    expect(promotions.listScriptPromotions(2)).toHaveLength(0);
    expect(promotions.getScriptPromotion(2, a.request.id)).toBeNull();
  });
});
