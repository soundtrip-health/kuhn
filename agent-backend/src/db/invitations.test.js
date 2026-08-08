// Story 011-002: invitation lifecycle — mint (hash-only storage), single
// atomic redemption, revoke, derived expiry, suspended-org pre-check.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let inv;

const ORG = 1;
const INVITER = 1;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  inv = await import('./invitations.js');
});

beforeEach(() => {
  querySync('DELETE FROM invitations');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab')`);
  querySync(`INSERT INTO users (id, email) VALUES (${INVITER}, 'owner@lab.org')`);
});

const mint = (over = {}) => inv.createInvitation({
  orgId: ORG, email: 'new@lab.org', role: 'editor', invitedBy: INVITER, ...over,
});

describe('createInvitation', () => {
  it('returns the raw token once and stores only its hash', () => {
    const { invitation, token } = mint();
    expect(token).toBeTruthy();
    expect(invitation).toMatchObject({
      org_id: ORG, email: 'new@lab.org', role: 'editor', invited_by: INVITER,
      accepted_at: null, revoked_at: null,
    });
    expect(invitation.token_hash).not.toBe(token);
    expect(invitation.token_hash).not.toContain(token);
    // AC: a dumped hash cannot redeem.
    expect(inv.redeemInvitation(invitation.token_hash)).toEqual({ ok: false, reason: 'missing' });
  });

  it('normalizes the email and honors ttlMs', () => {
    const { invitation } = mint({ email: '  New@LAB.org ', ttlMs: 1000 });
    expect(invitation.email).toBe('new@lab.org');
    expect(new Date(invitation.expires_at).getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it('rejects an unknown role', () => {
    expect(() => mint({ role: 'member' })).toThrow(/unknown role/);
  });

  it('revokes prior pending invitations for the same org+email in the same transaction', () => {
    const first = mint({ role: 'viewer' });
    const other = mint({ email: 'someone-else@lab.org' });
    const second = mint({ role: 'editor' });

    // The stale token is dead; the fresh one redeems with the fresh role.
    expect(inv.redeemInvitation(first.token)).toEqual({ ok: false, reason: 'revoked' });
    const redeemed = inv.redeemInvitation(second.token);
    expect(redeemed.ok).toBe(true);
    expect(redeemed.invitation.role).toBe('editor');
    // Unrelated invitees are untouched.
    expect(inv.redeemInvitation(other.token).ok).toBe(true);
  });

  it('does not revoke accepted invitations when re-inviting', () => {
    const first = mint();
    expect(inv.redeemInvitation(first.token).ok).toBe(true);
    mint();
    expect(querySync(
      "SELECT COUNT(*) AS n FROM invitations WHERE accepted_at IS NOT NULL AND revoked_at IS NULL",
    ).rows[0].n).toBe(1);
  });
});

describe('redeemInvitation', () => {
  it('accepts exactly once: the second redemption reports used', () => {
    const { token } = mint();
    const first = inv.redeemInvitation(token);
    expect(first.ok).toBe(true);
    expect(first.invitation.accepted_at).toBeTruthy();
    expect(first.org).toEqual({ id: ORG, name: 'Lab', slug: 'lab', status: 'active' });
    expect(inv.redeemInvitation(token)).toEqual({ ok: false, reason: 'used' });
  });

  it('reports missing for garbage input', () => {
    expect(inv.redeemInvitation('nope')).toEqual({ ok: false, reason: 'missing' });
    expect(inv.redeemInvitation('')).toEqual({ ok: false, reason: 'missing' });
    expect(inv.redeemInvitation(undefined)).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports expired without writing anything', () => {
    const { token, invitation } = mint();
    querySync('UPDATE invitations SET expires_at = $1 WHERE id = $2',
      ['2020-01-01T00:00:00.000Z', invitation.id]);
    expect(inv.redeemInvitation(token)).toEqual({ ok: false, reason: 'expired' });
    expect(querySync('SELECT accepted_at FROM invitations WHERE id = $1', [invitation.id]).rows)
      .toEqual([{ accepted_at: null }]);
  });

  it('suspended org refuses BEFORE the accept — the token is not burned', () => {
    const { token } = mint();
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG}`);
    expect(inv.redeemInvitation(token)).toEqual({ ok: false, reason: 'suspended' });
    expect(querySync('SELECT accepted_at FROM invitations').rows).toEqual([{ accepted_at: null }]);
    // Unsuspend → the same link works.
    querySync(`UPDATE organizations SET status = 'active' WHERE id = ${ORG}`);
    expect(inv.redeemInvitation(token).ok).toBe(true);
  });

  it('an EXPIRED invite to a suspended org reports expired, not suspended', () => {
    // The suspended copy says "the link stays valid" — untrue for expired rows,
    // so expiry must win the check order.
    const { token, invitation } = mint();
    querySync('UPDATE invitations SET expires_at = $1 WHERE id = $2',
      ['2020-01-01T00:00:00.000Z', invitation.id]);
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG}`);
    expect(inv.redeemInvitation(token)).toEqual({ ok: false, reason: 'expired' });
    // Unsuspending changes nothing — the row is terminal.
    querySync(`UPDATE organizations SET status = 'active' WHERE id = ${ORG}`);
    expect(inv.redeemInvitation(token)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('inviteeIsMember / acceptInvitedMembership', () => {
  it('inviteeIsMember matches by normalized email within the org only', () => {
    querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${INVITER}, ${ORG}, 'owner')`);
    expect(inv.inviteeIsMember(ORG, '  Owner@LAB.org ')).toBe(true);
    expect(inv.inviteeIsMember(ORG, 'new@lab.org')).toBe(false);
    expect(inv.inviteeIsMember(999, 'owner@lab.org')).toBe(false);
  });

  it('acceptInvitedMembership grants the invited role once and never changes an existing one', () => {
    querySync("INSERT INTO users (id, email) VALUES (2, 'new@lab.org')");
    const { invitation } = mint({ role: 'viewer' });
    expect(inv.acceptInvitedMembership(2, invitation)).toBe(true);
    expect(querySync(
      `SELECT role FROM memberships WHERE user_id = 2 AND org_id = ${ORG}`,
    ).rows).toEqual([{ role: 'viewer' }]);
    // Already a member: no-op, role untouched, reported false.
    const upgrade = mint({ role: 'owner' });
    expect(inv.acceptInvitedMembership(2, upgrade.invitation)).toBe(false);
    expect(querySync(
      `SELECT role FROM memberships WHERE user_id = 2 AND org_id = ${ORG}`,
    ).rows).toEqual([{ role: 'viewer' }]);
  });
});

describe('revokeInvitation / listOrgInvitations', () => {
  it('revoke kills a pending invite and reports terminal states honestly', () => {
    const { invitation, token } = mint();
    expect(inv.revokeInvitation(ORG, invitation.id)).toBe(true);
    expect(inv.redeemInvitation(token)).toEqual({ ok: false, reason: 'revoked' });
    // Already-terminal → false; wrong org → false.
    expect(inv.revokeInvitation(ORG, invitation.id)).toBe(false);
    const second = mint();
    expect(inv.revokeInvitation(999, second.invitation.id)).toBe(false);
  });

  it('list derives state per row, newest first', () => {
    const revoked = mint({ email: 'a@lab.org' });
    inv.revokeInvitation(ORG, revoked.invitation.id);
    const accepted = mint({ email: 'b@lab.org' });
    inv.redeemInvitation(accepted.token);
    const expired = mint({ email: 'c@lab.org' });
    querySync('UPDATE invitations SET expires_at = $1 WHERE id = $2',
      ['2020-01-01T00:00:00.000Z', expired.invitation.id]);
    mint({ email: 'd@lab.org' });

    const list = inv.listOrgInvitations(ORG);
    const byEmail = Object.fromEntries(list.map((r) => [r.email, r.state]));
    expect(byEmail).toEqual({
      'a@lab.org': 'revoked', 'b@lab.org': 'accepted',
      'c@lab.org': 'expired', 'd@lab.org': 'pending',
    });
    expect(list[0].email).toBe('d@lab.org');
  });
});
