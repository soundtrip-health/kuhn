// Issue #68: reader for the Kuhn-curated shared-script catalog. The catalog
// is shared-scripts/catalog.json plus the script files it points at — shipped
// in the repo tree, org-independent, and read-only at runtime. Like
// knowledge-catalog.js, reads deliberately bypass storage.js: the catalog
// lives outside every tenant root, so it gets its own confinement rather
// than a widened resolveSafe. Do NOT loosen this to serve tenant-supplied
// paths.

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { config } from '../config.js';

export const SCRIPT_LANGUAGES = ['r', 'python'];

export class ScriptCatalogError extends Error {
  /** @param {'invalid_path'|'outside_root'|'not_found'|'invalid_manifest'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ScriptCatalogError';
    this.code = code;
  }
}

/** Read at call time so tests can repoint config.scripts.catalogRoot. */
const catalogRoot = () => resolve(config.scripts.catalogRoot);

/**
 * Resolve a manifest-relative script path to an absolute path guaranteed to
 * live inside the catalog root (lexical; symlinks re-checked at read time).
 */
export function resolveScriptFile(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new ScriptCatalogError('invalid_path', 'Script path is required');
  }
  if (relPath.includes('\0')) {
    throw new ScriptCatalogError('invalid_path', 'Script path contains a null byte');
  }
  if (isAbsolute(relPath)) {
    throw new ScriptCatalogError('outside_root', 'Absolute script paths are not allowed');
  }
  const normalized = normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new ScriptCatalogError('outside_root', `Script path escapes shared-scripts/: ${relPath}`);
  }
  const root = catalogRoot();
  const abs = resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ScriptCatalogError('outside_root', `Script path escapes shared-scripts/: ${relPath}`);
  }
  return abs;
}

/** Realpath + containment: a symlink escaping the root is unreadable AND unavailable. */
async function realScriptFile(relPath) {
  const abs = resolveScriptFile(relPath);
  let real;
  try {
    real = await realpath(abs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ScriptCatalogError('not_found', `No such script file: ${relPath}`);
    }
    throw err;
  }
  const root = await realpath(catalogRoot());
  if (real !== root && !real.startsWith(root + sep)) {
    throw new ScriptCatalogError('outside_root', `Script path escapes shared-scripts/: ${relPath}`);
  }
  return real;
}

/** Whether a script's content file exists in this checkout (seed availability). */
export async function scriptFileExists(relPath) {
  let real;
  try {
    real = await realScriptFile(relPath);
  } catch (err) {
    if (err instanceof ScriptCatalogError
      && (err.code === 'not_found' || err.code === 'outside_root')) return false;
    throw err;
  }
  return (await stat(real)).isFile();
}

/**
 * Read one catalog script for import.
 * @returns {Promise<string>} UTF-8 text — scripts are code, never binary
 */
export async function readCatalogScript(relPath) {
  return readFile(await realScriptFile(relPath), 'utf-8');
}

const fail = (msg) => { throw new ScriptCatalogError('invalid_manifest', `catalog.json: ${msg}`); };
// Script ids are "<group>/<slug>" (e.g. "r/summarize-csv") or a bare slug.
const isScriptId = (s) => typeof s === 'string'
  && /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/.test(s);

/** Structural validation. Throws ScriptCatalogError('invalid_manifest') with the first problem. */
export function validateScriptManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('manifest must be an object');
  }
  if (!Number.isInteger(manifest.catalog_version) || manifest.catalog_version < 1) {
    fail('catalog_version must be a positive integer');
  }
  if (!Array.isArray(manifest.scripts)) fail('scripts must be an array');

  const ids = new Set();
  for (const script of manifest.scripts) {
    if (script === null || typeof script !== 'object') fail('every script must be an object');
    if (!isScriptId(script.id)) fail(`script id must be a slug or group/slug: ${JSON.stringify(script.id)}`);
    if (ids.has(script.id)) fail(`duplicate script id: ${script.id}`);
    if (typeof script.title !== 'string' || script.title.length === 0) {
      fail(`script ${script.id}: title is required`);
    }
    if (!SCRIPT_LANGUAGES.includes(script.language)) {
      fail(`script ${script.id}: language must be one of ${SCRIPT_LANGUAGES.join(', ')}`);
    }
    if (!Number.isInteger(script.version) || script.version < 1) {
      fail(`script ${script.id}: version must be a positive integer`);
    }
    if (typeof script.entrypoint !== 'string' || script.entrypoint.length === 0
      || script.entrypoint.includes('/')) {
      fail(`script ${script.id}: entrypoint must be a bare filename`);
    }
    if (script.args != null) {
      if (!Array.isArray(script.args)) fail(`script ${script.id}: args must be an array`);
      for (const arg of script.args) {
        if (arg === null || typeof arg !== 'object' || typeof arg.name !== 'string' || !arg.name) {
          fail(`script ${script.id}: every arg needs a name`);
        }
      }
    }
    if (script.tags != null
      && !(Array.isArray(script.tags) && script.tags.every((t) => typeof t === 'string'))) {
      fail(`script ${script.id}: tags must be an array of strings`);
    }
    try {
      resolveScriptFile(script.path); // confinement is a manifest invariant
    } catch (err) {
      fail(`script ${script.id}: invalid path (${err.message})`);
    }
    ids.add(script.id);
  }
  return manifest;
}

/**
 * Load and validate shared-scripts/catalog.json.
 * @returns {Promise<object|null>} the manifest, or null when the file is
 * absent (a checkout without the catalog seeds nothing — seed.js warns).
 */
export async function loadScriptManifest() {
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
    throw new ScriptCatalogError('invalid_manifest', `catalog.json: not valid JSON (${err.message})`);
  }
  return validateScriptManifest(manifest);
}
