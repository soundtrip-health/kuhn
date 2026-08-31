// STH-58: Marp slide themes. catalog_slide_themes mirrors catalog_scripts —
// Kuhn-shipped rows seeded from slide-themes/catalog.json (CSS files in the
// repo tree, org-independent, read-only at runtime; reads bypass storage.js
// with their own confinement, same stance as script-catalog.js). Org-uploaded
// theme CSS lives in org_slide_themes as DB text (small, diffable); an active
// org theme shadows a catalog theme of the same name at render time.

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { config } from '../config.js';
import { querySync } from '../db.js';

/** Themes bundled inside marp-cli itself — selectable with no CSS of ours. */
export const MARP_BUILTIN_THEMES = ['default', 'gaia', 'uncover'];

export class ThemeError extends Error {
  /** @param {'invalid'|'not_found'|'invalid_path'|'outside_root'|'invalid_manifest'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ThemeError';
    this.code = code;
  }
}

const catalogRoot = () => resolve(config.slideThemes.catalogRoot);

/** Lexical confinement to slide-themes/ (symlinks re-checked at read time). */
export function resolveThemeFile(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    throw new ThemeError('invalid_path', 'Theme path is required');
  }
  if (isAbsolute(relPath)) {
    throw new ThemeError('outside_root', 'Absolute theme paths are not allowed');
  }
  const normalized = normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new ThemeError('outside_root', `Theme path escapes slide-themes/: ${relPath}`);
  }
  const root = catalogRoot();
  const abs = resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ThemeError('outside_root', `Theme path escapes slide-themes/: ${relPath}`);
  }
  return abs;
}

async function realThemeFile(relPath) {
  const abs = resolveThemeFile(relPath);
  let real;
  try {
    real = await realpath(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new ThemeError('not_found', `No such theme file: ${relPath}`);
    throw err;
  }
  const root = await realpath(catalogRoot());
  if (real !== root && !real.startsWith(root + sep)) {
    throw new ThemeError('outside_root', `Theme path escapes slide-themes/: ${relPath}`);
  }
  return real;
}

/** Whether a theme's CSS exists in this checkout (seed availability). */
export async function themeFileExists(relPath) {
  let real;
  try {
    real = await realThemeFile(relPath);
  } catch (err) {
    if (err instanceof ThemeError && (err.code === 'not_found' || err.code === 'outside_root')) return false;
    throw err;
  }
  return (await stat(real)).isFile();
}

/** @returns {Promise<string>} UTF-8 CSS text */
export async function readCatalogThemeFile(relPath) {
  return readFile(await realThemeFile(relPath), 'utf-8');
}

/** The `/* @theme name *​/` header marp requires in every theme CSS. */
export function themeNameFromCss(css) {
  const m = /\/\*\s*@theme\s+([A-Za-z0-9][\w-]*)\s*\*\//.exec(String(css));
  return m ? m[1] : null;
}

const isThemeName = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);
const fail = (msg) => { throw new ThemeError('invalid_manifest', `catalog.json: ${msg}`); };

/** Structural validation; throws ThemeError('invalid_manifest') with the first problem. */
export function validateThemeManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('manifest must be an object');
  }
  if (!Number.isInteger(manifest.catalog_version) || manifest.catalog_version < 1) {
    fail('catalog_version must be a positive integer');
  }
  if (!Array.isArray(manifest.themes)) fail('themes must be an array');
  const names = new Set();
  for (const theme of manifest.themes) {
    if (theme === null || typeof theme !== 'object') fail('every theme must be an object');
    if (!isThemeName(theme.name)) fail(`theme name must be a slug: ${JSON.stringify(theme.name)}`);
    if (names.has(theme.name)) fail(`duplicate theme name: ${theme.name}`);
    if (MARP_BUILTIN_THEMES.includes(theme.name)) fail(`theme name shadows a marp built-in: ${theme.name}`);
    if (typeof theme.title !== 'string' || theme.title.length === 0) {
      fail(`theme ${theme.name}: title is required`);
    }
    try {
      resolveThemeFile(theme.path); // confinement is a manifest invariant
    } catch (err) {
      fail(`theme ${theme.name}: invalid path (${err.message})`);
    }
    names.add(theme.name);
  }
  return manifest;
}

/** @returns {Promise<object|null>} the manifest, or null when absent (seed.js warns). */
export async function loadThemeManifest() {
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
    throw new ThemeError('invalid_manifest', `catalog.json: not valid JSON (${err.message})`);
  }
  return validateThemeManifest(manifest);
}

// ---- org themes (querySync, matching the other db/ modules) -----------------

export function listCatalogThemes() {
  return querySync('SELECT * FROM catalog_slide_themes ORDER BY name').rows;
}

export function listOrgThemes(orgId) {
  return querySync(
    'SELECT * FROM org_slide_themes WHERE org_id = $1 ORDER BY name', [orgId],
  ).rows;
}

export function getOrgTheme(orgId, name) {
  return querySync(
    'SELECT * FROM org_slide_themes WHERE org_id = $1 AND name = $2', [orgId, name],
  ).rows[0] ?? null;
}

/** Upload = upsert: re-uploading a name replaces its CSS and re-activates it. */
export function upsertOrgTheme({ orgId, name, title, css, createdBy = null }) {
  return querySync(
    `INSERT INTO org_slide_themes (org_id, name, title, css, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, name) DO UPDATE SET
       title = excluded.title,
       css = excluded.css,
       status = 'active',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING *`,
    [orgId, name, title, css, createdBy],
  ).rows[0];
}

export function setOrgThemeStatus(orgId, name, status) {
  return querySync(
    `UPDATE org_slide_themes
     SET status = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE org_id = $1 AND name = $2
     RETURNING *`,
    [orgId, name, status],
  ).rows[0] ?? null;
}

/**
 * Resolve the CSS to mount for a deck's `theme:` name at render time. An
 * ACTIVE org theme shadows a catalog theme of the same name; marp built-ins
 * (and unknown names) resolve to null — marp then handles or rejects the
 * name itself, exactly as before STH-58.
 * @returns {Promise<{ name: string, css: string, source: 'org'|'catalog' }|null>}
 */
export async function resolveThemeCss(orgId, name) {
  if (!name || MARP_BUILTIN_THEMES.includes(name)) return null;
  if (orgId != null) {
    const row = querySync(
      `SELECT * FROM org_slide_themes WHERE org_id = $1 AND name = $2 AND status = 'active'`,
      [orgId, name],
    ).rows[0];
    if (row) return { name, css: row.css, source: 'org' };
  }
  const cat = querySync(
    'SELECT * FROM catalog_slide_themes WHERE name = $1 AND available = 1', [name],
  ).rows[0];
  if (cat) {
    try {
      return { name, css: await readCatalogThemeFile(cat.path), source: 'catalog' };
    } catch {
      return null; // missing file degrades to marp's own unknown-theme handling
    }
  }
  return null;
}
