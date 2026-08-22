// The access-request queue (STH-35) — super-admin only.
//
// Self-registration is gone, so an uninvited address parks here instead of
// becoming a user. Approving is not a bespoke grant: it mints an ORDINARY
// invitation through the story 011-002 machinery, so the invitation stays the
// single door into an org and every existing guarantee (single-use token,
// role check, suspension refusal, audit event) comes along unchanged.
//
// Requests are platform-level — an unknown email belongs to no org yet — so
// these live on /api/admin behind requireSuperadmin, not behind requireOrgRole.

import { Router } from 'express';
import { querySync } from '../db.js';
import { requireSuperadmin } from './guards.js';
import {
  ACCESS_REQUEST_STATUSES,
  decideAccessRequest,
  getAccessRequest,
  listAccessRequests,
} from '../db/access-requests.js';
import { createInvitation, inviteeIsMember } from '../db/invitations.js';
import { recordAuthEvent } from '../db/auth-events.js';
import { ROLES } from '../db/orgs.js';
import { sendInviteLink } from '../mailer.js';

const router = Router();

/**
 * GET /api/admin/access-requests?status=pending — the queue, most recently
 * asked first. No status filter returns every row (decided ones are history).
 */
router.get('/api/admin/access-requests', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  if (status && !ACCESS_REQUEST_STATUSES.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${ACCESS_REQUEST_STATUSES.join(', ')}` });
    return;
  }
  res.json({ requests: listAccessRequests({ status }) });
});

/**
 * POST /api/admin/access-requests/:id/approve — body { orgId, role, note? }.
 * Mints and mails an invitation, then settles the request. The decision is
 * recorded LAST and its status guard is the concurrency control: two admins
 * racing the same row both mail an invitation, but the second one's decide
 * returns null and it answers 409 rather than double-settling. (Two
 * invitations to the same org/email is already safe — createInvitation
 * revokes the earlier pending token.)
 */
router.post('/api/admin/access-requests/:id/approve', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const request = getAccessRequest(Number(req.params.id));
  if (!request) {
    res.status(404).json({ error: 'access request not found' });
    return;
  }
  if (request.status !== 'pending') {
    res.status(409).json({ error: `access request already ${request.status}` });
    return;
  }

  const orgId = Number(req.body?.orgId);
  const { rows: orgRows } = querySync(
    'SELECT id, name, status FROM organizations WHERE id = $1',
    [orgId],
  );
  const org = orgRows[0];
  if (!org) {
    res.status(400).json({ error: 'unknown organization' });
    return;
  }
  if (org.status === 'suspended') {
    res.status(409).json({ error: 'organization is suspended' });
    return;
  }
  const role = req.body?.role;
  if (!ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    return;
  }
  if (inviteeIsMember(org.id, request.email)) {
    res.status(409).json({ error: 'already a member of that organization' });
    return;
  }

  const { invitation, token } = createInvitation({
    orgId: org.id,
    email: request.email,
    role,
    invitedBy: req.user.id,
  });
  const verifyUrl = `${req.protocol}://${req.get('host')}/api/auth/verify?invite=${encodeURIComponent(token)}`;
  await sendInviteLink(request.email, verifyUrl, { orgName: org.name });

  const decided = decideAccessRequest(request.id, 'approved', {
    decidedBy: req.user.id,
    note: req.body?.note,
    invitationId: invitation.id,
  });
  if (!decided) {
    res.status(409).json({ error: 'access request was already decided' });
    return;
  }
  recordAuthEvent({
    type: 'invite.issued',
    actorUserId: req.user.id,
    orgId: org.id,
    email: request.email,
    meta: { invitationId: invitation.id, role, accessRequestId: request.id },
  });
  recordAuthEvent({
    type: 'access.approved',
    actorUserId: req.user.id,
    orgId: org.id,
    email: request.email,
    meta: { accessRequestId: request.id, invitationId: invitation.id, role },
  });
  res.json({ request: decided });
});

/**
 * POST /api/admin/access-requests/:id/deny — body { note? }. Settles the row
 * without notifying the requester: the "we queued your request" mail already
 * promised nothing, and a denial notice only tells someone probing the login
 * box that their address was looked at. Deciding frees the address to ask
 * again later, and the denied row stays as history.
 */
router.post('/api/admin/access-requests/:id/deny', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const id = Number(req.params.id);
  if (!getAccessRequest(id)) {
    res.status(404).json({ error: 'access request not found' });
    return;
  }
  const decided = decideAccessRequest(id, 'denied', {
    decidedBy: req.user.id,
    note: req.body?.note,
  });
  if (!decided) {
    res.status(409).json({ error: 'access request was already decided' });
    return;
  }
  recordAuthEvent({
    type: 'access.denied',
    actorUserId: req.user.id,
    email: decided.email,
    meta: { accessRequestId: id, at: 'review' },
  });
  res.json({ request: decided });
});

export default router;
