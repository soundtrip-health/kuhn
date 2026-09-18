// Org administration (stories 010-003 member management, 011-002 invitations,
// 011-003 settings). Every route is owner-gated through requireOrgRole, which
// also enforces suspension and keeps unknown orgs non-leaking (404). Display
// name is NOT a settings key — PATCH /settings takes a flat body and updates
// organizations.name directly (db/org-settings.js documents this split); slug
// is immutable everywhere.

import { Router } from 'express';
import { querySync } from '../db.js';
import { requireOrgRole } from './guards.js';
import {
  ROLES,
  LastOwnerError,
  listOrgMembers,
  setMemberRole,
  removeMember,
} from '../db/orgs.js';
import {
  createInvitation,
  listOrgInvitations,
  revokeInvitation,
  inviteeIsMember,
} from '../db/invitations.js';
import {
  getOrgSettings,
  updateOrgSettings,
  validateSettingsPatch,
  SettingsValidationError,
} from '../db/org-settings.js';
import { recordAuthEvent } from '../db/auth-events.js';
import { resolvePendingRequestsFor } from '../db/access-requests.js';
import {
  getProjectAny,
  listDeletedOrgProjects,
  purgeProject,
  restoreProject,
} from '../db/projects.js';
import { sendInviteLink } from '../mailer.js';
import { cancelTenantJobs } from '../agents/tenancy.js';
import { log } from '../logger.js';
import { publishOrgEvent } from '../project-events.js';
import { StorageError, deleteProjectDir } from '../storage.js';
import { evictRoomsUnder } from '../yjs-websocket.js';

const router = Router();

// Same deliberately loose shape check as routes/auth.js.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invitation row → client shape: derived state, never the token hash. */
function publicInvitation(row) {
  const { token_hash, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// Members (story 010-003)
// ---------------------------------------------------------------------------

/** GET /api/orgs/:orgId/members — owner only; owners first, then by email. */
router.get('/api/orgs/:orgId/members', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  res.json({ members: await listOrgMembers(ctx.orgId) });
});

/**
 * PATCH /api/orgs/:orgId/members/:userId — body { role }. Demoting the last
 * owner → 409 { error, code: 'last_owner' }.
 */
router.patch('/api/orgs/:orgId/members/:userId', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) {
    res.status(400).json({ error: 'invalid user id' });
    return;
  }
  const role = req.body?.role;
  if (!ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    return;
  }
  try {
    const member = await setMemberRole(ctx.orgId, userId, role);
    if (!member) {
      res.status(404).json({ error: 'member not found' });
      return;
    }
    recordAuthEvent({
      type: 'member.role_changed',
      actorUserId: req.user.id,
      orgId: ctx.orgId,
      meta: { userId, role },
    });
    res.json({ member });
  } catch (err) {
    if (err instanceof LastOwnerError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

/**
 * DELETE /api/orgs/:orgId/members/:userId — remove a member. Removing the
 * last owner → 409 { error, code: 'last_owner' }.
 */
router.delete('/api/orgs/:orgId/members/:userId', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) {
    res.status(400).json({ error: 'invalid user id' });
    return;
  }
  try {
    if (!(await removeMember(ctx.orgId, userId))) {
      res.status(404).json({ error: 'member not found' });
      return;
    }
    recordAuthEvent({
      type: 'member.removed',
      actorUserId: req.user.id,
      orgId: ctx.orgId,
      meta: { userId },
    });
    // The removed member's runs in this org stop too (issue #118, T-28).
    await cancelTenantJobs({ orgId: ctx.orgId, userId }, 'removed');
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof LastOwnerError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Deleted projects (issue #190): restore or purge what an editor soft-deleted
// ---------------------------------------------------------------------------

/**
 * Resolve :id as a project of THIS org, deleted or not. The org comes from
 * the guard, never the client; a project of another org (or none) is a
 * non-leaking 404.
 * @returns {Promise<object|null>} the row, or null after responding
 */
async function orgProjectAny(req, res, orgId) {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ error: 'invalid project id' });
    return null;
  }
  const project = await getProjectAny(projectId);
  if (!project || project.org_id !== orgId) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  return project;
}

/** GET /api/orgs/:orgId/projects/deleted — soft-deleted projects, newest deletion first. */
router.get('/api/orgs/:orgId/projects/deleted', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  res.json({ projects: await listDeletedOrgProjects(ctx.orgId) });
});

/**
 * POST /api/orgs/:orgId/projects/:id/restore — undo a soft delete. Nothing
 * else was touched by the delete, so the project comes back whole: files,
 * history, comments, review links.
 */
router.post('/api/orgs/:orgId/projects/:id/restore', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const project = await orgProjectAny(req, res, ctx.orgId);
  if (!project) return;
  const restored = await restoreProject(project.id);
  if (!restored) {
    res.status(404).json({ error: 'project not found' }); // live, not deleted
    return;
  }
  recordAuthEvent({
    type: 'project.restored',
    actorUserId: req.user.id,
    orgId: ctx.orgId,
    meta: { projectId: project.id, name: project.name },
  });
  publishOrgEvent(ctx.orgId, {
    type: 'project', action: 'restored', projectId: project.id, name: project.name, userId: req.user.id,
  });
  log.info('project_restored', { projectId: project.id, orgId: ctx.orgId, name: project.name, userId: req.user.id });
  res.json({ project: restored });
});

/**
 * DELETE /api/orgs/:orgId/projects/:id — permanent delete. Only a project
 * that is already soft-deleted (409 otherwise: the two-step is the safety).
 * The workspace directory goes first, while the row still resolves it, then
 * the row — child rows cascade per schema.sql. Irreversible.
 */
