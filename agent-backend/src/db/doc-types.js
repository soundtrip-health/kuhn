// Issue #106: document types — what a project IS (manuscript, grant, RWE or
// RCT protocol, SOP, …). catalog_doc_types mirrors catalog_slide_themes:
// Kuhn-shipped rows seeded from doc-types/catalog.json (title, one-line
// description, the Typst template the wizard preselects, wizard hints, and
// the markdown guidance the agents get in their system prompt). Org-defined
// types live in org_doc_types as DB rows; an ACTIVE org type shadows a
// catalog type of the same slug. Disable ≠ delete — existing projects keep
// their type either way.
//
// Everything that used to be a hard-coded list (schema CHECK, route enums,
// tool schema enum, webapp constants) resolves through effectiveDocTypes /
// resolveDocType here.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { config } from '../config.js';
import { querySync, transaction } from '../db.js';

export const DOC_TYPE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export class DocTypeError extends Error {
  /** @param {'invalid'|'invalid_manifest'} code */
  constructor(code, message) {
    super(message);
    this.name = 'DocTypeError';
    this.code = code;
  }
}

const catalogRoot = () => resolve(config.docTypes.catalogRoot);

export const isDocTypeSlug = (s) => typeof s === 'string' && DOC_TYPE_SLUG_RE.test(s);
const isTemplateName = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);
const fail = (msg) => { throw new DocTypeError('invalid_manifest', `catalog.json: ${msg}`); };

/**
 * Validate one type's optional fields (shared by the manifest and the org
 * route). Throws DocTypeError('invalid') with the first problem; returns the
 * normalized fields.
 */
export function normalizeDocTypeFields({ title, description, default_template, wizard_hints, guidance }, label = 'document type') {
  const bad = (msg) => { throw new DocTypeError('invalid', `${label}: ${msg}`); };
  if (typeof title !== 'string' || title.trim().length === 0) bad('title is required');
  if (description != null && typeof description !== 'string') bad('description must be a string');
  if (default_template != null && default_template !== '' && !isTemplateName(default_template)) {
    bad('default_template must be a template name or null');
  }
  if (wizard_hints != null && (!Array.isArray(wizard_hints) || wizard_hints.some((h) => typeof h !== 'string'))) {
    bad('wizard_hints must be an array of strings');
  }
  if (guidance != null && typeof guidance !== 'string') bad('guidance must be a string');
  return {
    title: title.trim(),
    description: typeof description === 'string' && description.trim() ? description.trim() : null,
    default_template: default_template ? default_template : null,
    wizard_hints: (wizard_hints ?? []).map((h) => h.trim()).filter(Boolean),
    guidance: (guidance ?? '').trim(),
  };
}

/** Structural validation; throws DocTypeError('invalid_manifest') with the first problem. */
export function validateDocTypeManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('manifest must be an object');
  }
  if (!Number.isInteger(manifest.catalog_version) || manifest.catalog_version < 1) {
    fail('catalog_version must be a positive integer');
  }
  if (!Array.isArray(manifest.types)) fail('types must be an array');
  const slugs = new Set();
  for (const type of manifest.types) {
    if (type === null || typeof type !== 'object') fail('every type must be an object');
    if (!isDocTypeSlug(type.slug)) fail(`type slug must be a slug: ${JSON.stringify(type.slug)}`);
    if (slugs.has(type.slug)) fail(`duplicate type slug: ${type.slug}`);
    try {
      normalizeDocTypeFields(type, `type ${type.slug}`);
    } catch (err) {
      if (err instanceof DocTypeError) fail(err.message);
      throw err;
    }
    slugs.add(type.slug);
  }
  return manifest;
}

