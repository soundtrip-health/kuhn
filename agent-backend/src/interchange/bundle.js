// Interchange bundle: parse + validate (issue #153; docs/specs/interchange-bundle.md §3).
//
// A bundle is a zip: manifest.json, optional references.json, and every
// document and asset under files/<workspace path>. This module turns the zip
// bytes into a checked, normalized in-memory bundle and NOTHING ELSE — no DB,
// no storage. Validation is complete before the caller writes a byte, which
// is what lets the import be all-or-nothing at the validation stage.
//
// Limits are enforced while the zip is still being read (fflate's filter
// sees each entry's uncompressed size before inflating it), so a zip bomb is
// refused on its declared sizes rather than after filling memory.

import { posix } from 'node:path';
import { unzipSync } from 'fflate';

import { config } from '../config.js';
import { CITE_KEY_RE } from '../db/references.js';

export const SCHEMA_VERSION = '1';
export const PROJECT_TYPES = ['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'];
const RESERVED_ROOT_FILES = new Set(['manifest.json', 'references.json', 'comments.json']);
const MAX_NAME_LENGTH = 200;
const MAX_KEY_LENGTH = 100;
const MAX_TITLE_LENGTH = 500;

/** Validation failure. `code` is 'invalid_bundle' (→ 400) or 'too_large' (→ 413). */
export class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BundleError';
    this.code = code;
  }
}

const invalid = (message) => new BundleError('invalid_bundle', message);
const tooLarge = (message) => new BundleError('too_large', message);

/**
 * Parse a bundle zip.
 * @param {Buffer} buffer
 * @returns {{
 *   manifest: object,
 *   references: object[],                    // normalized insert records (citeKey, title, authors[], …)
 *   docs: {path: string, title: string|null, meta: object|null, content: string}[],
 *   assets: Map<string, Buffer>,             // workspace path → bytes (files not listed as docs)
 * }}
 */
export function parseBundle(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalid('bundle is empty');
  const { maxBundleBytes, maxEntries } = config.interchange;
  const maxFile = config.storage.maxFileBytes;

  let total = 0;
  let count = 0;
  let unzipped;
  try {
    unzipped = unzipSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length), {
      filter: (entry) => {
        if (entry.name.endsWith('/')) return false; // directory placeholders
        count += 1;
        if (count > maxEntries) throw tooLarge(`bundle has more than ${maxEntries} entries`);
        if (entry.originalSize > maxFile) throw tooLarge(`${entry.name} exceeds ${maxFile} bytes`);
        total += entry.originalSize;
        if (total > maxBundleBytes) throw tooLarge(`bundle exceeds ${maxBundleBytes} bytes uncompressed`);
        return true;
      },
    });
  } catch (err) {
    if (err instanceof BundleError) throw err;
    throw invalid(`not a zip archive: ${err?.message ?? err}`);
  }

  const entries = new Map(
    Object.entries(unzipped).map(([name, data]) => [name, Buffer.from(data.buffer, data.byteOffset, data.length)]),
  );
  const prefix = rootPrefix(entries);
  const rootFile = (name) => entries.get(prefix + name);

  const manifestBuf = rootFile('manifest.json');
  if (!manifestBuf) throw invalid('manifest.json is missing');
  const manifest = validateManifest(parseJson(manifestBuf, 'manifest.json'));

  const referencesBuf = rootFile('references.json');
  const references = referencesBuf ? validateReferences(parseJson(referencesBuf, 'references.json')) : [];

  // Every other entry must live under files/ and be a safe workspace path.
  const workspace = new Map();
  for (const [name, buf] of entries) {
    const rel = name.slice(prefix.length);
    if (RESERVED_ROOT_FILES.has(rel)) continue;
    if (!rel.startsWith('files/')) {
      throw invalid(`unexpected entry ${rel}: documents and assets go under files/<workspace path>`);
    }
    const path = validateWorkspacePath(rel.slice('files/'.length));
    if (workspace.has(path)) throw invalid(`duplicate entry for ${path}`);
    workspace.set(path, buf);
  }

  const docs = [];
  const docPaths = new Set();
  for (const doc of manifest.docs) {
    const buf = workspace.get(doc.path);
    if (!buf) throw invalid(`manifest lists ${doc.path} but files/${doc.path} is not in the bundle`);
    docs.push({ path: doc.path, title: doc.title, meta: doc.meta, content: decodeUtf8(buf, doc.path) });
    docPaths.add(doc.path);
  }
  const assets = new Map();
  for (const [path, buf] of workspace) {
    if (!docPaths.has(path)) assets.set(path, buf);
  }
  return { manifest, references, docs, assets };
}

