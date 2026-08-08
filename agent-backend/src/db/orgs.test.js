// Story 010-003 / epic 011: the tenancy chokepoint and member management.
// Real in-memory SQLite — the role/suspension decisions are SQL.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let orgs;

const OWNER = 1;
const EDITOR = 2;
const VIEWER = 3;
const OUTSIDER = 4;
const ORG = 1;
const SUSPENDED_ORG = 2;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  orgs = await import('./orgs.js');
});

beforeEach(() => {
  querySync('DELETE FROM memberships');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync(`INSERT INTO organizations (id, name, slug, settings) VALUES
    (${ORG}, 'Lab', 'lab', '{"promotion_policy":"direct"}')`);
  querySync(`INSERT INTO organizations (id, name, slug, status) VALUES
    (${SUSPENDED_ORG}, 'Frozen', 'frozen', 'suspended')`);
  querySync(`INSERT INTO users (id, email) VALUES
    (${OWNER}, 'owner@lab.org'), (${EDITOR}, 'editor@lab.org'),
    (${VIEWER}, 'viewer@lab.org'), (${OUTSIDER}, 'outsider@lab.org')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES
    (${OWNER}, ${ORG}, 'owner'), (${EDITOR}, ${ORG}, 'editor'), (${VIEWER}, ${ORG}, 'viewer'),
    (${OWNER}, ${SUSPENDED_ORG}, 'owner')`);
});

describe('checkOrgAccess — the tenancy chokepoint', () => {
  it('refuses non-members and unknown orgs as not-member (routes 404 non-leaking)', async () => {
    expect(await orgs.checkOrgAccess(OUTSIDER, ORG)).toEqual({ ok: false, reason: 'not-member' });
    expect(await orgs.checkOrgAccess(OWNER, 999)).toEqual({ ok: false, reason: 'not-member' });
    // A non-member of a suspended org is still a stranger: not-member, not suspended.
    expect(await orgs.checkOrgAccess(OUTSIDER, SUSPENDED_ORG))
      .toEqual({ ok: false, reason: 'not-member' });
  });

  it('enforces the viewer < editor < owner rank against the threshold', async () => {
    expect((await orgs.checkOrgAccess(VIEWER, ORG, 'viewer'))).toMatchObject({ ok: true, role: 'viewer' });
    expect(await orgs.checkOrgAccess(VIEWER, ORG, 'editor')).toEqual({ ok: false, reason: 'role', role: 'viewer' });
    expect(await orgs.checkOrgAccess(VIEWER, ORG, 'owner')).toEqual({ ok: false, reason: 'role', role: 'viewer' });
    expect((await orgs.checkOrgAccess(EDITOR, ORG, 'editor'))).toMatchObject({ ok: true, role: 'editor' });
    expect(await orgs.checkOrgAccess(EDITOR, ORG, 'owner')).toEqual({ ok: false, reason: 'role', role: 'editor' });
    expect((await orgs.checkOrgAccess(OWNER, ORG, 'owner'))).toMatchObject({ ok: true, role: 'owner' });
    await expect(orgs.checkOrgAccess(OWNER, ORG, 'admin')).rejects.toThrow(/unknown role threshold/);
  });

  it('returns the org row with parsed settings on success', async () => {
    const access = await orgs.checkOrgAccess(EDITOR, ORG, 'viewer');
    expect(access.org).toEqual({
      id: ORG, name: 'Lab', slug: 'lab', status: 'active',
      settings: { promotion_policy: 'direct' },
    });
  });

  it('refuses every member of a suspended org, whatever their role', async () => {
    expect(await orgs.checkOrgAccess(OWNER, SUSPENDED_ORG, 'viewer'))
      .toEqual({ ok: false, reason: 'suspended', role: 'owner' });
    expect(await orgs.checkOrgAccess(OWNER, SUSPENDED_ORG, 'owner'))
      .toEqual({ ok: false, reason: 'suspended', role: 'owner' });
  });

  it('never consults is_superadmin: a flagged non-member is a stranger', async () => {
    querySync(`UPDATE users SET is_superadmin = 1 WHERE id = ${OUTSIDER}`);
    expect(await orgs.checkOrgAccess(OUTSIDER, ORG)).toEqual({ ok: false, reason: 'not-member' });
  });
});

