// Story 018: project-root-enforcing storage service. Every file operation on
// user projects — HTTP routes and agent tools alike — goes through this module.
// Nothing else in the codebase may touch project files with raw fs calls.

import {
  mkdir, readFile, writeFile, rm, rename, readdir, lstat, realpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

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
 * Resolve a user/agent-supplied relative path to an absolute path that is
 * guaranteed to live inside the project root. Rejects absolute paths, `..`
 * traversal, and symlinks that resolve outside the root.
 */
export async function resolveSafe(projectId, relPath) {
  const root = await resolveProjectDir(projectId);

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
    throw new StorageError('outside_root', 'Path escapes the project root');
  }

  const abs = resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new StorageError('outside_root', 'Path escapes the project root');
  }

  // Symlink containment: real-path the deepest existing ancestor (the target
  // itself may not exist yet, e.g. on first write) and verify it is still
  // under the root.
  const real = await realpathDeepestExisting(abs, root);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new StorageError('outside_root', 'Path resolves outside the project root');
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
      if (err.code !== 'ENOENT' || current === stopAt || current === dirname(current)) {
        throw err;
      }
      suffix = suffix ? join(current.slice(dirname(current).length + 1), suffix)
                      : current.slice(dirname(current).length + 1);
      current = dirname(current);
    }
  }
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

/** Move/rename a file or directory within the project. */
export async function moveProjectEntry(projectId, fromPath, toPath) {
  const { root, abs: from } = await resolveSafe(projectId, fromPath);
  const { abs: to } = await resolveSafe(projectId, toPath);
  if (from === root || to === root) {
    throw new StorageError('invalid_path', 'Cannot move the project root');
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
