// Story 012-002: the ONE place a move re-keys path-keyed DB state. Storage is
// the source of truth and path is identity (deliberately no file-id column),
// so a move is only identity-preserving if every row keyed by the old path is
// rewritten atomically with the event that announces it. `applyMove` does all
// of that in a single better-sqlite3 transaction() and THROWS on failure —
// callers must not swallow it, or the fs rename that already happened would
// leave comments/pending edits/seen markers stranded at a path that no longer
// exists (exactly the AC-1 failure this story exists to eliminate).
//
// The fs rename stays OUTSIDE: transaction() bodies are synchronous and cannot
// await (db.js:45-61). Producers rename through storage first, then call this
// with the CANONICAL paths storage reports back.
//
// --- schema.sql path-column audit (the story's "enumerate the list") --------
// REWRITTEN here:
//   file_seen.path        (schema.sql:262, PK user+project+path) via migrateSeenPaths
//   comments.path         (schema.sql:368; roots AND replies — addReply copies
//                          root.path, db/comments.js:177-180)
//   pending_edits.path    (schema.sql:340, UNIQUE(project_id, path)) — see the
//                          collision and scope notes on rekeyPendingEdits
//   review_links.path     (epic 013; no unique key) — a live review link keeps
//                          pointing at its document across a move; the guest
//                          principal reads the row per request, so open
//                          reviewer sessions re-point transparently
//   projects.config JSON `activeDocument` (schema.sql:117)
// APPENDED to, never rewritten:
//   file_events.path      (schema.sql:240) — the activity log is append-only;
//                          history at the old path stays true. The move adds
//                          exactly one row (kind 'moved', path = NEW,
//                          meta = {from: OLD}); folder descendants are implied
//                          by prefix and are never enumerated as extra rows.
// DELIBERATELY NOT TOUCHED (path-LIKE but not a project file path):
//   projects.root_path            (schema.sql:118) — the workspace root itself
//   org_documents.filename        (schema.sql:276) — org-library bytes, org scope
//   org_document_chunks.heading_path (schema.sql:308) — a markdown heading trail
//   bib_references                (schema.sql:202) — has no path column at all
//   jobs.input/context, messages.tool_calls — free-form JSON/prose that may
//     mention a path; rewriting them would falsify the transcript.

import { posix } from 'node:path';

import { querySync, transaction } from '../db.js';
import { StorageError } from '../storage.js';
import { migrateSeenPaths, recordFileEvent } from './file-activity.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// The proven prefix idiom (db/file-activity.js:100-108). NOT SQLite replace()
// — that rewrites every occurrence and would corrupt `a/b/x/a/b.md`; NOT LIKE
// — `%` and `_` are legal filename characters. $1 = projectId, $2 = from,
// $3 = to. The `|| '/'` half is what keeps `dir` from matching `directive.md`.
const SUBTREE = "(path = $2 OR substr(path, 1, length($2) + 1) = $2 || '/')";
const REKEY = "$3 || substr(path, length($2) + 1)";

/**
 * Canonicalize a move endpoint. Storage already returns canonical posix
 * relative paths, but a raw `./dir/a.md`, `dir//a.md` or `dir/` reaching the
 * SUBTREE predicate matches ZERO rows and silently orphans the subtree, so we
 * re-derive it here rather than trust the caller.
 */
function canonical(path, label) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new StorageError('invalid_path', `move ${label} is empty`);
  }
  const clean = posix.normalize(path).replace(/\/+$/, '');
  if (clean === '' || clean === '.' || clean === '..' || clean.startsWith('../')
      || posix.isAbsolute(clean)) {
    throw new StorageError('invalid_path', `move ${label} is not project-relative: ${path}`);
  }
  return clean;
}

/**
 * The suggestion scope, mirrored from pending-edits.js:32-34 (first segment
 * exactly `draft`). Reimplemented rather than imported: pending-edits.js pulls
 * in project-events.js, which imports THIS module — an import cycle we do not
 * want in the transaction path. Keep the two in step.
 */
