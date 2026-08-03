// Story 008-001: suggestion mode. Agent writes to draft/** land here as
// pending edits — full base/proposed blobs in SQLite (db/pending-edits.js),
// with diff hunks DERIVED server-side (jsdiff) and never stored. This module
// owns the scope rule, the hunk math (compute / apply-one / un-apply-one),
// staleness re-anchoring, and the accept/reject orchestration: accepts write
// through storage.writeProjectFile and publish the normal file_change event
// (Yjs room eviction + version-history commit ride along), so the open editor
// refreshes through the same path as today's agent direct writes.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { applyPatch, reversePatch, structuredPatch } from 'diff';

import {
  deletePendingEdit,
  getPendingEdit,
  getPendingEditByPath,
  listPendingEdits,
  updatePendingEdit,
  upsertPendingEdit,
} from './db/pending-edits.js';
import { commitNow } from './history.js';
import { publishProjectEvent } from './project-events.js';
import { StorageError, readProjectFile, writeProjectFile } from './storage.js';

/**
 * The suggestion scope: paths whose FIRST segment is exactly `draft`
 * (`draft/main.md` yes, `draft-notes/x.md` no). Normalized first so an agent
 * cannot dodge the gate with `./draft/...` or `research/../draft/...`.
 */
export function isSuggestionPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  return posix.normalize(path).split('/')[0] === 'draft';
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Derive review hunks from the stored blobs (context 2). Each hunk is a valid
 * jsdiff hunk (oldStart/oldLines/newStart/newLines/lines) plus `index` and a
 * content `hash` that guards accept/reject races: the client echoes
 * {index, hash} back and a mismatch means the hunk set moved under it.
 */
export function computeHunks(baseContent, proposedContent) {
  const patch = structuredPatch('a', 'b', baseContent, proposedContent, '', '', { context: 2 });
  return patch.hunks.map((hunk, index) => ({
    index,
    hash: sha256(hunk.lines.join('\n')),
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  }));
}

/**
 * Apply ONE hunk to the base-side content (its old-side coordinates are base
 * coordinates, so a single extracted hunk applies cleanly on its own).
 * @returns {string|false} the patched content, or false if it did not apply
 */
export function applyHunk(content, hunk) {
  return applyPatch(content, { hunks: [hunk] }, { fuzzFactor: 0 });
}

/**
 * Un-apply ONE hunk from the proposed-side content (its new-side coordinates
 * are proposed coordinates) — the per-hunk reject primitive.
 * @returns {string|false}
 */
export function unapplyHunk(content, hunk) {
  return applyPatch(content, reversePatch({ hunks: [hunk] }), { fuzzFactor: 0 });
}

/** Read a project file as text, mapping not_found to { missing: true }. */
async function readCurrent(projectId, path) {
  try {
    return { content: (await readProjectFile(projectId, path)).toString('utf-8'), missing: false };
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') return { content: '', missing: true };
    throw err;
  }
}

/** Row → the REST edit shape. Stale rows carry both blobs for side-by-side. */
function toEdit(row) {
  return {
    id: row.id,
    path: row.path,
    agent: row.agent_slug ?? null,
    jobId: row.job_id ?? null,
    stale: !!row.stale,
    baseMissing: !!row.base_missing,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hunks: computeHunks(row.base_content, row.proposed_content),
    proposedContent: row.proposed_content,
    ...(row.stale ? { baseContent: row.base_content } : {}),
  };
}

/**
 * Staleness / re-anchor (contract): compare the current file to base_hash.
 * Fresh → row unchanged. Drifted → try to rebase: apply diff(base, proposed)
 * to the current content (fuzzFactor 0); clean → base becomes current,
 * proposed becomes the patched text, stale cleared. Dirty → stale = 1, blobs
 * untouched. If a rebase leaves base === proposed (the user made the proposed
 * change themselves), the edit has resolved itself and the row is deleted.
 * @returns {object|null} the (possibly rebased) row, or null if resolved
 */