/**
 * Tolerate a bundle zipped with a single wrapping directory (`zip -r
 * bundle/`): if manifest.json is not at the root but every entry shares one
 * top-level directory that holds it, that directory is the root.
 */
function rootPrefix(entries) {
  if (entries.has('manifest.json')) return '';
  const tops = new Set([...entries.keys()].map((n) => n.split('/')[0]));
  if (tops.size !== 1) return '';
  const [top] = tops;
  return entries.has(`${top}/manifest.json`) ? `${top}/` : '';
}

function parseJson(buf, name) {
  try {
    return JSON.parse(buf.toString('utf-8'));
  } catch (err) {
    throw invalid(`${name} is not valid JSON: ${err.message}`);
  }
}

function decodeUtf8(buf, path) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw invalid(`${path} is not valid UTF-8 text`);
  }
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const optionalString = (v, what, max = MAX_NAME_LENGTH) => {
  if (v == null) return null;
  if (typeof v !== 'string') throw invalid(`${what} must be a string`);
  const s = v.trim();
  if (s.length > max) throw invalid(`${what} exceeds ${max} characters`);
  return s || null;
};

/**
 * A workspace-relative path from the bundle: forward slashes only, no
 * absolute/`..`/`.`/empty segments, no `.git` segment, no control chars.
 * storage.js re-checks containment at write time; this is the early, whole-
 * bundle refusal so a bad path fails the import before anything is written.
 */
export function validateWorkspacePath(path) {
  if (typeof path !== 'string' || path.length === 0) throw invalid('empty file path in bundle');
  if (path.length > 1024) throw invalid('file path too long');
  if (/[\0-\x1f\x7f]/.test(path)) throw invalid(`control character in path: ${JSON.stringify(path)}`);
  if (path.includes('\\')) throw invalid(`backslash in path (use forward slashes): ${path}`);
  if (path.startsWith('/')) throw invalid(`absolute path in bundle: ${path}`);
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') throw invalid(`unsafe path in bundle: ${path}`);
    if (seg === '.git') throw invalid(`reserved path segment .git: ${path}`);
  }
  if (posix.normalize(path) !== path) throw invalid(`unnormalized path in bundle: ${path}`);
  return path;
}

