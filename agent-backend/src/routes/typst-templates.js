// HTTP surface of the Typst template library. The Kuhn catalog
// (catalog_typst_templates, seeded from typst-templates/catalog.json) is
// readable by any authenticated user; org templates are uploaded Typst source
// in the DB. Same guard contract as the slide themes: org reads are
// member-level, writes are owner-only and audited.

import express, { Router } from 'express';

import { config } from '../config.js';
import { recordAuthEvent } from '../db/auth-events.js';
import {
  getOrgTemplate,
  listCatalogTemplates,
  listOrgTemplates,
  setOrgTemplateDocx,
  setOrgTemplateStatus,
  templateNameFromSource,
  upsertOrgTemplate,
} from '../db/typst-templates.js';
import { requireOrgRole } from './guards.js';

const router = Router();

const publicCatalogTemplate = (row) => ({
  name: row.name,
  title: row.title,
  description: row.description,
  available: !!row.available,
  docx: !!row.docx_path, // ships a Word reference document
});

// Lists stay light: source comes back only from the single-template GET.
const publicOrgTemplate = (row) => ({
  id: row.id,
  name: row.name,
  title: row.title,
  status: row.status,
  source_bytes: Buffer.byteLength(row.source, 'utf-8'),
  docx_bytes: row.docx_bytes ?? (row.docx ? row.docx.length : 0),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

function templatesPayload(orgId) {
  const templates = listOrgTemplates(orgId);
  const shadowed = new Set(templates.filter((t) => t.status === 'active').map((t) => t.name));
  const catalog = listCatalogTemplates().map((row) => ({
    ...publicCatalogTemplate(row),
    shadowed: shadowed.has(row.name), // an active org template of this name wins at render time
  }));
  return { catalog, templates: templates.map(publicOrgTemplate) };
}

/** GET /api/typst-templates/catalog — the Kuhn template catalog. Any authenticated user. */
router.get('/api/typst-templates/catalog', (req, res) => {
  res.json({ templates: listCatalogTemplates().map(publicCatalogTemplate) });
});

/** GET /api/orgs/:orgId/typst-templates — catalog + this org's templates. */
router.get('/api/orgs/:orgId/typst-templates', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  res.json(templatesPayload(ctx.orgId));
});

/** GET /api/orgs/:orgId/typst-templates/:name — one org template with its source. */
router.get('/api/orgs/:orgId/typst-templates/:name', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  const template = getOrgTemplate(ctx.orgId, req.params.name);
  if (!template) {
    res.status(404).json({ error: 'template not found' });
    return;
  }
  res.json({ template: publicOrgTemplate(template), source: template.source });
});

/**
 * POST /api/orgs/:orgId/typst-templates — owner, { source, title? }.
 * The template's name comes from its required `// @template <name>` header,
 * so a template can never render under a name other than the one it
 * declares. The source must export `conf` (what Pandoc's Typst layout
 * imports). Re-uploading a name replaces its source and re-activates it.
 */
router.post('/api/orgs/:orgId/typst-templates', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const { source, title } = req.body ?? {};
  if (typeof source !== 'string' || source.trim().length === 0) {
    res.status(400).json({ error: 'source is required', field: 'source' });
    return;
  }
  if (Buffer.byteLength(source, 'utf-8') > config.typstTemplates.maxTemplateBytes) {
    res.status(413).json({ error: `template source exceeds ${config.typstTemplates.maxTemplateBytes} bytes` });
    return;
  }
  const name = templateNameFromSource(source);
  if (!name) {
    res.status(400).json({
      error: 'the template must declare its name in a `// @template <name>` comment line',
      field: 'source',
    });
    return;
  }
  if (!/#let\s+conf\s*\(/.test(source)) {
    res.status(400).json({
      error: 'the template must define `#let conf(..., doc) = { ... }` — the function Pandoc\'s Typst layout imports',
      field: 'source',
    });
    return;
  }
  const template = upsertOrgTemplate({
    orgId: ctx.orgId,
    name,
    title: typeof title === 'string' && title.trim() ? title.trim() : name,
    source,
    createdBy: req.user.id,
  });
  recordAuthEvent({
    type: 'typst_template.upload', actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { template: name },
  });
  res.json({ template: publicOrgTemplate(template), ...templatesPayload(ctx.orgId) });
});

/**
 * PUT /api/orgs/:orgId/typst-templates/:name/docx — owner; the raw .docx
 * bytes as the body. The Word reference document pandoc's docx export uses
 * for this template (page geometry + styles). An empty body removes it.
 */
router.put(
  '/api/orgs/:orgId/typst-templates/:name/docx',
  (req, res, next) => express.raw({ type: () => true, limit: config.typstTemplates.maxDocxBytes })(req, res, next),
  async (req, res) => {
    const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
    if (!ctx) return;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // A .docx is a zip: "PK\x03\x04" — reject anything else before it reaches pandoc.
    if (body.length > 0 && !(body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04)) {
      res.status(400).json({ error: 'the body must be a .docx file' });
      return;
    }
    const updated = setOrgTemplateDocx(ctx.orgId, req.params.name, body.length ? body : null);
    if (!updated) {
      res.status(404).json({ error: 'template not found' });
      return;
    }
    recordAuthEvent({
      type: body.length ? 'typst_template.docx_upload' : 'typst_template.docx_remove',
      actorUserId: req.user.id, orgId: ctx.orgId, meta: { template: updated.name, bytes: body.length },
    });
    res.json({ template: publicOrgTemplate(getOrgTemplate(ctx.orgId, updated.name)), ...templatesPayload(ctx.orgId) });
  },
);

/** GET /api/orgs/:orgId/typst-templates/:name/docx — the Word reference document, as a download. */
router.get('/api/orgs/:orgId/typst-templates/:name/docx', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  const template = getOrgTemplate(ctx.orgId, req.params.name);
  if (!template?.docx) {
    res.status(404).json({ error: 'no Word reference document' });
    return;
  }
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.set('Content-Disposition', `attachment; filename="${template.name}.docx"`);
  res.send(Buffer.from(template.docx));
});

/** PATCH /api/orgs/:orgId/typst-templates/:name — owner, { status: 'active'|'disabled' }. */
router.patch('/api/orgs/:orgId/typst-templates/:name', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const status = req.body?.status;
  if (status !== 'active' && status !== 'disabled') {
    res.status(400).json({ error: 'status must be active or disabled', field: 'status' });
    return;
  }
  const updated = setOrgTemplateStatus(ctx.orgId, req.params.name, status);
  if (!updated) {
    res.status(404).json({ error: 'template not found' });
    return;
  }
  recordAuthEvent({
    type: status === 'active' ? 'typst_template.enable' : 'typst_template.disable',
    actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { template: updated.name },
  });
  res.json({ template: publicOrgTemplate(updated) });
});

export default router;