async function refreshRow(projectId, row) {
  const { content: current, missing } = await readCurrent(projectId, row.path);
  if (sha256(current) === row.base_hash) return row;
  if (current === row.proposed_content) {
    deletePendingEdit(row.id); // resolved itself: the file already matches
    return null;
  }
  const patch = structuredPatch(row.path, row.path, row.base_content, row.proposed_content, '', '', { context: 2 });
  const patched = applyPatch(current, patch, { fuzzFactor: 0 });
  if (patched === false) {
    return row.stale ? row : updatePendingEdit(row.id, { stale: true });
  }
  if (patched === current) {
    deletePendingEdit(row.id);
    return null;
  }
  return updatePendingEdit(row.id, {
    baseContent: current,
    baseHash: sha256(current),
    baseMissing: missing,
    proposedContent: patched,
    stale: false,
  });
}

/**
 * Create or coalesce a pending edit (the agent tool path and POST / both land
 * here). Base is the disk content at FIRST proposal ('' + baseMissing for a
 * file that does not exist yet); later proposals to the same path replace the
 * proposed content only. Throws invalid_path for out-of-scope paths.
 * @returns {Promise<object>} the edit in REST shape
 */
export async function proposeEdit(projectId, { path, proposedContent, agentSlug = null, jobId = null }) {
  if (!isSuggestionPath(path)) {
    throw new StorageError('invalid_path', `Suggestions cover draft/** only: ${path}`);
  }
  const normalized = posix.normalize(path);
  const { content: base, missing } = await readCurrent(projectId, normalized);
  const existing = getPendingEditByPath(projectId, normalized);
  const row = upsertPendingEdit(projectId, {
    path: normalized,
    // On coalesce the SQL keeps the stored base; these bind only on insert.
    baseContent: existing ? existing.base_content : base,
    baseHash: existing ? existing.base_hash : sha256(base),
    baseMissing: existing ? !!existing.base_missing : missing,
    proposedContent,
    agentSlug,
    jobId,
  });
  return toEdit(row);
}

/**
 * Effective content of a path for the agent's edit_file tool: the pending
 * proposal if one exists, else the disk file — a sequential write→edit on the
 * same file stays coherent even though the disk bytes never changed.
 */
export async function effectiveContent(projectId, path) {
  const row = getPendingEditByPath(projectId, posix.normalize(path));
  if (row) return row.proposed_content;
  return (await readProjectFile(projectId, path)).toString('utf-8');
}

/**
 * The pending proposal's content for a path, or null if none is pending. Lets
 * the agent's read_file reflect the agent's own suggestion-mode writes (issue
 * #42): without this, a write→read-back verify loop sees the pre-proposal disk
 * bytes and concludes the write was lost.
 */
export function pendingProposalContent(projectId, path) {
  const row = getPendingEditByPath(projectId, posix.normalize(path));
  return row ? row.proposed_content : null;
}

/**
 * All pending edits for a project (optionally one path), refreshed through
 * the staleness/re-anchor pass, in REST shape.
 */
export async function listEdits(projectId, { path = null } = {}) {
  const rows = listPendingEdits(projectId, { path });
  const edits = [];
  for (const row of rows) {
    const fresh = await refreshRow(projectId, row);
    if (fresh) edits.push(toEdit(fresh));
  }
  return edits;
}

/** The one file_change publish for real accept writes (create vs update). */
function publishApplied(projectId, row, kind, userId) {
  publishProjectEvent(projectId, {
    type: 'file_change', agent: row.agent_slug ?? null, path: row.path, kind,
  }, { jobId: row.job_id ?? null, userId });
}

/**
 * Pending-set-changed-without-a-write signal (reject paths): kind 'proposed'
 * fans out to SSE only — no file_events row, no eviction, no commit.
 */
function publishProposed(projectId, row, userId) {
  publishProjectEvent(projectId, {
    type: 'file_change', agent: row.agent_slug ?? null, path: row.path, kind: 'proposed',
  }, { jobId: row.job_id ?? null, userId });
}

function commitLabel(row) {
  return `Accept suggestion on ${row.path}${row.job_id != null ? ` (job ${row.job_id})` : ''}`;
}

/**
 * Accept a pending edit — all of it (no hunk), one hunk ({index, hash}), or
 * force (stale rows only, whole-file replace). Every accept writes through
 * writeProjectFile, publishes the attributed file_change, and commits a
 * labeled version. 409 (conflict) on stale-without-force and on hunk races.
 * @returns {Promise<{applied: true, remaining: number, edit?: object}>}
 */
