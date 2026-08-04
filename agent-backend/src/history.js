// Story 008-002: per-project version history on a plain git repository inside
// the project workspace (<projectDir>/.git). This module owns every git
// invocation — commits are serialized per project (git locks its index), the
// repo is created lazily on first commit, and `.git` is invisible to the rest
// of the system (storage.js refuses it as a path segment and skips it in the
// tree).
//
// Commit policy (who calls what):
//   - Editor autosaves + agent write bursts → scheduleCommit(): trailing
//     throttle, at most one commit per config.history.autoCommitMs window.
//   - Explicit user save (Cmd/Ctrl+S), agent job boundaries, and
//     before-destroy snapshots (delete/overwrite/restore) → commitNow().
// History is append-only: restore writes the old content back through the
// normal storage path and commits it as a new version — nothing is rewritten.

import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { config } from './config.js';
import { query as dbQuery } from './db.js';
import { StorageError, resolveProjectDir, resolveSafe } from './storage.js';

const run = promisify(execFile);

const COMMITTER = ['-c', 'user.name=Kuhn', '-c', 'user.email=history@kuhn.local', '-c', 'commit.gpgsign=false'];
const HASH_RE = /^[0-9a-f]{7,40}$/;

/** Run git in a project dir. Args are exec'd directly — never through a shell. */
async function git(dir, args, env = {}) {
  const { stdout } = await run('git', ['-C', dir, ...COMMITTER, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function hasRepo(dir) {
  try {
    await lstat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(dir) {
  if (!(await hasRepo(dir))) await git(dir, ['init', '-q']);
}

// ---- Attribution -------------------------------------------------------------

/** External-reviewer author email (epic 013): link-<id>@reviewers.kuhn.local.
 *  The id round-trips through listHistory the same way agent slugs do. */
const REVIEWER_EMAIL_RE = /^link-(\d+)@reviewers\.kuhn\.local$/;

/**
 * Resolve commit author identity. Precedence: agent > reviewer > user (an
 * agent write on behalf of a user is the agent's version), EXCEPT an explicit
 * reviewer checkpoint (epic 013, ?checkpoint=1 → reviewerCheckpoint) which
 * wins over agent meta pending in the same window — commitNow merges the
 * window's meta, and without the flag a reviewer's deliberate Cmd+S would be
 * relabeled as an agent save. Falls back to a generic user.
 * @param {{ agent?: string|null, userId?: number|null,
 *           reviewer?: { linkId: number, name?: string|null }|null,
 *           reviewerCheckpoint?: boolean }} meta
 */
async function authorFor(meta = {}) {
  if (meta.reviewer && (meta.reviewerCheckpoint === true || !meta.agent)) {
    return {
      name: `${meta.reviewer.name || 'External reviewer'} (external)`,
      email: `link-${meta.reviewer.linkId}@reviewers.kuhn.local`,
    };
  }
  if (meta.agent) {
    return { name: `Kuhn ${meta.agent}`, email: `${meta.agent}@agents.kuhn.local` };
  }
  if (meta.userId != null) {
    try {
      const { rows } = await dbQuery(
        'SELECT email, display_name FROM users WHERE id = $1', [meta.userId],
      );
      if (rows.length > 0) {
        return { name: rows[0].display_name || rows[0].email, email: rows[0].email };
      }
    } catch { /* attribution is best-effort — never block a commit on it */ }
  }
  return { name: 'Kuhn user', email: 'user@kuhn.local' };
}

// ---- Serialized commits ------------------------------------------------------

/** @type {Map<number, Promise<unknown>>} per-project op chain (git index lock) */
const chains = new Map();

function serialize(projectId, fn) {
  const key = Number(projectId);
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of the previous op's fate
  chains.set(key, next.then(() => undefined, () => undefined));
  return next;
}

/** @type {Map<number, { meta: object }>} pending trailing-throttle commits */
const pending = new Map();

function mergeMeta(a = {}, b = {}) {
  // Last writer wins per field; an agent touch anywhere in the window marks
  // the coalesced commit as agent-authored (mixed windows are rare and the
  // label says "edits", not a specific claim). Reviewer meta (epic 013)
  // coalesces the same way; the reviewerCheckpoint flag is sticky so an
  // explicit reviewer save keeps its attribution through the merge (it wins
  // over agent meta in authorFor).
  return {
    agent: b.agent ?? a.agent ?? null,
    userId: b.userId ?? a.userId ?? null,
    reviewer: b.reviewer ?? a.reviewer ?? null,
    reviewerCheckpoint: b.reviewerCheckpoint === true || a.reviewerCheckpoint === true,
    label: b.label ?? a.label ?? null,
  };
}

/**
 * Coalescing commit: the first call in a window schedules a commit
 * autoCommitMs out; further calls merge their attribution into it. Safe to
 * call from hot paths — all failures are logged, never thrown.
 */
export function scheduleCommit(projectId, meta = {}) {
  if (!config.history?.enabled) return;
  const key = Number(projectId);
  const entry = pending.get(key);
  if (entry) {
    entry.meta = mergeMeta(entry.meta, meta);
    return;
  }
  const created = { meta: { ...meta } };
  created.timer = setTimeout(() => {
    pending.delete(key);
    void commitNow(projectId, created.meta);
  }, config.history.autoCommitMs);
  created.timer.unref?.();
  pending.set(key, created);
}

/**
 * Commit the project's current state immediately (absorbing any pending
 * scheduled commit). No-op when nothing changed. Never throws.
 * @returns {Promise<string|null>} the new commit hash, or null
 */
export async function commitNow(projectId, meta = {}) {
  if (!config.history?.enabled) return null;
  const key = Number(projectId);
  const entry = pending.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(key);
    meta = mergeMeta(entry.meta, meta);
  }
  try {
    return await serialize(projectId, async () => {
      const dir = await resolveProjectDir(projectId);
      await ensureRepo(dir);
      const status = await git(dir, ['status', '--porcelain']);
      if (status.trim().length === 0) return null;
      await git(dir, ['add', '-A']);
      const author = await authorFor(meta);
      const label = meta.label
        || (meta.agent ? `${meta.agent} edits` : meta.reviewer ? 'External edits' : 'Edits');
      await git(dir, ['commit', '-q', '-m', label], {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: 'Kuhn',
        GIT_COMMITTER_EMAIL: 'history@kuhn.local',
      });
      return (await git(dir, ['rev-parse', 'HEAD'])).trim();
    });
  } catch (err) {
    console.error(`[history] Commit failed for project ${projectId}:`, err.message);
    return null;
  }
}

/** Test hook: wait out any in-flight serialized ops for a project. */
export function flushProject(projectId) {
  return chains.get(Number(projectId)) ?? Promise.resolve();
}

// ---- Reading history ---------------------------------------------------------

/**
 * List versions, newest first, optionally scoped to one file.
 * @returns {Promise<Array<{hash, shortHash, authorName, authorEmail, date,
 *   label, agent: string|null, external: boolean, reviewerLinkId: number|null}>>}
 */
export async function listHistory(projectId, relPath = null, limit = 50) {
  const dir = await resolveProjectDir(projectId);
  if (relPath != null) await resolveSafe(projectId, relPath); // containment + .git guard
  if (!(await hasRepo(dir))) return [];
  const format = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e';
  const args = ['log', `--format=${format}`, '-n', String(Math.min(Math.max(limit, 1), 200))];
  if (relPath != null) args.push('--', relPath);
  let out;
  try {
    out = await git(dir, args);
  } catch {
    return []; // repo exists but has no commits yet
  }
  return out
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, authorName, authorEmail, date, label] = record.split('\x1f');
      const agentMatch = /^(.+)@agents\.kuhn\.local$/.exec(authorEmail ?? '');
      // Epic 013: external-reviewer versions carry link-<id>@reviewers.kuhn.local
      // (the same author-email idiom as agents) → external flag + link id.
      const reviewerMatch = REVIEWER_EMAIL_RE.exec(authorEmail ?? '');
      return {
        hash,
        shortHash: hash.slice(0, 8),
        authorName,
        authorEmail,
        date,
        label,
        agent: agentMatch ? agentMatch[1] : null,
        external: reviewerMatch != null,
        reviewerLinkId: reviewerMatch ? Number(reviewerMatch[1]) : null,
      };
    });
}

/**
 * A file's content at a given version.
 * @returns {Promise<Buffer>}
 */
export async function fileAtVersion(projectId, relPath, ref) {
  if (typeof ref !== 'string' || !HASH_RE.test(ref)) {
    throw new StorageError('invalid_path', 'ref must be a commit hash');
  }
  await resolveSafe(projectId, relPath); // containment + .git guard
  const dir = await resolveProjectDir(projectId);
  if (!(await hasRepo(dir))) throw new StorageError('not_found', 'No history for this project');
  try {
    const { stdout } = await run(
      'git', ['-C', dir, 'show', `${ref}:${relPath}`],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
    );
    return stdout;
  } catch {
    throw new StorageError('not_found', `No version ${ref.slice(0, 8)} of ${relPath}`);
  }
}