describe('isMember (rewired through the chokepoint)', () => {
  it('is true for any active-org member, false for outsiders', async () => {
    expect(await orgs.isMember(VIEWER, ORG)).toBe(true);
    expect(await orgs.isMember(OUTSIDER, ORG)).toBe(false);
  });

  it('now also refuses suspended orgs', async () => {
    expect(await orgs.isMember(OWNER, SUSPENDED_ORG)).toBe(false);
  });
});

describe('listUserOrgs / listOrgMembers', () => {
  it('listUserOrgs carries role and status', async () => {
    const rows = await orgs.listUserOrgs(OWNER);
    expect(rows).toEqual([
      expect.objectContaining({ id: ORG, slug: 'lab', role: 'owner', status: 'active' }),
      expect.objectContaining({ id: SUSPENDED_ORG, slug: 'frozen', role: 'owner', status: 'suspended' }),
    ]);
  });

  it('listOrgMembers lists owners first, then by email', async () => {
    const rows = await orgs.listOrgMembers(ORG);
    expect(rows.map((r) => [r.email, r.role])).toEqual([
      ['owner@lab.org', 'owner'],
      ['editor@lab.org', 'editor'],
      ['viewer@lab.org', 'viewer'],
    ]);
    expect(rows[0]).toMatchObject({ user_id: OWNER, display_name: null });
    expect(rows[0].created_at).toBeTruthy();
  });
});

describe('setMemberRole / removeMember — the last-owner invariant', () => {
  it('changes a role and returns the updated row', async () => {
    const row = await orgs.setMemberRole(ORG, EDITOR, 'viewer');
    expect(row).toMatchObject({ user_id: EDITOR, org_id: ORG, role: 'viewer' });
  });

  it('returns null / false for a non-member', async () => {
    expect(await orgs.setMemberRole(ORG, OUTSIDER, 'editor')).toBeNull();
    expect(await orgs.removeMember(ORG, OUTSIDER)).toBe(false);
  });

  it('rejects an unknown role before touching the row', async () => {
    await expect(orgs.setMemberRole(ORG, EDITOR, 'member')).rejects.toThrow(/unknown role/);
  });

  it('refuses to demote or remove the last owner (code last_owner)', async () => {
    await expect(orgs.setMemberRole(ORG, OWNER, 'editor')).rejects.toThrow(orgs.LastOwnerError);
    await expect(orgs.removeMember(ORG, OWNER)).rejects.toMatchObject({ code: 'last_owner' });
    // The org still has its owner.
    expect(querySync(
      `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ${ORG} AND role = 'owner'`,
    ).rows[0].n).toBe(1);
  });

  it('allows demotion/removal once a second owner exists', async () => {
    await orgs.setMemberRole(ORG, EDITOR, 'owner');
    expect(await orgs.setMemberRole(ORG, OWNER, 'editor')).toMatchObject({ role: 'editor' });
    expect(await orgs.removeMember(ORG, OWNER)).toBe(true);
  });
});

describe('createOrg', () => {
  it('with a userId, makes them owner in the same transaction', async () => {
    const org = await orgs.createOrg({ name: 'New Lab', slug: 'new-lab', userId: EDITOR });
    expect(org).toMatchObject({ name: 'New Lab', slug: 'new-lab', status: 'active', role: 'owner' });
    expect((await orgs.checkOrgAccess(EDITOR, org.id, 'owner')).ok).toBe(true);
  });

  it('with no userId (super-admin creation), grants NOBODY access', async () => {
    const org = await orgs.createOrg({ name: 'Ownerless', slug: 'ownerless' });
    expect(org.role).toBeUndefined();
    expect(querySync(
      'SELECT COUNT(*) AS n FROM memberships WHERE org_id = $1', [org.id],
    ).rows[0].n).toBe(0);
  });
});
