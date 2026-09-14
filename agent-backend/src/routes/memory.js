// Issue #150 stage 1: read-only HTTP view of a project's shared memory, so
// the memory of a real project can be inspected before the Memory tab
// (stage 3) exists. Viewer role; project-scoped by the guard. Writes stay
// with the agents' tools until the tab lands.

import { Router } from 'express';

import { MEMORY_KINDS, recall } from '../db/memory.js';
import { requireProjectRole } from './guards.js';

const router = Router();

/**
 * GET /api/projects/:projectId/memory?q=&kind=&tag=&retired=1|all&limit=
 * → { entries: [...] } — ranked when `q` is given, newest first otherwise.
 */
router.get('/api/projects/:projectId/memory', async (req, res) => {
  try {
    const project = await requireProjectRole(req, res, req.params.projectId, 'viewer');
    if (!project) return;
    const { q, kind, tag, retired, limit } = req.query;
    if (kind != null && !MEMORY_KINDS.includes(String(kind))) {
      res.status(400).json({ error: `kind must be one of ${MEMORY_KINDS.join(', ')}` });
      return;
    }
    const tags = tag == null ? null : (Array.isArray(tag) ? tag : [tag]).map(String);
    const entries = recall(project.id, {
      query: typeof q === 'string' && q.trim() ? q : null,
      kind: kind != null ? String(kind) : null,
      tags,
      limit: parseInt(limit) || 50,
      retired: retired === 'all' ? 'all' : retired === '1' || retired === 'true',
    }, typeof q === 'string' && q.trim() ? { source: 'api', agent: null, jobId: null } : {});
    res.json({ entries });
  } catch (err) {
    if (err?.code === 'invalid_tags') {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[memory] Unexpected error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