function isDraftScoped(path) {
  return posix.normalize(path).split('/')[0] === 'draft';
}

/** Rows under `from`, for tables we rewrite row-by-row. */
function subtreeRows(table, projectId, from) {
  return querySync(
    `SELECT id, path FROM ${table} WHERE project_id = $1 AND ${SUBTREE}`,
    [projectId, from],
  ).rows;
}

/**
 * pending_edits has UNIQUE (project_id, path) (schema.sql:350), so a move onto
 * a path that already holds a proposal is a real conflict. `UPDATE OR REPLACE`
 * would resolve it by DELETING the destination row — and that is not an edge
 * case: proposeEdit deliberately creates rows with base_missing=1 for files
 * that do not exist yet (pending-edits.js:147-163), so an agent's brand-new
 * `draft/methods.md` proposal is a row with no file behind it and no other
 * copy anywhere (proposals are never on disk). Storage's destination-exists
 * 409 therefore does NOT cover this case. We refuse instead: throw
 * StorageError('conflict'), which rolls the whole transaction back so the
 * producer can rename the file back and surface a 409. Producers should call
 * findPendingEditConflicts() BEFORE the fs rename so the common case never
 * gets this far.
 *
 * Scope: a row whose NEW path leaves draft/** could never have been created
 * (isSuggestionPath, pending-edits.js:32-34). We still MOVE it rather than
 * drop it — proposed_content is the only copy, and deleting it silently is the
 * same data loss OR REPLACE was rejected for. The row follows its file and the
 * scope gate moves to acceptance time; the count is returned as `outOfScope`
 * so callers can surface it. NOTE: acceptEdit/acceptHunks (pending-edits.js:
 * 251, 267) call writeProjectFile with row.path and re-check nothing, so they
 * need an isSuggestionPath guard for this to be airtight.
 */
function rekeyPendingEdits(projectId, from, to) {
  const sources = subtreeRows('pending_edits', projectId, from);
  if (sources.length === 0) return { rekeyed: 0, outOfScope: 0 };

  const moving = new Set(sources.map((r) => r.id));
  const targets = sources.map((r) => ({ id: r.id, path: to + r.path.slice(from.length) }));

  for (const target of targets) {
    const { rows } = querySync(
      'SELECT id FROM pending_edits WHERE project_id = $1 AND path = $2',
      [projectId, target.path],
    );
    if (rows[0] && !moving.has(rows[0].id)) {
      throw new StorageError(
        'conflict',
        `A pending edit already exists at ${target.path} — accept or reject it before moving`,
      );
    }
  }

  let outOfScope = 0;
  for (const target of targets) {
    querySync(
      `UPDATE pending_edits SET path = $2, updated_at = ${NOW} WHERE id = $1`,
      [target.id, target.path],
    );
    if (!isDraftScoped(target.path)) outOfScope += 1;
  }
  return { rekeyed: targets.length, outOfScope };
}

/**
 * Re-point projects.config.activeDocument when the last-open document moved.
 * Read-modify-write rather than calling db/projects.js setActiveDocument,
 * which is async and cannot be awaited inside transaction().
 */
function rekeyActiveDocument(projectId, from, to) {
  const { rows } = querySync('SELECT config FROM projects WHERE id = $1', [projectId]);
  if (!rows[0]) return 0;
  let cfg;
  try {
    cfg = JSON.parse(rows[0].config || '{}');
  } catch {
    return 0; // a corrupt config blob is not this transaction's problem
  }
  const current = cfg?.activeDocument;
  if (typeof current !== 'string') return 0;
  if (current !== from && !current.startsWith(`${from}/`)) return 0;
  cfg.activeDocument = to + current.slice(from.length);
  querySync(
    `UPDATE projects SET config = $2, updated_at = ${NOW} WHERE id = $1`,
    [projectId, JSON.stringify(cfg)],
  );
  return 1;
}

