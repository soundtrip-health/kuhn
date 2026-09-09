// Interchange bundle endpoints (docs/specs/interchange-bundle.md §4).
//   POST /api/projects/import      — create a project from a bundle (issue #153)
//   POST /api/projects/:id/import  — update a project from a bundle (issue #153)
// Export (issue #154) lands here too. Tenancy: creation requires editor in
// the target org (never trusted from the bundle blindly — the org is the
// manifest's org_id ONLY if the caller holds editor there, else their primary
// org); update passes requireProjectRole('editor'). Bundle parsing happens
// before any project is created, so an invalid zip leaves nothing behind.

import { Router } from 'express';
import multer from 'multer';

import { config } from '../config.js';
import { primaryOrgId } from '../db/orgs.js';
import { createProject } from '../db/projects.js';
import { BundleError, parseBundle } from '../interchange/bundle.js';
import { ImportConflictError, importBundle } from '../interchange/import.js';
import { StorageError } from '../storage.js';
import { requireOrgRole, requireProjectRole } from './guards.js';

const router = Router();

const STORAGE_STATUS = { not_found: 404, outside_root: 403, invalid_path: 400, too_large: 413, conflict: 409 };

/** One multipart field `bundle`; the zip's compressed size is capped at the
 *  uncompressed bundle cap (it can only be smaller). */
function bundleUpload(req, res, next) {
  const max = config.interchange.maxBundleBytes;
  multer({ storage: multer.memoryStorage(), limits: { fileSize: max, files: 1 } })
    .single('bundle')(req, res, (err) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `bundle exceeds ${max} bytes`, code: 'too_large' });
        return;
      }
      res.status(400).json({ error: err.message, code: 'invalid_bundle' });
    });
}

/** Parse the uploaded zip or send the refusal. @returns bundle or null */
function parseOrRefuse(req, res) {
  if (!req.file?.buffer) {
    res.status(400).json({ error: 'send the bundle zip as the multipart field "bundle"', code: 'invalid_bundle' });
    return null;
  }
  try {
    return parseBundle(req.file.buffer);
  } catch (err) {
    if (err instanceof BundleError) {
      res.status(err.code === 'too_large' ? 413 : 400).json({ error: err.message, code: err.code });
      return null;
    }
    throw err;
  }
}

const truthy = (v) => v === '1' || v === 'true' || v === true;
const publicProject = (p) => ({ id: p.id, name: p.name, project_type: p.project_type, org_id: p.org_id });

async function runImport(project, bundle, req, res, status) {
  const opts = {
    userId: req.user.id,
    force: truthy(req.body?.force ?? req.query.force),
    label: typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim().slice(0, 120) : null,
  };
  try {
    const result = await importBundle(project, bundle, opts);
    res.status(status).json({ project: publicProject(project), ...result });
  } catch (err) {
    if (err instanceof ImportConflictError) {
      res.status(409).json({ error: err.message, code: err.code, paths: err.paths });
      return;
    }
    if (err instanceof StorageError) {
      res.status(STORAGE_STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}

/** Route bodies are async; Express 4 needs the rejection caught by hand. */
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('[interchange] Unexpected error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
};

/** POST /api/projects/import — create a project from a bundle. 201. */
router.post('/api/projects/import', bundleUpload, wrap(async (req, res) => {
  const bundle = parseOrRefuse(req, res);
  if (!bundle) return;
  const spec = bundle.manifest.project;
  if (!spec?.name) {
    res.status(400).json({ error: 'manifest.project.name is required to create a project', code: 'invalid_bundle' });
    return;
  }
  const targetOrg = spec.org_id ?? await primaryOrgId(req.user.id);
  if (targetOrg == null) {
    res.status(400).json({ error: 'no organization available for this user' });
    return;
  }
  const ctx = await requireOrgRole(req, res, targetOrg, 'editor');
  if (!ctx) return;
  const project = await createProject({ name: spec.name, projectType: spec.project_type, orgId: ctx.orgId });
  await runImport(project, bundle, req, res, 201);
}));

/** POST /api/projects/:id/import — update an existing project. 200. */
router.post('/api/projects/:id/import', bundleUpload, wrap(async (req, res) => {
  const project = await requireProjectRole(req, res, req.params.id, 'editor');
  if (!project) return;
  const bundle = parseOrRefuse(req, res);
  if (!bundle) return;
  await runImport(project, bundle, req, res, 200);
}));

export default router;