export async function acceptEdit(projectId, id, { hunk = null, force = false, userId = null } = {}) {
  const stored = getPendingEdit(projectId, id);
  if (!stored) throw new StorageError('not_found', `No pending edit ${id}`);
  const row = await refreshRow(projectId, stored);
  if (!row) return { applied: true, remaining: 0 }; // resolved itself: file already matches
  // proposeEdit gates on isSuggestionPath, but a row's path is no longer fixed
  // for its lifetime: story 012-002 lets a move re-key pending_edits, so a
  // proposal for draft/main.md follows the file to archive/main.md and would
  // otherwise be written outside draft/** here — a scope the agent could never
  // have proposed into directly. Re-check at the point of the write.
  if (!isSuggestionPath(row.path)) {
    throw new StorageError(
      'invalid_path',
      `Pending edit ${id} now points at ${row.path}, outside the draft/ suggestion scope — `
      + 'its file was moved. Reject it and ask the agent to re-propose.',
    );
  }
  const kind = row.base_missing ? 'create' : 'update';

  if (row.stale && !force) {
    throw new StorageError('conflict', `Pending edit for ${row.path} is stale — review side-by-side (accept with force to replace the file)`);
  }

  if (hunk != null && !row.stale) {
    const hunks = computeHunks(row.base_content, row.proposed_content);
    const target = hunks[hunk.index];
    if (!target || target.hash !== hunk.hash) {
      throw new StorageError('conflict', `Hunk ${hunk.index} of ${row.path} changed since it was fetched — re-fetch the edit`);
    }
    const newBase = applyHunk(row.base_content, target);
    if (newBase === false) {
      throw new StorageError('conflict', `Hunk ${hunk.index} of ${row.path} no longer applies — re-fetch the edit`);
    }
    await writeProjectFile(projectId, row.path, newBase);
    const remaining = computeHunks(newBase, row.proposed_content);
    let edit;
    if (remaining.length === 0) {
      deletePendingEdit(row.id);
    } else {
      edit = toEdit(updatePendingEdit(row.id, {
        baseContent: newBase, baseHash: sha256(newBase), baseMissing: false,
      }));
    }
    publishApplied(projectId, row, kind, userId);
    await commitNow(projectId, { agent: row.agent_slug ?? null, userId, label: commitLabel(row) });
    return { applied: true, remaining: remaining.length, ...(edit ? { edit } : {}) };
  }

  // Accept all (including force on a stale row): the proposal becomes the file.
  await writeProjectFile(projectId, row.path, row.proposed_content);
  deletePendingEdit(row.id);
  publishApplied(projectId, row, kind, userId);
  await commitNow(projectId, { agent: row.agent_slug ?? null, userId, label: commitLabel(row) });
  return { applied: true, remaining: 0 };
}

/**
 * Reject a pending edit — all of it (delete the row) or one hunk (un-apply it
 * from the proposal). No file write, no file_events row, no commit; publishes
 * kind 'proposed' so other tabs re-fetch.
 * @returns {Promise<{rejected: true, remaining: number, edit?: object}>}
 */
export async function rejectEdit(projectId, id, { hunk = null, userId = null } = {}) {
  const stored = getPendingEdit(projectId, id);
  if (!stored) throw new StorageError('not_found', `No pending edit ${id}`);
  const row = await refreshRow(projectId, stored);
  if (!row) return { rejected: true, remaining: 0 };

  if (hunk == null) {
    deletePendingEdit(row.id);
    publishProposed(projectId, row, userId);
    return { rejected: true, remaining: 0 };
  }

  if (row.stale) {
    throw new StorageError('conflict', `Pending edit for ${row.path} is stale — hunks no longer anchor; reject all or review side-by-side`);
  }
  const hunks = computeHunks(row.base_content, row.proposed_content);
  const target = hunks[hunk.index];
  if (!target || target.hash !== hunk.hash) {
    throw new StorageError('conflict', `Hunk ${hunk.index} of ${row.path} changed since it was fetched — re-fetch the edit`);
  }
  const newProposed = unapplyHunk(row.proposed_content, target);
  if (newProposed === false) {
    throw new StorageError('conflict', `Hunk ${hunk.index} of ${row.path} no longer applies — re-fetch the edit`);
  }
  const remaining = computeHunks(row.base_content, newProposed);
  let edit;
  if (remaining.length === 0) {
    deletePendingEdit(row.id);
  } else {
    edit = toEdit(updatePendingEdit(row.id, { proposedContent: newProposed }));
  }
  publishProposed(projectId, row, userId);
  return { rejected: true, remaining: remaining.length, ...(edit ? { edit } : {}) };
}
