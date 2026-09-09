// Typst templates: the page layout a document renders with (paper, margins,
// font, spacing — the rules a grant or journal imposes). catalog_typst_templates
// mirrors catalog_slide_themes — Kuhn-shipped rows seeded from
// typst-templates/catalog.json (.typ files in the repo tree, org-independent,
// read-only at runtime; reads bypass storage.js with their own confinement).
// Org-uploaded templates live in org_typst_templates as DB text; an active org
// template shadows a catalog template of the same name at render time.
//
// A template is a Typst file exporting `conf` with the parameters Pandoc's
// default Typst template passes (typst-templates/default.typ is that partial
// verbatim). A document selects one with `template: <name>` in its front
// matter; render.js materializes the source next to the temp .typ and points
// Pandoc's `template` variable at it. A template may pair a Word reference
// document (.docx; pandoc --reference-doc) so docx exports carry the same
// page geometry and styles — typst-templates/tools/make-reference-docx.py
// generates the catalog ones.

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { config } from '../config.js';
import { querySync } from '../db.js';

export class TemplateError extends Error {
  /** @param {'invalid'|'not_found'|'invalid_path'|'outside_root'|'invalid_manifest'} code */
  constructor(code, message) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
  }
}

const catalogRoot = () => resolve(config.typstTemplates.catalogRoot);

/** Lexical confinement to typst-templates/ (symlinks re-checked at read time). */
export function resolveTemplateFile(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    throw new TemplateError('invalid_path', 'Template path is required');
  }
  if (isAbsolute(relPath)) {
    throw new TemplateError('outside_root', 'Absolute template paths are not allowed');
  }
  const normalized = normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new TemplateError('outside_root', `Template path escapes typst-templates/: ${relPath}`);
  }
  const root = catalogRoot();
  const abs = resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new TemplateError('outside_root', `Template path escapes typst-templates/: ${relPath}`);
  }
  return abs;
}

async function realTemplateFile(relPath) {
  const abs = resolveTemplateFile(relPath);
  let real;
  try {
    real = await realpath(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new TemplateError('not_found', `No such template file: ${relPath}`);
    throw err;
  }
  const root = await realpath(catalogRoot());
  if (real !== root && !real.startsWith(root + sep)) {
    throw new TemplateError('outside_root', `Template path escapes typst-templates/: ${relPath}`);
  }
  return real;
}

/** Whether a template's .typ exists in this checkout (seed availability). */
export async function templateFileExists(relPath) {
  let real;
  try {
    real = await realTemplateFile(relPath);
  } catch (err) {
    if (err instanceof TemplateError && (err.code === 'not_found' || err.code === 'outside_root')) return false;
    throw err;
  }
  return (await stat(real)).isFile();
}

/** @returns {Promise<string>} UTF-8 Typst source */
export async function readCatalogTemplateFile(relPath) {
  return readFile(await realTemplateFile(relPath), 'utf-8');
}

/**
 * The `// @template name` header every Kuhn template declares (Typst has no
 * self-naming convention of its own; this mirrors marp's `@theme`). Org
 * uploads take their name from it, so a template never renders under a
 * name other than the one it declares.
 */
export function templateNameFromSource(source) {
  const m = /^\s*\/\/\s*@template\s+([A-Za-z0-9][\w-]*)\s*$/m.exec(String(source));
  return m ? m[1] : null;
}

const isTemplateName = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);
const fail = (msg) => { throw new TemplateError('invalid_manifest', `catalog.json: ${msg}`); };

/** Structural validation; throws TemplateError('invalid_manifest') with the first problem. */
export function validateTemplateManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('manifest must be an object');
  }
  if (!Number.isInteger(manifest.catalog_version) || manifest.catalog_version < 1) {
    fail('catalog_version must be a positive integer');
  }
  if (!Array.isArray(manifest.templates)) fail('templates must be an array');
  const names = new Set();
  for (const tpl of manifest.templates) {
    if (tpl === null || typeof tpl !== 'object') fail('every template must be an object');
    if (!isTemplateName(tpl.name)) fail(`template name must be a slug: ${JSON.stringify(tpl.name)}`);
    if (names.has(tpl.name)) fail(`duplicate template name: ${tpl.name}`);
    if (typeof tpl.title !== 'string' || tpl.title.length === 0) {
      fail(`template ${tpl.name}: title is required`);
    }
    try {
      resolveTemplateFile(tpl.path); // confinement is a manifest invariant
      if (tpl.docx != null) {
        if (typeof tpl.docx !== 'string' || !tpl.docx.endsWith('.docx')) fail(`template ${tpl.name}: docx must be a .docx path`);
        resolveTemplateFile(tpl.docx);
      }
    } catch (err) {
      if (err instanceof TemplateError && err.code === 'invalid_manifest') throw err;
      fail(`template ${tpl.name}: invalid path (${err.message})`);
    }
    names.add(tpl.name);
  }
  return manifest;
}

