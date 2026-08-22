// Access requests (STH-35): the queue that replaced self-registration.
//
// Sign-in is invite-only — LLM agents and sandboxed execution are too costly
// to hand to whoever types an email into the login box. An address with no
// membership and no pending invitation gets a row here instead of a user
// account, and a super-admin turns it into an ordinary invitation (or denies
// it). A row carries no secret and grants nothing on its own.
//
// Synchronous (querySync), matching the other db/ modules.

import { querySync, transaction } from '../db.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'denied'];

/** Longest note we keep — the field is a self-introduction, not a document. */
export const NOTE_MAX = 500;

// Client shape (webapp api.ts AccessRequest): the row plus the decider's
// email. LEFT JOIN on users — decided_by is SET NULL when that account goes
// away, and the decision must survive it.
const JOINED_SELECT = `
  SELECT ar.id, ar.email, ar.note, ar.status, ar.request_count,
         ar.last_requested_at, ar.decided_by, u.email AS decided_by_email,
         ar.decided_at, ar.decision_note, ar.invitation_id, ar.created_at
  FROM access_requests ar
  LEFT JOIN users u ON u.id = ar.decided_by`;

/** Trim a caller-supplied note to something storable, or null. */
function cleanNote(note) {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim().slice(0, NOTE_MAX);
  return trimmed || null;
}

/**
 * File (or re-file) a request for access. At most one PENDING row per email:
 * asking again bumps request_count/last_requested_at instead of queueing a
 * duplicate, and fills in a note if the first attempt had none. A decided row
 * is history — a later request opens a fresh one.
 * @returns {{ request: object, existing: boolean }}
 */
export function recordAccessRequest({ email, note = null }) {
  const normalized = String(email).trim().toLowerCase();
  const cleaned = cleanNote(note);
  return transaction(() => {
    const { rows: pending } = querySync(
      "SELECT id FROM access_requests WHERE email = $1 AND status = 'pending'",
      [normalized],
    );
    if (pending[0]) {
      querySync(
        `UPDATE access_requests
         SET request_count = request_count + 1,
             last_requested_at = ${NOW},
             note = COALESCE(note, $2)
         WHERE id = $1`,
        [pending[0].id, cleaned],
      );
      return { request: getAccessRequest(pending[0].id), existing: true };
    }
    const { rows } = querySync(
      'INSERT INTO access_requests (email, note) VALUES ($1, $2) RETURNING id',
      [normalized, cleaned],
    );
    return { request: getAccessRequest(rows[0].id), existing: false };
  });
}

/** The queue, optionally filtered by status; most recently asked first. */
export function listAccessRequests({ status = null } = {}) {
  const { rows } = querySync(
    `${JOINED_SELECT}
     WHERE ($1 IS NULL OR ar.status = $1)
     ORDER BY ar.last_requested_at DESC, ar.id DESC`,
    [status],
  );
  return rows;
}

/** One request by id, or undefined. */
export function getAccessRequest(id) {
  const { rows } = querySync(`${JOINED_SELECT} WHERE ar.id = $1`, [id]);
  return rows[0];
}

/**
 * Settle a pending request. The status guard is part of the UPDATE, so two
 * admins deciding the same row concurrently cannot both win — the loser gets
 * null and the caller reports the conflict rather than sending a second
 * invitation.
 * @param {'approved'|'denied'} status
 * @returns {object|null} the settled row, or null if it was already decided
 */
export function decideAccessRequest(id, status, { decidedBy = null, note = null, invitationId = null } = {}) {
  if (status !== 'approved' && status !== 'denied') {
    throw new Error(`unknown decision: ${status}`);
  }
  return transaction(() => {
    const { rowCount } = querySync(
      `UPDATE access_requests
       SET status = $2, decided_by = $3, decided_at = ${NOW},
           decision_note = $4, invitation_id = $5
       WHERE id = $1 AND status = 'pending'`,
      [id, status, decidedBy, cleanNote(note), invitationId],
    );
    return rowCount > 0 ? getAccessRequest(id) : null;
  });
}

/**
 * Close any pending request for an email without a decision trail — used when
 * the address becomes a member by another route (a direct invitation from an
 * org owner), so the queue does not keep showing work that is already done.
 * @returns {number} rows closed
 */
export function resolvePendingRequestsFor(email, { decidedBy = null, invitationId = null } = {}) {
  const normalized = String(email).trim().toLowerCase();
  const { rowCount } = querySync(
    `UPDATE access_requests
     SET status = 'approved', decided_by = $2, decided_at = ${NOW},
         decision_note = 'Invited directly', invitation_id = COALESCE($3, invitation_id)
     WHERE email = $1 AND status = 'pending'`,
    [normalized, decidedBy, invitationId],
  );
  return rowCount;
}
