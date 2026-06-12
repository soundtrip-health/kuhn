// Story 019: HTTP surface of the render/export service. Failures must reach
// the UI as readable messages (compile stderr excerpt), not 500s: sandbox
// errors map to 4xx/504 JSON bodies the webapp shows verbatim.

import { Router } from 'express';

import { renderPdf, exportDocument, EXPORT_FORMATS } from '../render.js';
import { SandboxError } from '../sandbox.js';
import { StorageError } from '../storage.js';

const router = Router();

const STORAGE_STATUS = {
  not_found: 404,
  outside_root: 403,
  invalid_path: 400,
  too_large: 413,
  conflict: 409,
};

const SANDBOX_STATUS = {
  failed: 422,
  timeout: 504,
  output_too_large: 413,
};

function handle(fn) {
  return async (req, res) => {
    const projectId = parseInt(req.params.projectId);
    if (Number.isNaN(projectId)) {
      res.status(400).json({ error: 'projectId must be a number' });
      return;
    }
    try {
      await fn(projectId, req, res);
    } catch (err) {
      if (err instanceof StorageError) {
        res.status(STORAGE_STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
      } else if (err instanceof SandboxError) {
        res.status(SANDBOX_STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
      } else {
        console.error('[render] Unexpected error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };
}

/**
 * POST /api/projects/:projectId/render — body { path }.
 * Renders markdown → Typst → PDF and returns the PDF bytes.
 */
router.post('/api/projects/:projectId/render', handle(async (projectId, req, res) => {
  const path = req.body?.path;
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ error: 'path is required in the request body' });
    return;
  }
  const { pdf, cached } = await renderPdf(projectId, path);
  res.set('Content-Type', 'application/pdf');
  res.set('X-Render-Cache', cached ? 'hit' : 'miss');
  res.send(pdf);
}));

/**
 * GET /api/projects/:projectId/export?path=...&format=docx|tex
 * Pandoc export, served as an attachment download.
 */
router.get('/api/projects/:projectId/export', handle(async (projectId, req, res) => {
  const path = req.query.path;
  const format = req.query.format;
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }
  if (typeof format !== 'string' || !(format in EXPORT_FORMATS)) {
    res.status(400).json({ error: `format must be one of: ${Object.keys(EXPORT_FORMATS).join(', ')}` });
    return;
  }
  const { output, contentType, filename } = await exportDocument(projectId, path, format);
  res.set('Content-Type', contentType);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(output);
}));

export default router;