function validateManifest(m) {
  if (!isPlainObject(m)) throw invalid('manifest.json must be an object');
  if (String(m.schema_version) !== SCHEMA_VERSION) {
    throw invalid(`unsupported schema_version ${JSON.stringify(m.schema_version)} (expected "${SCHEMA_VERSION}")`);
  }
  const source = isPlainObject(m.source) ? m.source : {};
  if (m.source != null && !isPlainObject(m.source)) throw invalid('manifest.source must be an object');
  if (Buffer.byteLength(JSON.stringify(source)) > config.interchange.maxMetaBytes) {
    throw invalid('manifest.source is too large');
  }

  let project = null;
  if (m.project != null) {
    if (!isPlainObject(m.project)) throw invalid('manifest.project must be an object');
    const name = optionalString(m.project.name, 'manifest.project.name');
    const projectType = optionalString(m.project.project_type, 'manifest.project.project_type');
    if (projectType && !PROJECT_TYPES.includes(projectType)) {
      throw invalid(`manifest.project.project_type must be one of ${PROJECT_TYPES.join(', ')}`);
    }
    let orgId = null;
    if (m.project.org_id != null) {
      orgId = Number(m.project.org_id);
      if (!Number.isInteger(orgId)) throw invalid('manifest.project.org_id must be an integer');
    }
    project = { name, project_type: projectType ?? 'manuscript', org_id: orgId };
  }

  if (!Array.isArray(m.docs) || m.docs.length === 0) throw invalid('manifest.docs must be a non-empty array');
  const seen = new Set();
  const docs = m.docs.map((d, i) => {
    if (!isPlainObject(d)) throw invalid(`manifest.docs[${i}] must be an object`);
    const path = validateWorkspacePath(d.path);
    if (seen.has(path)) throw invalid(`manifest.docs lists ${path} twice`);
    seen.add(path);
    let meta = null;
    if (d.meta != null) {
      if (!isPlainObject(d.meta)) throw invalid(`manifest.docs[${i}].meta must be an object`);
      if (Buffer.byteLength(JSON.stringify(d.meta)) > config.interchange.maxMetaBytes) {
        throw invalid(`manifest.docs[${i}].meta exceeds ${config.interchange.maxMetaBytes} bytes`);
      }
      meta = d.meta;
    }
    return { path, title: optionalString(d.title, `manifest.docs[${i}].title`, MAX_TITLE_LENGTH), meta };
  });

  return { schema_version: SCHEMA_VERSION, source, project, docs };
}

/** "Family, Given" strings, accepting {family, given} objects and bare "Given Family". */
function normalizeAuthor(a, where) {
  if (typeof a === 'string') {
    const s = a.trim();
    if (!s) throw invalid(`${where}: empty author`);
    if (s.includes(',') || s.startsWith('{')) return s;
    const parts = s.split(/\s+/);
    return parts.length < 2 ? s : `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
  }
  if (isPlainObject(a)) {
    const family = optionalString(a.family, `${where}.family`);
    const given = optionalString(a.given, `${where}.given`);
    if (!family) throw invalid(`${where}: author.family is required`);
    return given ? `${family}, ${given}` : family;
  }
  throw invalid(`${where}: author must be a string or {family, given}`);
}

function validateReferences(list) {
  if (!Array.isArray(list)) throw invalid('references.json must be an array');
  const seen = new Set();
  return list.map((r, i) => {
    const where = `references[${i}]`;
    if (!isPlainObject(r)) throw invalid(`${where} must be an object`);
    const citeKey = optionalString(r.cite_key, `${where}.cite_key`, MAX_KEY_LENGTH);
    if (!citeKey || !CITE_KEY_RE.test(citeKey)) {
      throw invalid(`${where}.cite_key must match ${CITE_KEY_RE} (got ${JSON.stringify(r.cite_key)})`);
    }
    if (seen.has(citeKey)) throw invalid(`references.json lists ${citeKey} twice`);
    seen.add(citeKey);
    const title = optionalString(r.title, `${where}.title`, 2000);
    if (!title) throw invalid(`${where}.title is required`);
    if (r.authors != null && !Array.isArray(r.authors)) throw invalid(`${where}.authors must be an array`);
    let year = null;
    if (r.year != null && r.year !== '') {
      year = Number(r.year);
      if (!Number.isInteger(year)) throw invalid(`${where}.year must be an integer`);
    }
    const str = (k, max = 2000) => optionalString(r[k], `${where}.${k}`, max);
    return {
      citeKey,
      entryType: str('entry_type', 40) ?? 'article',
      title,
      authors: (r.authors ?? []).map((a, j) => normalizeAuthor(a, `${where}.authors[${j}]`)),
      year,
      journal: str('journal'),
      volume: str('volume'),
      issue: str('issue'),
      pages: str('pages'),
      publisher: str('publisher'),
      doi: str('doi'),
      pmid: str('pmid'),
      pmcid: str('pmcid'),
      url: str('url'),
      abstract: str('abstract', 20000),
      sourceType: 'import',
    };
  });
}
