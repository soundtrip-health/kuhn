// Story 011-004: promotion-request records — pending-dedupe on file, and the
// atomic decision claim (fix MA3) that makes concurrent owner decides safe.

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
  promotions = await import('./promotions.js');
});

beforeEach(() => {
  querySync('DELETE FROM promotion_requests');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Lab', 'lab'), (2, 'Rival', 'rival')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@lab.local'), (2, 'ed@lab.local')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (10, 1, 'Trial', 'manuscript')");
});

const file = (path = 'a.md', extra = {}) => promotions.createPromotionRequest({
  orgId: 1, projectId: 10, path, suggestedBy: 2, ...extra,
});

describe('createPromotionRequest', () => {
  it('inserts a pending row with the joined client fields', () => {
    const { request, existing } = file('guidance/style.md', { title: 'Style', note: 'pls' });
    expect(existing).toBe(false);
    expect(request).toMatchObject({
      org_id: 1, project_id: 10, project_name: 'Trial',
      path: 'guidance/style.md', title: 'Style', note: 'pls',
      suggested_by: 2, suggested_by_email: 'ed@lab.local',
      status: 'pending', decided_by: null, decided_at: null,
      decision_note: null, org_document_id: null,
    });
  });

  it('returns the existing PENDING request for the same (project, path) instead of duplicating', () => {
    const first = file('dup.md').request;
    const second = file('dup.md', { suggestedBy: 1, note: 'me too' });
    expect(second.existing).toBe(true);
    expect(second.request.id).toBe(first.id);
    expect(second.request.suggested_by).toBe(2); // original suggester kept
    expect(querySync('SELECT COUNT(*) AS n FROM promotion_requests').rows[0].n).toBe(1);
  });

  it('creates a fresh row once the earlier request was decided (re-suggest after reject)', () => {
    const first = file('again.md').request;
    promotions.claimPromotionDecision({ id: first.id, orgId: 1, status: 'rejected', decidedBy: 1 });
    const { request, existing } = file('again.md');
    expect(existing).toBe(false);
    expect(request.id).not.toBe(first.id);
    expect(querySync('SELECT COUNT(*) AS n FROM promotion_requests').rows[0].n).toBe(2);
  });
});

describe('claimPromotionDecision (fix MA3)', () => {
  it('claims pending exactly once — the second claim gets null', () => {
    const { request } = file('race.md');
    const won = promotions.claimPromotionDecision({
      id: request.id, orgId: 1, status: 'approved', decidedBy: 1, note: 'in',
    });
    expect(won).toMatchObject({ status: 'approved', decided_by: 1, decision_note: 'in' });
    expect(won.decided_at).toBeTruthy();
    const lost = promotions.claimPromotionDecision({
      id: request.id, orgId: 1, status: 'rejected', decidedBy: 1,
    });
    expect(lost).toBeNull();
    // The winner's decision survives untouched.
    expect(promotions.getPromotionRequest(1, request.id).status).toBe('approved');
  });

  it('is org-scoped: another org cannot claim (or see) the request', () => {
    const { request } = file('cross.md');
    expect(promotions.claimPromotionDecision({
      id: request.id, orgId: 2, status: 'approved', decidedBy: 1,
    })).toBeNull();
    expect(promotions.getPromotionRequest(2, request.id)).toBeNull();
    expect(promotions.getPromotionRequest(1, request.id).status).toBe('pending');
  });

  it('revertPromotionToPending clears the whole decision in one step', () => {
    const { request } = file('revert.md');
    promotions.claimPromotionDecision({
      id: request.id, orgId: 1, status: 'approved', decidedBy: 1, note: 'oops',
    });
    promotions.revertPromotionToPending(request.id);
    expect(promotions.getPromotionRequest(1, request.id)).toMatchObject({
      status: 'pending', decided_by: null, decided_at: null, decision_note: null,
    });
    // Back to claimable.
    expect(promotions.claimPromotionDecision({
      id: request.id, orgId: 1, status: 'rejected', decidedBy: 1,
    })).not.toBeNull();
  });
});

describe('listPromotionRequests / setPromotionOrgDocument', () => {
  it('lists newest first and filters by status', () => {
    const a = file('a.md').request;
    const b = file('b.md').request;
    promotions.claimPromotionDecision({ id: a.id, orgId: 1, status: 'rejected', decidedBy: 1 });

    const all = promotions.listPromotionRequests(1);
    expect(all.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(promotions.listPromotionRequests(1, { status: 'pending' }).map((r) => r.id)).toEqual([b.id]);
    expect(promotions.listPromotionRequests(1, { status: 'rejected' }).map((r) => r.id)).toEqual([a.id]);
    expect(promotions.listPromotionRequests(2)).toEqual([]);
  });

  it('links the approved request to its library document', () => {
    const { request } = file('link.md');
    promotions.claimPromotionDecision({ id: request.id, orgId: 1, status: 'approved', decidedBy: 1 });
    querySync(
      `INSERT INTO org_documents (id, org_id, filename, size_bytes, sha256)
       VALUES (77, 1, 'link.md', 4, 'hash')`,
    );
    promotions.setPromotionOrgDocument(request.id, 77);
    expect(promotions.getPromotionRequest(1, request.id).org_document_id).toBe(77);
  });
});
