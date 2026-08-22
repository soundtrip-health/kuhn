// STH-35: the access-request queue. The invariants worth pinning are the
// ones the routes rely on — one pending row per address, notes normalized on
// the way in, and a decision that can only land once.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let ar;

const ADMIN = 1;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  ar = await import('./access-requests.js');
});

beforeEach(() => {
  querySync('DELETE FROM access_requests');
  querySync('DELETE FROM users');
  querySync(`INSERT INTO users (id, email) VALUES (${ADMIN}, 'root@kuhn.dev')`);
});

describe('recording a request', () => {
  it('normalizes the address and trims the note', () => {
    const { request, existing } = ar.recordAccessRequest({
      email: '  Newcomer@Lab.ORG ',
      note: '   PI at the Chen lab   ',
    });
    expect(existing).toBe(false);
    expect(request).toMatchObject({
      email: 'newcomer@lab.org',
      note: 'PI at the Chen lab',
      status: 'pending',
      request_count: 1,
    });
  });

  it('caps an oversized note instead of rejecting the request', () => {
    const { request } = ar.recordAccessRequest({ email: 'a@b.co', note: 'x'.repeat(5000) });
    expect(request.note).toHaveLength(ar.NOTE_MAX);
  });

  it('treats a blank or absent note as none', () => {
    expect(ar.recordAccessRequest({ email: 'a@b.co', note: '   ' }).request.note).toBeNull();
    expect(ar.recordAccessRequest({ email: 'c@d.co' }).request.note).toBeNull();
  });

  it('never queues two pending rows for one address', () => {
    ar.recordAccessRequest({ email: 'a@b.co' });
    const { request, existing } = ar.recordAccessRequest({ email: 'a@b.co', note: 'let me in' });
    expect(existing).toBe(true);
    expect(request.request_count).toBe(2);
    // A later ask fills in a note the first attempt lacked...
    expect(request.note).toBe('let me in');
    // ...but never overwrites one already given.
    expect(ar.recordAccessRequest({ email: 'a@b.co', note: 'second thoughts' }).request.note)
      .toBe('let me in');
    expect(querySync('SELECT COUNT(*) AS n FROM access_requests').rows[0].n).toBe(1);
  });
});

describe('listing', () => {
  it('filters by status and orders by the most recent ask', () => {
    const first = ar.recordAccessRequest({ email: 'first@b.co' }).request;
    ar.recordAccessRequest({ email: 'second@b.co' });
    // Re-asking moves an older request back to the top of the queue.
    querySync("UPDATE access_requests SET last_requested_at = '2030-01-01T00:00:00.000Z' WHERE id = $1",
      [first.id]);

    expect(ar.listAccessRequests().map((r) => r.email)).toEqual(['first@b.co', 'second@b.co']);
    expect(ar.listAccessRequests({ status: 'pending' })).toHaveLength(2);
    expect(ar.listAccessRequests({ status: 'denied' })).toEqual([]);
  });

  it('carries the decider email for display', () => {
    const { id } = ar.recordAccessRequest({ email: 'a@b.co' }).request;
    ar.decideAccessRequest(id, 'denied', { decidedBy: ADMIN });
    expect(ar.listAccessRequests({ status: 'denied' })[0].decided_by_email).toBe('root@kuhn.dev');
  });
});

describe('deciding', () => {
  it('settles a pending row exactly once', () => {
    const { id } = ar.recordAccessRequest({ email: 'a@b.co' }).request;
    const settled = ar.decideAccessRequest(id, 'approved', { decidedBy: ADMIN, note: '  vouched  ' });
    expect(settled).toMatchObject({ status: 'approved', decided_by: ADMIN, decision_note: 'vouched' });
    expect(settled.decided_at).toBeTruthy();
    // The second decision loses — this is what stops a double invitation.
    expect(ar.decideAccessRequest(id, 'denied', { decidedBy: ADMIN })).toBeNull();
    expect(ar.getAccessRequest(id).status).toBe('approved');
  });

  it('rejects a status outside the state machine', () => {
    const { id } = ar.recordAccessRequest({ email: 'a@b.co' }).request;
    expect(() => ar.decideAccessRequest(id, 'maybe')).toThrow(/unknown decision/);
  });

  it('a decided address may ask again, opening a fresh row', () => {
    const first = ar.recordAccessRequest({ email: 'a@b.co' }).request;
    ar.decideAccessRequest(first.id, 'denied', { decidedBy: ADMIN });
    const { request: second, existing } = ar.recordAccessRequest({ email: 'a@b.co' });
    expect(existing).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect(second.request_count).toBe(1);
  });
});

describe('resolvePendingRequestsFor', () => {
  it('closes a pending row when the address is invited by another route', () => {
    ar.recordAccessRequest({ email: 'a@b.co' });
    expect(ar.resolvePendingRequestsFor('  A@B.co ', { decidedBy: ADMIN })).toBe(1);
    expect(ar.listAccessRequests({ status: 'approved' })[0])
      .toMatchObject({ decision_note: 'Invited directly', decided_by: ADMIN });
  });

  it('is a no-op for an address with nothing queued', () => {
    expect(ar.resolvePendingRequestsFor('nobody@b.co')).toBe(0);
  });

  it('leaves an already-decided row alone', () => {
    const { id } = ar.recordAccessRequest({ email: 'a@b.co' }).request;
    ar.decideAccessRequest(id, 'denied', { decidedBy: ADMIN, note: 'no' });
    expect(ar.resolvePendingRequestsFor('a@b.co')).toBe(0);
    expect(ar.getAccessRequest(id)).toMatchObject({ status: 'denied', decision_note: 'no' });
  });
});
