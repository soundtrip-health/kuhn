// Issue #65: reader for the Kuhn-curated knowledge catalog. The catalog is
// guidance-docs/catalog.json plus the content files it points at — shipped in
// the repo tree, org-independent, and read-only at runtime. Reads deliberately
// bypass storage.js (which enforces tenant roots): the catalog lives outside
// every tenant root, so it gets its own confinement below rather than a
// widened resolveSafe. Do NOT loosen this to serve tenant-supplied paths.

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { config } from '../config.js';

const ITEM_KINDS = ['document', 'knowledge-card'];

export class CatalogError extends Error {
  /** @param {'invalid_path'|'outside_root'|'not_found'|'invalid_manifest'|'conflict'} code */
  constructor(code, message) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

/** Read at call time so tests can repoint config.knowledge.catalogRoot. */
const catalogRoot = () => resolve(config.knowledge.catalogRoot);

/**
 * Resolve a manifest-relative content path to an absolute path guaranteed to
 * live inside the catalog root. Rejects absolute paths, `..` traversal, and
 * null bytes (same discipline as storage.js resolveWithin, minus tenancy).
 * Purely lexical — symlink escapes are re-checked at read time.
 */
export function resolveCatalogFile(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new CatalogError('invalid_path', 'Catalog path is required');
  }
  if (relPath.includes('\0')) {
    throw new CatalogError('invalid_path', 'Catalog path contains a null byte');
  }
  if (isAbsolute(relPath)) {
    throw new CatalogError('outside_root', 'Absolute catalog paths are not allowed');
  }
  const normalized = normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new CatalogError('outside_root', `Catalog path escapes guidance-docs/: ${relPath}`);
  }
  const root = catalogRoot();
  const abs = resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new CatalogError('outside_root', `Catalog path escapes guidance-docs/: ${relPath}`);
  }
  return abs;
}

/**
 * Resolve a catalog path all the way to its realpath, enforcing containment on
 * the resolved target so a symlink inside guidance-docs/ cannot reach outside.
 * The single confinement rule shared by existence checks and reads: a file
 * that cannot legally be read through this boundary must never be reported as
 * available either.
 */
async function realCatalogFile(relPath) {
  const abs = resolveCatalogFile(relPath);
  let real;
  try {
    real = await realpath(abs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CatalogError('not_found', `No such catalog file: ${relPath}`);
    }
    throw err;
  }
  const root = await realpath(catalogRoot());
  if (real !== root && !real.startsWith(root + sep)) {
    throw new CatalogError('outside_root', `Catalog path escapes guidance-docs/: ${relPath}`);
  }
  return real;
}

/**
 * Whether an item's content file exists in this checkout (seed availability).
 * Same realpath confinement as readCatalogFile: a missing file and a symlink
 * escaping the catalog root are both simply unavailable.
 */
export async function catalogFileExists(relPath) {
  let real;
  try {
    real = await realCatalogFile(relPath);
  } catch (err) {
    if (err instanceof CatalogError
      && (err.code === 'not_found' || err.code === 'outside_root')) return false;
    throw err;
  }
  return (await stat(real)).isFile();
}

/**
 * Read one catalog content file for import. Re-checks containment on the
 * realpath so a symlink inside guidance-docs/ cannot serve bytes from outside.
 * @returns {Promise<Buffer>}
 */
export async function readCatalogFile(relPath) {
  return readFile(await realCatalogFile(relPath));
}

const fail = (msg) => { throw new CatalogError('invalid_manifest', `catalog.json: ${msg}`); };
const isSlug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);

/** Structural validation. Throws CatalogError('invalid_manifest') with the first problem. */
export function validateCatalogManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('manifest must be an object');
  }
  if (!Number.isInteger(manifest.catalog_version) || manifest.catalog_version < 1) {
    fail('catalog_version must be a positive integer');
  }
  if (!Array.isArray(manifest.packages)) fail('packages must be an array');

  const packageIds = new Set();
  const itemIds = new Set();
  for (const pkg of manifest.packages) {
    if (pkg === null || typeof pkg !== 'object') fail('every package must be an object');
    if (!isSlug(pkg.id)) fail(`package id must be a slug: ${JSON.stringify(pkg.id)}`);
    if (packageIds.has(pkg.id)) fail(`duplicate package id: ${pkg.id}`);
    if (typeof pkg.title !== 'string' || pkg.title.length === 0) {
      fail(`package ${pkg.id}: title is required`);
    }
    if (pkg.parent != null && !packageIds.has(pkg.parent)) {
      // Also enforces declaration order: seed.js inserts packages in manifest
      // order and knowledge_packages.parent_id is a FOREIGN KEY.
      fail(`package ${pkg.id}: parent "${pkg.parent}" must be declared earlier in the manifest`);
    }
    if (!Array.isArray(pkg.items)) fail(`package ${pkg.id}: items must be an array`);
    packageIds.add(pkg.id);

    for (const item of pkg.items) {
      if (item === null || typeof item !== 'object') fail(`package ${pkg.id}: every item must be an object`);
      if (typeof item.id !== 'string' || !item.id.startsWith(`${pkg.id}/`)) {
        fail(`item id must be "<package>/<slug>": ${JSON.stringify(item.id)}`);
      }
      if (itemIds.has(item.id)) fail(`duplicate item id: ${item.id}`);
      if (typeof item.title !== 'string' || item.title.length === 0) {
        fail(`item ${item.id}: title is required`);
      }
      if (!Number.isInteger(item.version) || item.version < 1) {
        fail(`item ${item.id}: version must be a positive integer`);
      }
      if (!ITEM_KINDS.includes(item.kind)) {
        fail(`item ${item.id}: kind must be one of ${ITEM_KINDS.join(', ')}`);
      }
      if (item.tags != null
        && !(Array.isArray(item.tags) && item.tags.every((t) => typeof t === 'string'))) {
        fail(`item ${item.id}: tags must be an array of strings`);
      }
      try {
        resolveCatalogFile(item.path); // confinement is a manifest invariant
      } catch (err) {
        fail(`item ${item.id}: invalid path (${err.message})`);
      }
      itemIds.add(item.id);
    }
  }
  return manifest;
}

/**
 * Load and validate guidance-docs/catalog.json.
 * @returns {Promise<object|null>} the manifest, or null when the file is
 * absent (a checkout without a published catalog seeds nothing — seed.js
 * warns and moves on).
 */
export async function loadCatalogManifest() {
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
    throw new CatalogError('invalid_manifest', `catalog.json: not valid JSON (${err.message})`);
  }
  return validateCatalogManifest(manifest);
}
