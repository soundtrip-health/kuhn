// Story 013: minimal project endpoints so the webapp can pick (or bootstrap)
// the active project. Story 005: project listing and creation are org-scoped to
// the session user; a project's org is set from the session, not the client.
// Full project lifecycle belongs to the PM agent (012).

import { Router } from 'express';
import { runSeedPipeline } from '../agents/seeding.js';
import { listProjectConversations } from '../db/conversation.js';
import { isMember, primaryOrgId } from '../db/orgs.js';
import {
  createProject,
  getProject,
  listProjectsForUser,
  setActiveDocument,
} from '../db/projects.js';
import { streamEvents } from './sse.js';

const router = Router();

const PROJECT_TYPES = ['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'];

/** GET /api/projects — the session user's projects across their orgs, oldest first */
router.get('/api/projects', async (req, res) => {
  const projects = await listProjectsForUser(req.user.id);
  res.json({ projects });
});

/**
 * POST /api/projects — body { name, projectType?, orgId? }
 * The org is the requested `orgId` (only if the user is a member) or the user's
 * primary org; it is never trusted blindly from the client.
 */
router.post('/api/projects', async (req, res) => {
  const { name, projectType = 'manuscript', orgId } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!PROJECT_TYPES.includes(projectType)) {
    res.status(400).json({ error: `projectType must be one of: ${PROJECT_TYPES.join(', ')}` });
    return;
  }

  let targetOrg = orgId != null ? Number(orgId) : null;
  if (targetOrg != null) {
    if (!(await isMember(req.user.id, targetOrg))) {
      res.status(403).json({ error: 'not a member of that organization' });
      return;
    }
  } else {
    targetOrg = await primaryOrgId(req.user.id);
  }
  if (targetOrg == null) {
    res.status(400).json({ error: 'no organization available for this user' });
    return;
  }

  const project = await createProject({ name, projectType, orgId: targetOrg });
  res.status(201).json({ project });
});

/**
 * Resolve a project the session user may access, or send the right error.
 * @returns {Promise<object|null>} the project row, or null after responding
 */
async function authorizeProject(req, res) {
  const project = await getProject(parseInt(req.params.id));
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  if (!(await isMember(req.user.id, project.org_id))) {
    res.status(404).json({ error: 'project not found' }); // don't leak existence
    return null;
  }
  return project;
}

/**
 * PUT /api/projects/:id/active-document — body { path }
 * Persist which document is open in this project (story 006), so reopening the
 * project restores it.
 */
router.put('/api/projects/:id/active-document', async (req, res) => {
  const project = await authorizeProject(req, res);
  if (!project) return;
  const { path } = req.body ?? {};
  if (!path || typeof path !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const config = await setActiveDocument(project.id, path);
  res.json({ config });
});

/**
 * POST /api/projects/:id/seed
 * Run the seeding pipeline (story 015): PM interview → RA + Advisor research
 * → Writer skeleton. Streams stage markers and agent events as SSE.
 */
router.post('/api/projects/:id/seed', async (req, res) => {
  const project = await authorizeProject(req, res);
  if (!project) return;
  await streamEvents(res, runSeedPipeline(project.id));
});

/**
 * GET /api/projects/:id/conversations?limit=
 * Recent top-level conversations with their user/assistant messages, newest
 * conversation first, for chat transcript restore (story 020).
 */
router.get('/api/projects/:id/conversations', async (req, res) => {
  const project = await authorizeProject(req, res);
  if (!project) return;
  const limit = req.query.limit != null ? parseInt(req.query.limit) : 20;
  const conversations = await listProjectConversations(project.id, { limit });
  res.json({ conversations });
});

export default router;
