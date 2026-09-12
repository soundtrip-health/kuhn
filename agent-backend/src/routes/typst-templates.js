// HTTP surface of the Typst template library. The Kuhn catalog
// (catalog_typst_templates, seeded from typst-templates/catalog.json) is
// readable by any authenticated user; org templates are uploaded Typst source
// in the DB. Same guard contract as the slide themes: org reads are
// member-level, writes are owner-only and audited.

import { Router } from 'express';

import { config } from '../config.js';
import { recordAuthEvent } from '../db/auth-events.js';
import {
  getOrgTemplate,
  listCatalogTemplates,
  listOrgTemplates,
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
});

// Lists stay light: source comes back only from the single-template GET.
const publicOrgTemplate = (row) => ({
  id: row.id,
  name: row.name,
  title: row.title,
  status: row.status,
  source_bytes: Buffer.byteLength(row.source, 'utf-8'),
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