/** @returns {Promise<object|null>} the manifest, or null when absent (seed warns). */
export async function loadDocTypeManifest() {
  let raw;
  try {
    raw = await readFile(join(catalogRoot(), 'catalog.json'), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new DocTypeError('invalid_manifest', `catalog.json: not valid JSON (${err.message})`);
  }
  return validateDocTypeManifest(manifest);
}

/**
 * Seed catalog_doc_types from doc-types/catalog.json — the same discipline
 * as the slide-theme catalog: idempotent upserts in manifest order, rows
 * that leave the manifest go available = 0, never deleted (projects may
 * still carry the slug).
 */
export async function seedDocTypeCatalog() {
  const manifest = await loadDocTypeManifest();
  if (!manifest) {
    console.warn('[seed] doc-types/catalog.json not found — document-type catalog not seeded.');
    return;
  }
  const rows = manifest.types.map((t, i) => ({ slug: t.slug, ...normalizeDocTypeFields(t), sort_order: i }));
  transaction(() => {
    for (const t of rows) {
      querySync(
        `INSERT INTO catalog_doc_types
           (slug, title, description, default_template, wizard_hints, guidance, sort_order, available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
         ON CONFLICT (slug) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           default_template = excluded.default_template,
           wizard_hints = excluded.wizard_hints,
           guidance = excluded.guidance,
           sort_order = excluded.sort_order,
           available = 1`,
        [t.slug, t.title, t.description, t.default_template, JSON.stringify(t.wizard_hints), t.guidance, t.sort_order],
      );
    }
    querySync(
      `UPDATE catalog_doc_types SET available = 0
       WHERE slug NOT IN (SELECT value FROM json_each($1))`,
      [JSON.stringify(rows.map((t) => t.slug))],
    );
  });
  console.log(`[seed] Document-type catalog v${manifest.catalog_version}: ${rows.length} types.`);
}

// ---- rows (querySync, matching the other db/ modules) ----------------------

const parseRow = (row) => {
  if (!row) return row;
  let hints = [];
  try { hints = JSON.parse(row.wizard_hints || '[]'); } catch { hints = []; }
  return { ...row, wizard_hints: Array.isArray(hints) ? hints : [] };
};

export function listCatalogDocTypes() {
  return querySync('SELECT * FROM catalog_doc_types ORDER BY sort_order, slug').rows.map(parseRow);
}

export function listOrgDocTypes(orgId) {
  return querySync(
    'SELECT * FROM org_doc_types WHERE org_id = $1 ORDER BY title, slug', [orgId],
  ).rows.map(parseRow);
}

export function getOrgDocType(orgId, slug) {
  const row = querySync(
    'SELECT * FROM org_doc_types WHERE org_id = $1 AND slug = $2', [orgId, slug],
  ).rows[0];
  return row ? parseRow(row) : null;
}

/** Save = upsert: re-saving a slug replaces its fields and re-activates it. */
export function upsertOrgDocType({ orgId, slug, title, description = null, defaultTemplate = null, wizardHints = [], guidance = '', createdBy = null }) {
  if (!isDocTypeSlug(slug)) throw new DocTypeError('invalid', `invalid document-type slug: ${JSON.stringify(slug)}`);
  const fields = normalizeDocTypeFields({
    title, description, default_template: defaultTemplate, wizard_hints: wizardHints, guidance,
  }, `document type ${slug}`);
  return parseRow(querySync(
    `INSERT INTO org_doc_types (org_id, slug, title, description, default_template, wizard_hints, guidance, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id, slug) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       default_template = excluded.default_template,
       wizard_hints = excluded.wizard_hints,
       guidance = excluded.guidance,
       status = 'active',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING *`,
    [orgId, slug, fields.title, fields.description, fields.default_template,
      JSON.stringify(fields.wizard_hints), fields.guidance, createdBy],
  ).rows[0]);
}

export function setOrgDocTypeStatus(orgId, slug, status) {
  const row = querySync(
    `UPDATE org_doc_types
     SET status = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE org_id = $1 AND slug = $2
     RETURNING *`,
    [orgId, slug, status],
  ).rows[0];
  return row ? parseRow(row) : null;
}

const publicType = (row, source) => ({
  slug: row.slug,
  title: row.title,
  description: row.description ?? null,
  default_template: row.default_template ?? null,
  wizard_hints: row.wizard_hints,
  guidance: row.guidance ?? '',
  source,
});

/**
 * The document types a project in this org may be: available catalog types
 * in manifest order, with an ACTIVE org type of the same slug shadowing the
 * catalog row in place, then the org's own (non-shadowing) active types by
 * title. Each item carries `source: 'catalog'|'org'`. orgId null → catalog only.
 * @returns {Array<{slug, title, description, default_template, wizard_hints, guidance, source}>}
 */
export function effectiveDocTypes(orgId) {
  const org = orgId == null ? [] : listOrgDocTypes(orgId).filter((t) => t.status === 'active');
  const orgBySlug = new Map(org.map((t) => [t.slug, t]));
  const out = [];
  for (const cat of listCatalogDocTypes()) {
    const shadow = orgBySlug.get(cat.slug);
    if (shadow) {
      out.push(publicType(shadow, 'org'));
      orgBySlug.delete(cat.slug);
    } else if (cat.available) {
      out.push(publicType(cat, 'catalog'));
    }
  }
  for (const t of orgBySlug.values()) out.push(publicType(t, 'org'));
  return out;
}

/**
 * Resolve one slug for an org: the active org row if there is one, else the
 * available catalog row, else null.
 * @returns {object|null} the effective type (same shape as effectiveDocTypes items)
 */
export function resolveDocType(orgId, slug) {
  if (!isDocTypeSlug(slug)) return null;
  if (orgId != null) {
    const row = querySync(
      `SELECT * FROM org_doc_types WHERE org_id = $1 AND slug = $2 AND status = 'active'`,
      [orgId, slug],
    ).rows[0];
    if (row) return publicType(parseRow(row), 'org');
  }
  const cat = querySync(
    'SELECT * FROM catalog_doc_types WHERE slug = $1 AND available = 1', [slug],
  ).rows[0];
  return cat ? publicType(parseRow(cat), 'catalog') : null;
}

/** Whether a slug names a document type this org may use (the projects-route check). */
export function docTypeResolves(orgId, slug) {
  return resolveDocType(orgId, slug) !== null;
}