/**
 * Re-key every path consumer for a move and append its 'moved' event, in ONE
 * transaction. A folder move carries its whole subtree by prefix and emits a
 * single event for the folder itself.
 *
 * @param {number} projectId
 * @param {string} from - old path (canonical; re-canonicalized defensively)
 * @param {string} to   - new path
 * @param {{agentSlug?: string|null, jobId?: number|null, userId?: number|null}} [attribution]
 * @returns {{from: string, to: string, comments: number, pendingEdits: number,
 *            outOfScope: number, activeDocument: number, reviewLinks: number}}
 * @throws {StorageError} 'invalid_path' for a degenerate move, 'conflict' when
 *   the destination already holds a pending edit. Any throw rolls back every
 *   table, including the file_events row.
 */
export function applyMove(projectId, from, to, { agentSlug = null, jobId = null, userId = null } = {}) {
  const src = canonical(from, 'source');
  const dst = canonical(to, 'destination');
  if (src === dst) {
    throw new StorageError('invalid_path', `Cannot move ${src} onto itself`);
  }
  if (dst.startsWith(`${src}/`)) {
    throw new StorageError('invalid_path', `Cannot move ${src} into its own descendant ${dst}`);
  }

  return transaction(() => {
    migrateSeenPaths(projectId, src, dst);

    // comments.path has no unique key (schema.sql:365-382), so a plain UPDATE
    // is safe; this covers replies too, which carry a copy of the root's path.
    const comments = querySync(
      `UPDATE comments SET path = ${REKEY}, updated_at = ${NOW}
       WHERE project_id = $1 AND ${SUBTREE}`,
      [projectId, src, dst],
    ).rowCount;

    const pending = rekeyPendingEdits(projectId, src, dst);
    const activeDocument = rekeyActiveDocument(projectId, src, dst);

    // review_links.path has no unique key either (epic 013): plain UPDATE.
    // Revoked/expired rows are rekeyed too — the audit trail should name the
    // document where it lives now.
    const reviewLinks = querySync(
      `UPDATE review_links SET path = ${REKEY}, updated_at = ${NOW}
       WHERE project_id = $1 AND ${SUBTREE}`,
      [projectId, src, dst],
    ).rowCount;

    // Last, and inside the same transaction: the announcement can only be
    // durable if the rewrite it announces is.
    recordFileEvent(projectId, {
      path: dst, kind: 'moved', meta: { from: src }, agentSlug, jobId, userId,
    });

    return {
      from: src,
      to: dst,
      comments,
      pendingEdits: pending.rekeyed,
      outOfScope: pending.outOfScope,
      activeDocument,
      reviewLinks,
    };
  });
}

/**
 * Producer-side pre-check: the destination pending_edits rows a move would
 * collide with. Call this BEFORE the fs rename so the request 409s while the
 * file is still in place; applyMove re-checks inside the transaction to close
 * the race. Returns the colliding NEW paths (empty = clear to move).
 * @returns {string[]}
 */
export function findPendingEditConflicts(projectId, from, to) {
  const src = canonical(from, 'source');
  const dst = canonical(to, 'destination');
  const sources = subtreeRows('pending_edits', projectId, src);
  const moving = new Set(sources.map((r) => r.id));
  const clashes = new Set();
  for (const row of sources) {
    const path = dst + row.path.slice(src.length);
    const { rows } = querySync(
      'SELECT id FROM pending_edits WHERE project_id = $1 AND path = $2',
      [projectId, path],
    );
    if (rows[0] && !moving.has(rows[0].id)) clashes.add(path);
  }
  // A CLEAN source moving onto a waiting proposal clashes too (story 012-005:
  // files-check caught this leg missing). The destination cannot exist on
  // disk — storage 409s that first — so any pending edit at or under it is a
  // base_missing proposal, and the arriving bytes would silently become that
  // proposal's base. Rows being re-keyed by this very move are not clashes.
  for (const row of subtreeRows('pending_edits', projectId, dst)) {
    if (!moving.has(row.id)) clashes.add(row.path);
  }
  return [...clashes];
}
