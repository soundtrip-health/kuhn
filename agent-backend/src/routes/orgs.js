// Organization endpoints (story 005): list the session user's orgs, create an
// org (making the user its owner), and list an org's projects. Identity comes
// from the session middleware (req.user); membership is enforced on every read.

import { Router } from 'express';
import { createOrg, isMember, listUserOrgs } from '../db/orgs.js';
import { listOrgProjects } from '../db/projects.js';

const router = Router();

/** A url-safe slug from a name; callers may also pass one explicitly. */
function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

/** GET /api/orgs — the current user's organizations, with their role. */
router.get('/api/orgs', async (req, res) => {
  const orgs = await listUserOrgs(req.user.id);
  res.json({ orgs });
});

/** POST /api/orgs — body { name, slug? } — create an org owned by the user. */
router.post('/api/orgs', async (req, res) => {
  const { name, slug } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const finalSlug = slugify(slug || name);
  if (!finalSlug) {
    res.status(400).json({ error: 'name must contain at least one letter or number' });
    return;
  }
  try {
    const org = await createOrg({ name, slug: finalSlug, userId: req.user.id });
    res.status(201).json({ org });
  } catch (err) {
    // Unique-violation on slug → readable 409 rather than a generic 500.
    if (err.code === '23505') {
      res.status(409).json({ error: `an organization with slug "${finalSlug}" already exists` });
      return;
    }
    throw err;
  }
});

/** GET /api/orgs/:id/projects — projects in an org the user belongs to. */
router.get('/api/orgs/:id/projects', async (req, res) => {
  const orgId = parseInt(req.params.id);
  if (!(await isMember(req.user.id, orgId))) {
    res.status(404).json({ error: 'organization not found' });
    return;
  }
  const projects = await listOrgProjects(orgId);
  res.json({ projects });
});

export default router;
