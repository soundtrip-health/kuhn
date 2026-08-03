// Story 018: root-enforcing storage service. Every file operation on user
// content — HTTP routes and agent tools alike — goes through this module.
// Nothing else in the codebase may touch project or org files with raw fs
// calls. Two scopes share one containment core (resolveWithin): per-project
// workspaces (<projectsRoot>/<id>) and, since story 006-001, per-org library
// roots (<orgsRoot>/<orgId>/library).

import {
  mkdir, readFile, writeFile, rm, rename, readdir, lstat, realpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { config } from './config.js';
import { query as dbQuery } from './db.js';

export class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code; // 'not_found' | 'outside_root' | 'invalid_path' | 'too_large' | 'conflict'
  }
}

const maxFileBytes = () => config.storage.maxFileBytes;

/**
 * Resolve (and create) the workspace directory for a project. Uses
 * projects.root_path when set, else <projectsRoot>/<projectId>.
 * Throws not_found if the project row does not exist.
 */
export async function resolveProjectDir(projectId) {
  const { rows } = await dbQuery('SELECT root_path FROM projects WHERE id = $1', [projectId]);
  if (rows.length === 0) {
    throw new StorageError('not_found', `Unknown project: ${projectId}`);
  }
  const dir = rows[0].root_path
    ? (isAbsolute(rows[0].root_path)
        ? rows[0].root_path
        : resolve(config.agent.projectsRoot, rows[0].root_path))
    : join(config.agent.projectsRoot, String(projectId));
  await mkdir(dir, { recursive: true });
  // Real path so the containment checks below compare like with like even
  // when projectsRoot itself sits behind a symlink (e.g. /tmp on macOS).
  return realpath(dir);
}

/**
 * Resolve (and create) an organization's library directory:
 * <orgsRoot>/<orgId>/library. Throws not_found if the org row does not exist.
 * (story 006-001)
 */
export async function resolveOrgLibraryDir(orgId) {
  const { rows } = await dbQuery('SELECT id FROM organizations WHERE id = $1', [orgId]);
  if (rows.length === 0) {
    throw new StorageError('not_found', `Unknown organization: ${orgId}`);
  }
  const dir = join(config.storage.orgsRoot, String(orgId), 'library');
  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

/**
 * Resolve a user/agent-supplied relative path to an absolute path that is
 * guaranteed to live inside the project root. Rejects absolute paths, `..`
 * traversal, and symlinks that resolve outside the root.
 */
export async function resolveSafe(projectId, relPath) {
  return resolveWithin(await resolveProjectDir(projectId), relPath, 'project root');
}

/** Same containment contract, scoped to an org's library root. (006-001) */
export async function resolveOrgSafe(orgId, relPath) {
  return resolveWithin(await resolveOrgLibraryDir(orgId), relPath, 'library root');
}

/**
 * The containment core shared by both scopes: rejects absolute paths, `..`
 * traversal, and symlinks that resolve outside the given root.
 */
async function resolveWithin(root, relPath, what) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new StorageError('invalid_path', 'Path is required');
  }
  if (relPath.includes('\0')) {
    throw new StorageError('invalid_path', 'Path contains a null byte');
  }
  if (isAbsolute(relPath)) {
    throw new StorageError('outside_root', 'Absolute paths are not allowed');
  }
  const normalized = normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new StorageError('outside_root', `Path escapes the ${what}`);
  }
  // The version-history repo (story 008-002) is not user content: no surface
  // of this API — routes, agent tools, tree, search — may see or touch it.
  if (normalized.split(sep).includes('.git')) {
    throw new StorageError('invalid_path', 'Reserved path segment: .git');
  }

  const abs = resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new StorageError('outside_root', `Path escapes the ${what}`);
  }

  // Symlink containment: real-path the deepest existing ancestor (the target
  // itself may not exist yet, e.g. on first write) and verify it is still
  // under the root.
  const real = await realpathDeepestExisting(abs, root);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new StorageError('outside_root', `Path resolves outside the ${what}`);
  }

  return { root, abs };
}

async function realpathDeepestExisting(abs, stopAt) {
  let current = abs;
  let suffix = '';
  for (;;) {
    try {
      const real = await realpath(current);
      return suffix ? join(real, suffix) : real;
    } catch (err) {
      // ENOTDIR: an ANCESTOR of the path is a file (`draft/main.md/sub` — a
      // plausible typo, reachable from the folder UI since story 012-001).
      // Map it to a 409 naming the blocking file instead of rethrowing bare,
      // which the routes turned into a generic 500 (story 012-005). Error
      // mapping only — the containment verdict below is unchanged.
      if (err.code === 'ENOTDIR') {
        throw new StorageError('conflict', `A file is in the way: ${await blockingFile(current, stopAt)}`);
      }
      if (err.code !== 'ENOENT' || current === stopAt || current === dirname(current)) {
        throw err;
      }
      suffix = suffix ? join(current.slice(dirname(current).length + 1), suffix)
                      : current.slice(dirname(current).length + 1);
      current = dirname(current);
    }
  }
}

