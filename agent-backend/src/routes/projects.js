// Story 013: minimal project endpoints so the webapp can pick (or bootstrap)
// the active project. Full project lifecycle belongs to the PM agent (012).

import { Router } from 'express';
import { runSeedPipeline } from '../agents/seeding.js';
import { query } from '../db.js';
import { listProjectConversations } from '../db/conversation.js';
import { getProject } from '../db/projects.js';
import { streamEvents } from './sse.js';

const router = Router();

const PROJECT_TYPES = ['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'];

/** GET /api/projects — list projects, oldest first */
router.get('/api/projects', async (_req, res) => {
  const { rows } = await query(
    'SELECT id, name, project_type, owner_id, created_at FROM projects ORDER BY id',
  );
  res.json({ projects: rows });
});

/** POST /api/projects — body { name, projectType? } */
router.post('/api/projects', async (req, res) => {
  const { name, projectType = 'manuscript' } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!PROJECT_TYPES.includes(projectType)) {
    res.status(400).json({ error: `projectType must be one of: ${PROJECT_TYPES.join(', ')}` });
    return;
  }
  const { rows } = await query(
    'INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id, name, project_type, owner_id, created_at',
    [name, projectType],
  );
  res.status(201).json({ project: rows[0] });
});

/**
 * POST /api/projects/:id/seed
 * Run the seeding pipeline (story 015): PM interview → RA + Advisor research
 * → Writer skeleton. Streams stage markers and agent events as SSE.
 */
router.post('/api/projects/:id/seed', async (req, res) => {
  const project = await getProject(parseInt(req.params.id));
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  await streamEvents(res, runSeedPipeline(project.id));
});

/**
 * GET /api/projects/:id/conversations?limit=
 * Recent top-level conversations with their user/assistant messages, newest
 * conversation first, for chat transcript restore (story 020).
 */
router.get('/api/projects/:id/conversations', async (req, res) => {
  const limit = req.query.limit != null ? parseInt(req.query.limit) : 20;
  const conversations = await listProjectConversations(parseInt(req.params.id), { limit });
  res.json({ conversations });
});

export default router;
