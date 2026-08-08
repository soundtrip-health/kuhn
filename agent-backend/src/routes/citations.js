// Story 016: HTTP surface of the citation service, consumed by the /cite
// editor command. Search returns PubMed-grounded candidates; POST verifies
// the chosen PMID against PubMed and upserts it into the project bibliography.
// Tenancy (story 010-003): search/list are viewer reads; the bibliography
// upsert is an editor write.

import { Router } from 'express';

import {
  DEFAULT_BIB_PATH,
  UpstreamError,
  searchCitations,
  upsertCitation,
} from '../citations.js';
import { listProjectReferences } from '../db/references.js';
import { StorageError } from '../storage.js';
import { requireProjectRole } from './guards.js';

const router = Router();

const STATUS_BY_CODE = {
  not_found: 404,
  outside_root: 403,
  invalid_path: 400,
  too_large: 413,
  conflict: 409,
};

function handle(minRole, fn) {
  return async (req, res) => {
    try {
      const project = await requireProjectRole(req, res, req.params.projectId, minRole);
      if (!project) return;
      await fn(project.id, req, res);
    } catch (err) {
      if (err instanceof StorageError) {
        res.status(STATUS_BY_CODE[err.code] ?? 500).json({ error: err.message, code: err.code });
      } else if (err instanceof UpstreamError) {
        res.status(502).json({ error: err.message, code: 'upstream' });
      } else {
        console.error('[citations] Unexpected error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };
}

/** GET /api/projects/:projectId/citations/search?q=...&max=8 — PubMed candidates */
router.get('/api/projects/:projectId/citations/search', handle('viewer', async (_projectId, req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    res.status(400).json({ error: 'q query parameter is required' });
    return;
  }
  const max = Math.min(Math.max(parseInt(req.query.max) || 8, 1), 25);
  const candidates = await searchCitations(query, max);
  res.json({ candidates });
}));

/**
 * POST /api/projects/:projectId/citations — body { pmid, path? }.
 * Upserts the cited work into the project bibliography (default
 * draft/references.bib); returns { key, created, bibtex, path }.
 */
router.post('/api/projects/:projectId/citations', handle('editor', async (projectId, req, res) => {
  const { pmid, path } = req.body ?? {};
  if (typeof pmid !== 'string' && typeof pmid !== 'number') {
    res.status(400).json({ error: 'pmid is required' });
    return;
  }
  const result = await upsertCitation(projectId, String(pmid), path || DEFAULT_BIB_PATH);
  res.status(result.created ? 201 : 200).json(result);
}));

/**
 * GET /api/projects/:projectId/references — the project's stored references
 * (canonical SQLite store), for a citation picker/library view.
 */
router.get('/api/projects/:projectId/references', handle('viewer', async (projectId, _req, res) => {
  const references = await listProjectReferences(projectId);
  res.json({ references });
}));

export default router;