/** @returns {Promise<object|null>} the manifest, or null when absent (seed.js warns). */
export async function loadTemplateManifest() {
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
    throw new TemplateError('invalid_manifest', `catalog.json: not valid JSON (${err.message})`);
  }
  return validateTemplateManifest(manifest);
}

// ---- org templates (querySync, matching the other db/ modules) --------------

export function listCatalogTemplates() {
  return querySync('SELECT * FROM catalog_typst_templates ORDER BY name').rows;
}

/** Lists leave the Word reference blob out: `docx_bytes` says whether one exists. */
export function listOrgTemplates(orgId) {
  return querySync(
    `SELECT id, org_id, name, title, source, status, created_by, created_at, updated_at,
            length(docx) AS docx_bytes
     FROM org_typst_templates WHERE org_id = $1 ORDER BY name`, [orgId],
  ).rows;
}

export function getOrgTemplate(orgId, name) {
  return querySync(
    'SELECT * FROM org_typst_templates WHERE org_id = $1 AND name = $2', [orgId, name],
  ).rows[0] ?? null;
}

/** Upload = upsert: re-uploading a name replaces its source and re-activates it. */
export function upsertOrgTemplate({ orgId, name, title, source, createdBy = null }) {
  return querySync(
    `INSERT INTO org_typst_templates (org_id, name, title, source, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, name) DO UPDATE SET
       title = excluded.title,
       source = excluded.source,
       status = 'active',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING *`,
    [orgId, name, title, source, createdBy],
  ).rows[0];
}

/** Attach (or replace) the Word reference document of an org template; null removes it. */
export function setOrgTemplateDocx(orgId, name, docx) {
  return querySync(
    `UPDATE org_typst_templates
     SET docx = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE org_id = $1 AND name = $2
     RETURNING id, org_id, name, title, status, created_by, created_at, updated_at, length(docx) AS docx_bytes`,
    [orgId, name, docx],
  ).rows[0] ?? null;
}

export function setOrgTemplateStatus(orgId, name, status) {
  return querySync(
    `UPDATE org_typst_templates
     SET status = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE org_id = $1 AND name = $2
     RETURNING *`,
    [orgId, name, status],
  ).rows[0] ?? null;
}

/**
 * Resolve the Typst source for a document's `template:` name at render time.
 * An ACTIVE org template shadows a catalog template of the same name. No name
 * → null (Pandoc's built-in layout). An unknown or unavailable name throws
 * TemplateError('not_found') — a typo must not silently render as the
 * default layout when the whole point is page geometry.
 * @returns {Promise<{ name: string, source: string, origin: 'org'|'catalog' }|null>}
 */
export async function resolveTemplateSource(orgId, name) {
  if (!name) return null;
  if (orgId != null) {
    const row = querySync(
      `SELECT * FROM org_typst_templates WHERE org_id = $1 AND name = $2 AND status = 'active'`,
      [orgId, name],
    ).rows[0];
    if (row) return { name, source: row.source, origin: 'org' };
  }
  const cat = querySync(
    'SELECT * FROM catalog_typst_templates WHERE name = $1 AND available = 1', [name],
  ).rows[0];
  if (cat) {
    try {
      return { name, source: await readCatalogTemplateFile(cat.path), origin: 'catalog' };
    } catch (err) {
      throw new TemplateError('not_found', `Template "${name}" is missing from this deployment (${err.message})`);
    }
  }
  throw new TemplateError('not_found', `Unknown template "${name}" — see the template list (front matter \`template:\`)`);
}

/**
 * The Word reference document for a `template:` name at docx export time —
 * same shadowing as resolveTemplateSource. Null when the name is absent or
 * the template has no reference document (Pandoc's stock one applies); an
 * unknown name throws exactly as the Typst side does.
 * @returns {Promise<{ name: string, docx: Buffer, origin: 'org'|'catalog' }|null>}
 */
export async function resolveTemplateDocx(orgId, name) {
  if (!name) return null;
  if (orgId != null) {
    const row = querySync(
      `SELECT docx FROM org_typst_templates WHERE org_id = $1 AND name = $2 AND status = 'active'`,
      [orgId, name],
    ).rows[0];
    if (row) return row.docx ? { name, docx: Buffer.from(row.docx), origin: 'org' } : null;
  }
  const cat = querySync(
    'SELECT * FROM catalog_typst_templates WHERE name = $1 AND available = 1', [name],
  ).rows[0];
  if (cat) {
    if (!cat.docx_path) return null;
    try {
      return { name, docx: await readFile(await realTemplateFile(cat.docx_path)), origin: 'catalog' };
    } catch {
      return null; // a missing reference document degrades to Pandoc's stock one
    }
  }
  throw new TemplateError('not_found', `Unknown template "${name}" — see the template list (front matter \`template:\`)`);
}
