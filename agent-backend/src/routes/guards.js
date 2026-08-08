// Route-layer tenancy guards (story 010-003). Express-facing wrappers around
// the db/orgs.js chokepoint with the codebase's established error discipline:
// 404 non-leaking for missing/non-member (projects.js, org-library.js), 403
// for an insufficient role or a suspended org. There is deliberately NO
// dev-mode bypass here — dev ergonomics come from the seeded dev user being
// owner of the default org and dev auto-join (session.js).

import { checkOrgAccess } from '../db/orgs.js';
import { getProject } from '../db/projects.js';

function sendRefusal(res, reason, minRole, notFoundError) {
  if (reason === 'not-member') res.status(404).json({ error: notFoundError });
  else if (reason === 'suspended') res.status(403).json({ error: 'organization suspended' });
  else res.status(403).json({ error: `requires ${minRole} role` });
}

/**
 * Resolve a project by raw id (params OR body value) and require minRole in
 * its org. Sends the response itself on failure and returns null. Stamps
 * req.orgRole on success so handlers that branch on role don't re-query.
 * 400 non-numeric id · 404 {error:'project not found'} for missing project or
 * non-member · 403 {error:'organization suspended'} · 403 {error:'requires
 * <minRole> role'}.
 * @returns {Promise<object|null>} the project row (has .org_id), or null
 */
export async function requireProjectRole(req, res, projectIdRaw, minRole) {
  const projectId = Number(projectIdRaw);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ error: 'invalid project id' });
    return null;
  }
  const project = await getProject(projectId);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  const access = await checkOrgAccess(req.user.id, project.org_id, minRole);
  if (!access.ok) {
    sendRefusal(res, access.reason, minRole, 'project not found');
    return null;
  }
  req.orgRole = access.role;
  return project;
}

/**
 * Same for org-scoped routes. 404 {error:'organization not found'}
 * non-leaking for unknown orgs and non-members.
 * @returns {Promise<{orgId: number, role: string, org: object}|null>}
 */
export async function requireOrgRole(req, res, orgIdRaw, minRole) {
  const orgId = Number(orgIdRaw);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ error: 'invalid organization id' });
    return null;
  }
  const access = await checkOrgAccess(req.user.id, orgId, minRole);
  if (!access.ok) {
    sendRefusal(res, access.reason, minRole, 'organization not found');
    return null;
  }
  req.orgRole = access.role;
  return { orgId, role: access.role, org: access.org };
}

/**
 * Gate a /api/admin route on the platform flag (story 011-001). This is the
 * ONLY guard that reads is_superadmin — tenancy guards never do.
 * @returns {boolean} true to proceed; false after sending the 403
 */
export function requireSuperadmin(req, res) {
  if (req.user?.is_superadmin) return true;
  res.status(403).json({ error: 'super-admin required' });
  return false;
}
