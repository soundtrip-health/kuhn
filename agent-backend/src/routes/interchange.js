// Interchange bundle endpoints (docs/specs/interchange-bundle.md §4).
//   POST /api/projects/import      — create a project from a bundle (issue #153)
//   POST /api/projects/:id/import  — update a project from a bundle (issue #153)
//   GET  /api/projects/:id/export  — docs + comments + references (issue #154)
// The export URL is shared with routes/render.js (document export: pdf|docx|
// tex|pptx|html), mounted after this router. The format sets are disjoint, so
// the export handler dispatches on `format` and hands document formats on.
// Tenancy: export needs viewer; creation requires editor in
// the target org (never trusted from the bundle blindly — the org is the
// manifest's org_id ONLY if the caller holds editor there, else their primary
// org); update passes requireProjectRole('editor'). Bundle parsing happens
// before any project is created, so an invalid zip leaves nothing behind.

import { Router } from 'express';
import multer from 'multer';

import { config } from '../config.js';
import { listUserOrgs } from '../db/orgs.js';
import { createProject } from '../db/projects.js';
import { BundleError, parseBundle } from '../interchange/bundle.js';
import { buildExport, buildExportZip } from '../interchange/export.js';
import { ImportConflictError, importBundle } from '../interchange/import.js';
import { log } from '../logger.js';
import { EXPORT_FORMATS as DOCUMENT_FORMATS } from '../render.js';
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
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    console.error('[interchange] Unexpected error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
};

/**
 * Which org a created project lands in: the multipart field `org_id`, else
 * manifest.project.org_id, else the caller's only organization. A caller who
 * belongs to several orgs must say which — the webapp shows one org at a
 * time, so a silent "first org" default puts the project where they are not
 * looking. Sends the 400 itself and returns null.
 */
async function resolveTargetOrg(req, res, manifestOrgId) {
  const raw = req.body?.org_id ?? manifestOrgId;
  if (raw != null && raw !== '') {
    const id = Number(raw);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'org_id must be an integer', code: 'invalid_bundle' });
      return null;
    }
    return id;
  }
  const orgs = (await listUserOrgs(req.user.id)).filter((o) => o.status !== 'suspended');
  if (orgs.length === 1) return orgs[0].id;
  if (orgs.length === 0) {
    res.status(400).json({ error: 'no organization available for this user', code: 'org_required', orgs: [] });
    return null;
  }
  res.status(400).json({
    error: `org_id is required: you belong to ${orgs.length} organizations (pass it as a form field or in manifest.project.org_id)`,
    code: 'org_required',
    orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role })),
  });
  return null;
}

/** POST /api/projects/import — create a project from a bundle. 201. */
router.post('/api/projects/import', bundleUpload, wrap(async (req, res) => {
  const bundle = parseOrRefuse(req, res);
  if (!bundle) return;
  const spec = bundle.manifest.project;
  if (!spec?.name) {
    res.status(400).json({ error: 'manifest.project.name is required to create a project', code: 'invalid_bundle' });
    return;
  }
  const targetOrg = await resolveTargetOrg(req, res, spec.org_id);
  if (targetOrg == null) return;
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

/**
 * GET /api/projects/:id/export?path=…&path=…&format=json|zip
 * Viewer role. `path` narrows the doc set (default: the last import's docs,
 * else every .md under draft/). JSON is the feedback payload; zip is the §3
 * bundle plus comments.json and the docs' sibling assets.
 * A document format (pdf|docx|tex|pptx|html) belongs to routes/render.js,
 * which is mounted after this router: call next() and let it answer.
 */
router.get('/api/projects/:id/export', wrap(async (req, res, next) => {
  const format = req.query.format ?? 'json';
  if (typeof format === 'string' && Object.hasOwn(DOCUMENT_FORMATS, format)) {
    next();
    return;
  }
  if (format !== 'json' && format !== 'zip') {
    res.status(400).json({
      error: `format must be json or zip (${Object.keys(DOCUMENT_FORMATS).join('|')} export a rendered document)`,
      code: 'invalid_format',
    });
    return;
  }
  const project = await requireProjectRole(req, res, req.params.id, 'viewer');
  if (!project) return;
  const raw = req.query.path;
  const paths = raw == null ? null
    : (Array.isArray(raw) ? raw : [raw]).filter((p) => typeof p === 'string' && p.length > 0);
  const startedAt = Date.now();
  try {
    const data = await buildExport(project, { paths, user: req.user });
    const zip = format === 'zip' ? await buildExportZip(project, data) : null;
    log.info('interchange_export', {
      projectId: project.id, userId: req.user.id, format,
      docs: data.docs.length, references: data.references.length,
      comments: data.docs.reduce((n, d) => n + d.comments.length, 0),
      revision: data.revision, bytes: zip?.length ?? null, durationMs: Date.now() - startedAt,
    });
    if (zip) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="kuhn-project-${project.id}.zip"`);
      res.send(zip);
      return;
    }
    res.json(data);
  } catch (err) {
    if (err instanceof StorageError) {
      res.status(STORAGE_STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}));

export default router;
