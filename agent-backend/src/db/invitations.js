// Invitations (story 011-002): the door into an org. Same secret discipline
// as auth_tokens (db/auth.js): the DB stores only sha256(token), the raw
// token is returned exactly once at mint time for the emailed link, and
// redemption is a single atomic conditional UPDATE.
//
// State machine (a row is terminal once accepted, revoked, or expired):
//   issued ── redeem → accepted · revoke → revoked · time → expired (derived)

import { createHash, randomBytes } from 'node:crypto';
import { querySync, transaction } from '../db.js';
import { config } from '../config.js';
import { ROLES } from './orgs.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Derive the display state of an invitation row. */
export function invitationState(row) {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (row.expires_at <= new Date().toISOString()) return 'expired';
  return 'pending';
}

/**
 * Mint an invitation. Any prior PENDING invitation for the same (org, email)
 * is revoked in the same transaction — at most one live token per invitee per
 * org, so a role change re-invite can't be trumped by a stale link.
 * @returns {{ invitation: object, token: string }} token is the raw secret
 *   for the emailed link; only its hash is stored
 */
export function createInvitation({ orgId, email, role, invitedBy = null, ttlMs = config.auth.inviteTtlMs }) {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  const normalized = String(email).trim().toLowerCase();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const invitation = transaction(() => {
    querySync(
      `UPDATE invitations SET revoked_at = ${NOW}
       WHERE org_id = $1 AND email = $2
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at >= ${NOW}`,
      [orgId, normalized],
    );
    const { rows } = querySync(
      `INSERT INTO invitations (org_id, email, role, invited_by, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [orgId, normalized, role, invitedBy, sha256(token), expiresAt],
    );
    return rows[0];
  });
  return { invitation, token };
}

/** An org's invitations, newest first, each with a derived `state` field. */
export function listOrgInvitations(orgId) {
  const { rows } = querySync(
    'SELECT * FROM invitations WHERE org_id = $1 ORDER BY created_at DESC, id DESC',
    [orgId],
  );
  return rows.map((row) => ({ ...row, state: invitationState(row) }));
}

/**
 * Revoke a pending invitation. org_id is part of the guard so an owner can
 * only revoke their own org's invites.
 * @returns {boolean} false if missing or already terminal
 */
export function revokeInvitation(orgId, id) {
  const { rowCount } = querySync(
    `UPDATE invitations SET revoked_at = ${NOW}
     WHERE id = $1 AND org_id = $2
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at >= ${NOW}`,
    [id, orgId],
  );
  return rowCount > 0;
}

/**
 * Redeem an invitation token. Expiry is checked BEFORE org status — an
 * expired invite to a suspended org is dead either way, and reporting
 * 'suspended' would falsely promise the link works after an unsuspend. For a
 * live token the status check runs BEFORE the atomic accept, so a suspended
 * org refuses WITHOUT burning it — it redeems normally after an unsuspend.
 * The success shape carries the org row so the verify door can handle the
 * already-a-member path without another query.
 * @returns {{ ok: true, invitation: object, org: {id,name,slug,status} }
 *   | { ok: false, reason: 'missing'|'revoked'|'used'|'expired'|'suspended' }}
 */
export function redeemInvitation(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken) return { ok: false, reason: 'missing' };
  const hash = sha256(rawToken);
  const { rows } = querySync(
    `SELECT i.*, o.name AS org_name, o.slug AS org_slug, o.status AS org_status
     FROM invitations i JOIN organizations o ON o.id = i.org_id
     WHERE i.token_hash = $1`,
    [hash],
  );
  const found = rows[0];
  if (!found) return { ok: false, reason: 'missing' };
  if (found.revoked_at) return { ok: false, reason: 'revoked' };
  if (found.accepted_at) return { ok: false, reason: 'used' };
  if (found.expires_at <= new Date().toISOString()) return { ok: false, reason: 'expired' };
  if (found.org_status === 'suspended') return { ok: false, reason: 'suspended' };
  const { rows: accepted } = querySync(
    `UPDATE invitations SET accepted_at = ${NOW}
     WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL
       AND expires_at >= ${NOW}
     RETURNING *`,
    [hash],
  );
  if (!accepted[0]) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    invitation: accepted[0],
    org: { id: found.org_id, name: found.org_name, slug: found.org_slug, status: found.org_status },
  };
}

/**
 * Is the invitee's email already a member of the org? The invitation-create
 * route refuses with 409 when it is — a member needs a role change, not an
 * invitation.
 */
export function inviteeIsMember(orgId, email) {
  const normalized = String(email).trim().toLowerCase();
  const { rows } = querySync(
    `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1 AND lower(u.email) = $2`,
    [orgId, normalized],
  );
  return rows.length > 0;
}

/**
 * Grant a redeemed invitation's membership. ON CONFLICT DO NOTHING keeps an
 * existing member's role untouched — the already-a-member redemption path
 * marks the invitation accepted but never changes a role.
 * @returns {boolean} true if a membership was created, false if the user was
 *   already a member
 */
export function acceptInvitedMembership(userId, invitation) {
  const { rowCount } = querySync(
    `INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, org_id) DO NOTHING`,
    [userId, invitation.org_id, invitation.role],
  );
  return rowCount > 0;
}
