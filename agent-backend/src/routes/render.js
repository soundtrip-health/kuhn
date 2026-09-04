// Story 019: HTTP surface of the render/export service. Failures must reach
// the UI as readable messages (compile stderr excerpt), not 500s: sandbox
// errors map to 4xx/504 JSON bodies the webapp shows verbatim.
// Tenancy (story 010-003): render and export are reads — viewer threshold.

import { Router } from 'express';

import { log } from '../logger.js';
import { renderPdf, exportDocument, EXPORT_FORMATS } from '../render.js';
import { SandboxError } from '../sandbox.js';
import { StorageError } from '../storage.js';
import { requireProjectRole } from './guards.js';

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

function handle(minRole, fn) {
  return async (req, res) => {
    const started = Date.now();
    try {
      const project = await requireProjectRole(req, res, req.params.projectId, minRole);
      if (!project) return;
      await fn(project.id, req, res);
    } catch (err) {
      // Expected failures reach the UI as readable 4xx bodies — and the log,
      // so a "render does nothing" report can be matched to what the sandbox
      // actually said.
      const ctx = {
        projectId: req.params.projectId,
        path: req.body?.path ?? req.query?.path,
        format: req.query?.format,
        userId: req.user?.id ?? null,
        ms: Date.now() - started,
      };
      if (err instanceof StorageError) {
        log.warn('render_failed', { ...ctx, code: err.code, message: err.message });
        res.status(STORAGE_STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
      } else if (err instanceof SandboxError) {
        log.warn('render_failed', { ...ctx, code: err.code, message: err.message });
        res.status(SANDBOX_STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
      } else {
        log.error('render_failed', { ...ctx, error: err });
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };
}

/**
 * POST /api/projects/:projectId/render — body { path }.
 * Renders markdown → Typst → PDF and returns the PDF bytes.
 */
router.post('/api/projects/:projectId/render', handle('viewer', async (projectId, req, res) => {
  const path = req.body?.path;
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ error: 'path is required in the request body' });
    return;
  }
  const started = Date.now();
  const { pdf, cached } = await renderPdf(projectId, path);
  log.info('render', {
    projectId, path, cached, bytes: pdf.length, ms: Date.now() - started, userId: req.user?.id ?? null,
  });
  res.set('Content-Type', 'application/pdf');
  res.set('X-Render-Cache', cached ? 'hit' : 'miss');
  res.send(pdf);
}));

/**
 * GET /api/projects/:projectId/export?path=...&format=pdf|docx|tex|pptx|html
 * Export (Pandoc, Marp, or the rendered PDF itself), served as an attachment
 * download.
 */
router.get('/api/projects/:projectId/export', handle('viewer', async (projectId, req, res) => {
  const path = req.query.path;
  const format = req.query.format;
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }
  if (typeof format !== 'string' || !Object.hasOwn(EXPORT_FORMATS, format)) {
    res.status(400).json({ error: `format must be one of: ${Object.keys(EXPORT_FORMATS).join(', ')}` });
    return;
  }
  const started = Date.now();
  const { output, contentType, filename } = await exportDocument(projectId, path, format);
  log.info('export', {
    projectId, path, format, bytes: output.length, ms: Date.now() - started, userId: req.user?.id ?? null,
  });
  res.set('Content-Type', contentType);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(output);
}));

export default router;