router.delete('/api/orgs/:orgId/projects/:id', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const project = await orgProjectAny(req, res, ctx.orgId);
  if (!project) return;
  if (project.deleted_at == null) {
    res.status(409).json({
      error: 'project must be deleted before it can be permanently deleted',
      code: 'not_deleted',
    });
    return;
  }
  // Belt and braces: the soft delete already closed the rooms and cancelled
  // the runs; anything that slipped in since must not outlive the files.
  evictRoomsUnder(`project-${project.id}`, { closeConnections: true, closeReason: 'Project deleted' });
  await cancelTenantJobs({ orgId: ctx.orgId, projectId: project.id }, 'deleted');
  let dir;
  try {
    dir = await deleteProjectDir(project.id);
  } catch (err) {
    if (!(err instanceof StorageError)) throw err;
    dir = { removed: false, dir: null }; // no directory to remove
  }
  const removed = await purgeProject(project.id);
  recordAuthEvent({
    type: 'project.purged',
    actorUserId: req.user.id,
    orgId: ctx.orgId,
    meta: { projectId: project.id, name: project.name, dirRemoved: dir.removed },
  });
  publishOrgEvent(ctx.orgId, {
    type: 'project', action: 'purged', projectId: project.id, name: project.name, userId: req.user.id,
  });
  log.info('project_purged', {
    projectId: project.id, orgId: ctx.orgId, name: project.name, userId: req.user.id,
    rowRemoved: removed, dirRemoved: dir.removed, dir: dir.dir,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Invitations (story 011-002)
// ---------------------------------------------------------------------------

/** GET /api/orgs/:orgId/invitations — newest first, each with derived state. */
router.get('/api/orgs/:orgId/invitations', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  res.json({ invitations: listOrgInvitations(ctx.orgId).map(publicInvitation) });
});

/**
 * POST /api/orgs/:orgId/invitations — body { email, role }. Mints the token,
 * mails the verify link, 201 { invitation }. Already a member → 409 (a member
 * needs a role change, not an invitation).
 */
router.post('/api/orgs/:orgId/invitations', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'a valid email is required' });
    return;
  }
  const role = req.body?.role;
  if (!ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    return;
  }
  if (inviteeIsMember(ctx.orgId, email)) {
    res.status(409).json({ error: 'already a member of this organization' });
    return;
  }
  const { invitation, token } = createInvitation({
    orgId: ctx.orgId,
    email,
    role,
    invitedBy: req.user.id,
  });
  const verifyUrl = `${req.protocol}://${req.get('host')}/api/auth/verify?invite=${encodeURIComponent(token)}`;
  await sendInviteLink(email, verifyUrl, { orgName: ctx.org.name });
  // An owner inviting someone directly settles any queued access request from
  // that address (STH-35) — the super-admin queue should not still show work
  // an org owner has already done.
  resolvePendingRequestsFor(email, { decidedBy: req.user.id, invitationId: invitation.id });
  recordAuthEvent({
    type: 'invite.issued',
    actorUserId: req.user.id,
    orgId: ctx.orgId,
    email,
    meta: { invitationId: invitation.id, role },
  });
  res.status(201).json({ invitation: publicInvitation({ ...invitation, state: 'pending' }) });
});

/** DELETE /api/orgs/:orgId/invitations/:id — revoke a pending invitation. */
router.delete('/api/orgs/:orgId/invitations/:id', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid invitation id' });
    return;
  }
  // Missing, another org's, or already terminal all land here — non-leaking.
  if (!revokeInvitation(ctx.orgId, id)) {
    res.status(404).json({ error: 'invitation not found' });
    return;
  }
  recordAuthEvent({
    type: 'invite.revoked',
    actorUserId: req.user.id,
    orgId: ctx.orgId,
    meta: { invitationId: id },
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Settings (story 011-003)
// ---------------------------------------------------------------------------

/** GET /api/orgs/:orgId/settings — org identity + settings merged over defaults. */
router.get('/api/orgs/:orgId/settings', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const { id, name, slug, status } = ctx.org;
  res.json({ org: { id, name, slug, status }, settings: getOrgSettings(ctx.orgId) });
});

/**
 * PATCH /api/orgs/:orgId/settings — flat body { name?, ...knobs }. The whole
 * patch is validated before anything is written, so a bad knob can't
 * half-apply a rename. slug → 400 (immutable); unknown key or bad value →
 * 400 { error, field }.
 */
router.patch('/api/orgs/:orgId/settings', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const { name, ...patch } = req.body ?? {};
  if ('slug' in patch) {
    res.status(400).json({ error: 'slug is immutable', field: 'slug' });
    return;
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    res.status(400).json({ error: 'name must be a non-empty string', field: 'name' });
    return;
  }
  try {
    validateSettingsPatch(patch);
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }
  let orgName = ctx.org.name;
  if (name !== undefined && name.trim() !== ctx.org.name) {
    orgName = name.trim();
    querySync(
      `UPDATE organizations
       SET name = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = $1`,
      [ctx.orgId, orgName],
    );
    recordAuthEvent({
      type: 'org.renamed',
      actorUserId: req.user.id,
      orgId: ctx.orgId,
      meta: { from: ctx.org.name, to: orgName },
    });
  }
  const settings = Object.keys(patch).length > 0
    ? updateOrgSettings(ctx.orgId, patch)
    : getOrgSettings(ctx.orgId);
  res.json({
    org: { id: ctx.org.id, name: orgName, slug: ctx.org.slug, status: ctx.org.status },
    settings,
  });
});

export default router;
