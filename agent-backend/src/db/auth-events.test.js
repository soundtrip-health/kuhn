// Stories 011-001/002 AC5: the auth_events audit stub — append-only,
// non-throwing on purpose (an audit failure must never fail the action).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let recordAuthEvent;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  ({ recordAuthEvent } = await import('./auth-events.js'));
});

beforeEach(() => {
  querySync('DELETE FROM auth_events');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Lab', 'lab')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@lab.org')");
});

describe('recordAuthEvent', () => {
  it('inserts a row with JSON-serialized meta and returns it', () => {
    const row = recordAuthEvent({
      type: 'invite.issued', actorUserId: 1, orgId: 1,
      email: 'new@lab.org', meta: { invitationId: 7, role: 'editor' },
    });
    expect(row).toMatchObject({
      type: 'invite.issued', actor_user_id: 1, org_id: 1, email: 'new@lab.org',
    });
    expect(JSON.parse(row.meta)).toEqual({ invitationId: 7, role: 'editor' });
    expect(querySync('SELECT COUNT(*) AS n FROM auth_events').rows[0].n).toBe(1);
  });

  it('defaults every optional field to null', () => {
    const row = recordAuthEvent({ type: 'org.created' });
    expect(row).toMatchObject({
      type: 'org.created', actor_user_id: null, org_id: null, email: null, meta: null,
    });
  });

  it('never throws: a failing insert logs and returns null', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // type is NOT NULL — this insert must fail, quietly.
      expect(recordAuthEvent({ type: null })).toBeNull();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[auth-events]'));
      expect(querySync('SELECT COUNT(*) AS n FROM auth_events').rows[0].n).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});