/**
 * The deepest existing ancestor of `abs` that is a file — the component an
 * ENOTDIR came from. Peels segments until lstat stops failing; falls back to
 * the whole path if the walk cannot pin one down (a race with a concurrent
 * delete), because the 409 must not turn back into a 500.
 */
async function blockingFile(abs, root) {
  let probe = abs;
  while (probe !== root && probe !== dirname(probe)) {
    try {
      const stats = await lstat(probe);
      if (!stats.isDirectory()) return relative(root, probe);
      break;
    } catch {
      probe = dirname(probe);
    }
  }
  return relative(root, abs);
}

/** Read a file. Returns a Buffer (callers decide on encoding). */
export async function readProjectFile(projectId, relPath) {
  const { abs } = await resolveSafe(projectId, relPath);
  try {
    const stats = await lstat(abs);
    if (stats.isDirectory()) throw new StorageError('invalid_path', `Is a directory: ${relPath}`);
    if (stats.size > maxFileBytes()) {
      throw new StorageError('too_large', `File exceeds ${maxFileBytes()} bytes: ${relPath}`);
    }
    return await readFile(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('not_found', `No such file: ${relPath}`);
    throw err;
  }
}

/** Write (create or overwrite) a file. Returns { created } */
export async function writeProjectFile(projectId, relPath, data) {
  const { abs } = await resolveSafe(projectId, relPath);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
  if (buf.length > maxFileBytes()) {
    throw new StorageError('too_large', `Content exceeds ${maxFileBytes()} bytes`);
  }
  let created = true;
  try {
    await lstat(abs);
    created = false;
  } catch { /* new file */ }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  return { created };
}

/** Delete a file or directory (recursive). The project root itself cannot be deleted. */
export async function deleteProjectEntry(projectId, relPath) {
  const { root, abs } = await resolveSafe(projectId, relPath);
  if (abs === root) throw new StorageError('invalid_path', 'Cannot delete the project root');
  try {
    await lstat(abs);
  } catch {
    throw new StorageError('not_found', `No such file: ${relPath}`);
  }
  await rm(abs, { recursive: true });
}

/**
 * Root-relative posix path for an absolute path already contained by root.
 * This is the canonical form every path-keyed consumer is keyed by: it is
 * derived from the resolved absolute path, so `./dir/a.md`, `dir//a.md` and
 * `dir/a.md` all collapse to the same string and a trailing slash is gone.
 * (story 012-002)
 */
function relativeToRoot(root, abs) {
  return abs.slice(root.length + 1).split(sep).join('/');
}

/**
 * Move/rename a file or directory within the project.
 * Returns the CANONICAL relative paths it actually operated on — callers
 * publish THESE, never the raw request body, or the DB rewrite keyed on the
 * old path matches nothing (story 012-002).
 */
export async function moveProjectEntry(projectId, fromPath, toPath) {
  const { root, abs: from } = await resolveSafe(projectId, fromPath);
  const { abs: to } = await resolveSafe(projectId, toPath);
  if (from === root || to === root) {
    throw new StorageError('invalid_path', 'Cannot move the project root');
  }
  // Both of these reach rename(2) otherwise: a self-move succeeds as a no-op
  // that still publishes a move, and a folder into its own descendant fails
  // EINVAL — not a StorageError, so a 500 instead of a 400, after mkdir has
  // already left the destination directories behind. (story 012-002)
  if (to === from) {
    throw new StorageError('invalid_path', 'Source and destination are the same path');
  }
  if (to.startsWith(from + sep)) {
    throw new StorageError('invalid_path', 'Cannot move a folder into itself');
  }
  try {
    await lstat(from);
  } catch {
    throw new StorageError('not_found', `No such file: ${fromPath}`);
  }
  let destinationExists = true;
  try {
    await lstat(to);
  } catch {
    destinationExists = false;
  }
  if (destinationExists) throw new StorageError('conflict', `Destination exists: ${toPath}`);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return { from: relativeToRoot(root, from), to: relativeToRoot(root, to) };
}

/**
 * Create an empty directory (with any missing parents) inside the project.
 * Returns `{ path, created }` where `path` is the CANONICAL relative path —
 * same contract as moveProjectEntry, and for the same reason: the webapp keys
 * expansion and selection state by path, so `'a//b/'` must not become a second
 * key for the folder the tree reports as `a/b`. (story 012-001)
 *
 * Idempotent: an existing directory returns `created: false` rather than
 * throwing, so a double-submit is harmless. Anything that is NOT a directory
 * occupying the path is a `conflict` — this API never clobbers.
 */
export async function createProjectDir(projectId, relPath) {
  const { root, abs } = await resolveSafe(projectId, relPath);
  if (abs === root) throw new StorageError('invalid_path', 'Cannot create the project root');
  const path = relativeToRoot(root, abs);
  let stats = null;
  try {
    stats = await lstat(abs);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stats) {
    if (!stats.isDirectory()) {
      throw new StorageError('conflict', `A file already exists at ${path}`);
    }
    return { path, created: false };
  }
  try {
    await mkdir(abs, { recursive: true });
  } catch (err) {
    // Lost a race with a concurrent write that put a FILE here (or on an
    // ancestor) between the lstat above and now: still a conflict, not a 500.
    if (err.code === 'EEXIST' || err.code === 'ENOTDIR') {
      throw new StorageError('conflict', `A file already exists at ${path}`);
    }
    throw err;
  }
  return { path, created: true };
}

// ---- Org library scope (story 006-001) --------------------------------------
// Same read/write/delete contracts as the project scope, confined to
// <orgsRoot>/<orgId>/library via resolveOrgSafe.

/** Read an org library file. Returns a Buffer. */
export async function readOrgFile(orgId, relPath) {
  const { abs } = await resolveOrgSafe(orgId, relPath);
  try {
    const stats = await lstat(abs);
    if (stats.isDirectory()) throw new StorageError('invalid_path', `Is a directory: ${relPath}`);
    if (stats.size > maxFileBytes()) {
      throw new StorageError('too_large', `File exceeds ${maxFileBytes()} bytes: ${relPath}`);
    }
    return await readFile(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('not_found', `No such file: ${relPath}`);
    throw err;
  }
}

/** Write (create or overwrite) an org library file. Returns { created } */
export async function writeOrgFile(orgId, relPath, data) {
  const { abs } = await resolveOrgSafe(orgId, relPath);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
  if (buf.length > maxFileBytes()) {
    throw new StorageError('too_large', `Content exceeds ${maxFileBytes()} bytes`);
  }
  let created = true;
  try {
    await lstat(abs);
    created = false;
  } catch { /* new file */ }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  return { created };
}

/** Delete an org library file or directory (recursive); the root itself cannot be deleted. */
export async function deleteOrgEntry(orgId, relPath) {
  const { root, abs } = await resolveOrgSafe(orgId, relPath);
  if (abs === root) throw new StorageError('invalid_path', 'Cannot delete the library root');
  try {
    await lstat(abs);
  } catch {
    throw new StorageError('not_found', `No such file: ${relPath}`);
  }
  await rm(abs, { recursive: true });
}

/**
 * List the project tree. Symlinks are omitted entirely — they are never
 * followed, listed, or readable through this API.
 * Returns [{ name, path, type: 'file'|'dir', size?, children? }]
 */
export async function listProjectTree(projectId, relPath = '.') {
  const { root, abs } = await resolveSafe(projectId, relPath);
  return walkTree(abs, root);
}

async function walkTree(dir, root) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('not_found', 'No such directory');
    throw err;
  }
  const nodes = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === '.git') continue; // version history repo (008-002)
    const abs = join(dir, entry.name);
    const path = abs.slice(root.length + 1);
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path, type: 'dir', children: await walkTree(abs, root) });
    } else if (entry.isFile()) {
      const stats = await lstat(abs);
      nodes.push({
        name: entry.name,
        path,
        type: 'file',
        size: stats.size,
        mtime: stats.mtime.toISOString(),
      });
    }
  }
  return nodes;
}

const SEARCH_MAX_MATCHES = 100;
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;

/**
 * Search text files for a regex pattern (agent grep replacement).
 * Returns [{ path, line, text }], capped at SEARCH_MAX_MATCHES.
 */
export async function searchProjectFiles(projectId, pattern, relPath = '.') {
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    throw new StorageError('invalid_path', `Invalid pattern: ${err.message}`);
  }
  const tree = await listProjectTree(projectId, relPath);
  const matches = [];
  await searchNodes(projectId, tree, regex, matches);
  return matches;
}

async function searchNodes(projectId, nodes, regex, matches) {
  for (const node of nodes) {
    if (matches.length >= SEARCH_MAX_MATCHES) return;
    if (node.type === 'dir') {
      await searchNodes(projectId, node.children, regex, matches);
      continue;
    }
    if (node.size > SEARCH_MAX_FILE_BYTES) continue;
    const buf = await readProjectFile(projectId, node.path);
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length && matches.length < SEARCH_MAX_MATCHES; i++) {
      if (regex.test(lines[i])) {
        matches.push({ path: node.path, line: i + 1, text: lines[i].slice(0, 500) });
      }
    }
  }
}
