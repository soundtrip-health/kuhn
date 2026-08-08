// Auth/audit event stub (stories 011-001/002 AC5; forward-compatible with
// 010-005's real audit story). Append-only; never read on any hot path.
// Types are the fixed enum in the tenancy plan §4.4: org.created, org.renamed,
// org.suspended, org.unsuspended, invite.issued, invite.redeemed,
// invite.revoked, member.role_changed, member.removed, promotion.approved,
// promotion.rejected.

import { querySync } from '../db.js';

/**
 * Record one auth/admin event. Synchronous and non-throwing on purpose: an
 * audit-stub failure must never fail the action it records.
 * @returns {object|null} the inserted row, or null if the insert failed
 */
export function recordAuthEvent({ type, actorUserId = null, orgId = null, email = null, meta = null }) {
  try {
    const { rows } = querySync(
      `INSERT INTO auth_events (type, actor_user_id, org_id, email, meta)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [type, actorUserId, orgId, email, meta == null ? null : JSON.stringify(meta)],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error(`[auth-events] Failed to record ${type}: ${err.message}`);
    return null;
  }
}
