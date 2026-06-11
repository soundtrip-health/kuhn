// Story 013: minimal project endpoints so the webapp can pick (or bootstrap)
// the active project. Full project lifecycle belongs to the PM agent (012).

import { Router } from 'express';
import { query } from '../db.js';

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

export default router;
