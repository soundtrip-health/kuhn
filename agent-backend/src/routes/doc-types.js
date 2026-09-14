// Issue #106: HTTP surface of the document-type library. The Kuhn catalog
// (catalog_doc_types, seeded from doc-types/catalog.json) is readable by any
// authenticated user; org types are JSON rows in the DB. Same guard contract
// as the slide-theme library: org reads are member-level, writes are
// owner-only and audited.

import { Router } from 'express';

import { config } from '../config.js';
import { recordAuthEvent } from '../db/auth-events.js';
import {
  DocTypeError,
  effectiveDocTypes,
  isDocTypeSlug,
  listCatalogDocTypes,
  listOrgDocTypes,
  setOrgDocTypeStatus,
  upsertOrgDocType,
} from '../db/doc-types.js';
import { requireOrgRole } from './guards.js';

const router = Router();

const publicCatalogType = (row) => ({
  slug: row.slug,
  title: row.title,
  description: row.description,
  default_template: row.default_template,
  wizard_hints: row.wizard_hints,
  guidance: row.guidance,
  available: !!row.available,
});

const publicOrgType = (row) => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  description: row.description,
  default_template: row.default_template,
  wizard_hints: row.wizard_hints,
  guidance: row.guidance,
  status: row.status,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/** Catalog + this org's rows + the merged list pickers and agents use. */
export function docTypesPayload(orgId) {
  const types = listOrgDocTypes(orgId);
  const shadowed = new Set(types.filter((t) => t.status === 'active').map((t) => t.slug));
  const catalog = listCatalogDocTypes().map((row) => ({
    ...publicCatalogType(row),
    shadowed: shadowed.has(row.slug), // an active org type of this slug wins
  }));
  return { catalog, types: types.map(publicOrgType), effective: effectiveDocTypes(orgId) };
}

/** GET /api/doc-types/catalog — the Kuhn document-type catalog. Any authenticated user. */
router.get('/api/doc-types/catalog', (req, res) => {
  res.json({ types: listCatalogDocTypes().map(publicCatalogType) });
});

/** GET /api/orgs/:orgId/doc-types — catalog + this org's types + the effective list. */
router.get('/api/orgs/:orgId/doc-types', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  res.json(docTypesPayload(ctx.orgId));
});

/**
 * POST /api/orgs/:orgId/doc-types — owner, { slug, title, description?,
 * default_template?, wizard_hints?, guidance? }. Upsert by slug: re-saving a
 * slug replaces its fields and re-activates it. A slug that matches a Kuhn
 * catalog type shadows it for this org.
 */
router.post('/api/orgs/:orgId/doc-types', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const body = req.body ?? {};
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  if (!isDocTypeSlug(slug)) {
    res.status(400).json({ error: 'slug must be 2–40 lowercase letters, digits or hyphens', field: 'slug' });
    return;
  }
  if (typeof body.guidance === 'string'
    && Buffer.byteLength(body.guidance, 'utf-8') > config.docTypes.maxGuidanceBytes) {
    res.status(413).json({ error: `guidance exceeds ${config.docTypes.maxGuidanceBytes} bytes`, field: 'guidance' });
    return;
  }
  let type;
  try {
    type = upsertOrgDocType({
      orgId: ctx.orgId,
      slug,
      title: body.title,
      description: body.description,
      defaultTemplate: body.default_template,
      wizardHints: body.wizard_hints,
      guidance: body.guidance,
      createdBy: req.user.id,
    });
  } catch (err) {
    if (err instanceof DocTypeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  recordAuthEvent({
    type: 'doc_type.upsert', actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { doc_type: slug },
  });
  res.json({ type: publicOrgType(type), ...docTypesPayload(ctx.orgId) });
});

/** PATCH /api/orgs/:orgId/doc-types/:slug — owner, { status: 'active'|'disabled' }. */
router.patch('/api/orgs/:orgId/doc-types/:slug', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const status = req.body?.status;
  if (status !== 'active' && status !== 'disabled') {
    res.status(400).json({ error: 'status must be active or disabled', field: 'status' });
    return;
  }
  const updated = setOrgDocTypeStatus(ctx.orgId, req.params.slug, status);
  if (!updated) {
    res.status(404).json({ error: 'document type not found' });
    return;
  }
  recordAuthEvent({
    type: status === 'active' ? 'doc_type.enable' : 'doc_type.disable',
    actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { doc_type: updated.slug },
  });
  res.json({ type: publicOrgType(updated) });
});

export default router;
