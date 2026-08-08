// Organization endpoints. GET /api/orgs lists the session user's orgs (story
// 005); org creation and the /api/admin surface are super-admin only (story
// 011-001): the platform operator provisions orgs, and — the invariant — gets
// NO access to their content unless explicitly made a member. The optional
// ownerEmail names the first admin: an existing user (including the caller)
// becomes owner directly, anyone else receives an owner-role invitation.

import { Router } from 'express';
import { query, querySync } from '../db.js';
import { createOrg, listUserOrgs } from '../db/orgs.js';
import { listOrgProjects } from '../db/projects.js';
import { createInvitation } from '../db/invitations.js';
import { recordAuthEvent } from '../db/auth-events.js';
import { requireOrgRole, requireSuperadmin } from './guards.js';
import { sendInviteLink } from '../mailer.js';

const router = Router();

// Same deliberately loose shape check as routes/auth.js and org-admin.js.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ADMIN_ORG_COLUMNS = `o.id, o.name, o.slug, o.status,
  (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS member_count,
  o.created_at`;

/** A url-safe slug from a name; callers may also pass one explicitly. */
function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

/**
 * better-sqlite3 surfaces a duplicate slug as SQLITE_CONSTRAINT_UNIQUE
 * (verified empirically in orgs.test.js); '23505' is the retired node-postgres
 * code, kept only as a harmless belt against stray legacy callers.
 */
function isUniqueViolation(err) {
  return err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === '23505';
}

/** GET /api/orgs — the current user's organizations, with role and status. */
router.get('/api/orgs', async (req, res) => {
  const orgs = await listUserOrgs(req.user.id);
  res.json({ orgs });
});

/**
 * POST /api/orgs — super-admin only — body { name, slug?, ownerEmail? }.
 * ownerEmail of an existing user → direct owner membership; unknown email →
 * the org is created ownerless and an owner-role invitation goes out; no
 * ownerEmail → ownerless, full stop. 201 { org, member } where member reports
 * whether the CALLER ended up a member (ownerEmail was their own account).
 */
router.post('/api/orgs', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const { name, slug, ownerEmail } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const finalSlug = slugify(slug || name);
  if (!finalSlug) {
    res.status(400).json({ error: 'name must contain at least one letter or number' });
    return;
  }
  let email = null;
  if (ownerEmail !== undefined && ownerEmail !== null && ownerEmail !== '') {
    email = typeof ownerEmail === 'string' ? ownerEmail.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'ownerEmail must be a valid email address' });
      return;
    }
  }
  // MB1: an EXISTING user (including the caller) becomes owner directly —
  // lookup only, never get-or-create; an unknown email must go the
  // invitation route so nobody is enrolled without accepting.
  const ownerUser = email
    ? (querySync('SELECT id FROM users WHERE lower(email) = $1', [email]).rows[0] ?? null)
    : null;

  let org;
  try {
    org = await createOrg({ name, slug: finalSlug, userId: ownerUser?.id ?? null });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `an organization with slug "${finalSlug}" already exists` });
      return;
    }
    throw err;
  }
  recordAuthEvent({
    type: 'org.created',
    actorUserId: req.user.id,
    orgId: org.id,
    meta: { name: org.name, slug: org.slug, ownerEmail: email },
  });

  if (email && !ownerUser) {
    const { invitation, token } = createInvitation({
      orgId: org.id,
      email,
      role: 'owner',
      invitedBy: req.user.id,
    });
    const verifyUrl = `${req.protocol}://${req.get('host')}/api/auth/verify?invite=${encodeURIComponent(token)}`;
    await sendInviteLink(email, verifyUrl, { orgName: org.name });
    recordAuthEvent({
      type: 'invite.issued',
      actorUserId: req.user.id,
      orgId: org.id,
      email,
      meta: { invitationId: invitation.id, role: 'owner' },
    });
  }

  // createOrg stamps role:'owner' when a membership was created — that role
  // belongs to ownerUser, so only surface it when the caller IS that user.
  const member = ownerUser != null && ownerUser.id === req.user.id;
  const { role, ...bare } = org;
  res.status(201).json({ org: member ? { ...bare, role } : bare, member });
});

/** GET /api/admin/orgs — super-admin only — every org, with member counts. */
router.get('/api/admin/orgs', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const { rows } = await query(
    `SELECT ${ADMIN_ORG_COLUMNS} FROM organizations o ORDER BY o.id`,
  );
  res.json({ orgs: rows });
});

/**
 * PATCH /api/admin/orgs/:id — super-admin only — { name? } and/or
 * { status: 'active'|'suspended' }. Deliberately ignores org suspension:
 * this route IS how an org gets unsuspended. 404 for an unknown org (no
 * membership semantics here — super-admins see the whole platform).
 */
router.patch('/api/admin/orgs/:id', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const orgId = Number(req.params.id);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ error: 'invalid organization id' });
    return;
  }
  const { name, status } = req.body ?? {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    res.status(400).json({ error: 'name must be a non-empty string', field: 'name' });
    return;
  }
  if (status !== undefined && status !== 'active' && status !== 'suspended') {
    res.status(400).json({ error: "status must be 'active' or 'suspended'", field: 'status' });
    return;
  }
  if (name === undefined && status === undefined) {
    res.status(400).json({ error: 'nothing to update: pass name and/or status' });
    return;
  }
  const { rows } = querySync('SELECT id, name, status FROM organizations WHERE id = $1', [orgId]);
  const current = rows[0];
  if (!current) {
    res.status(404).json({ error: 'organization not found' });
    return;
  }
  const nextName = name !== undefined ? name.trim() : current.name;
  const nextStatus = status !== undefined ? status : current.status;
  querySync(
    `UPDATE organizations
     SET name = $2, status = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = $1`,
    [orgId, nextName, nextStatus],
  );
  if (nextName !== current.name) {
    recordAuthEvent({
      type: 'org.renamed',
      actorUserId: req.user.id,
      orgId,
      meta: { from: current.name, to: nextName },
    });
  }
  if (nextStatus !== current.status) {
    recordAuthEvent({
      type: nextStatus === 'suspended' ? 'org.suspended' : 'org.unsuspended',
      actorUserId: req.user.id,
      orgId,
    });
  }
  const { rows: updated } = querySync(
    `SELECT ${ADMIN_ORG_COLUMNS} FROM organizations o WHERE o.id = $1`,
    [orgId],
  );
  res.json({ org: updated[0] });
});

/** GET /api/orgs/:id/projects — projects in an org the user belongs to. */
router.get('/api/orgs/:id/projects', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.id, 'viewer');
  if (!ctx) return;
  const projects = await listOrgProjects(ctx.orgId);
  res.json({ projects });
});

export default router;
