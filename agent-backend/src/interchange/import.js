// Interchange import orchestration (issue #153; docs/specs/interchange-bundle.md §5).
//
// Takes a parsed, validated bundle (bundle.js) and lands it in a project:
//
//   1. refuse (409) or evict rooms a member holds open on a target doc
//   2. history checkpoint of the pre-import state
//   3. references first, so the citation-rewrite map is known
//   4. docs (citations rewritten) and assets through storage.js
//   5. references.bib materialized from the DB
//   6. existing comment anchors re-resolved against the new text
//   7. one file_change event per written path (rooms refresh, activity log)
//   8. history checkpoint labelled with the source tool + revision
//   9. provenance + per-doc content hash stored under project config
//
// Everything before step 4 is side-effect-free on the workspace, and step 1
// happens before the pre-import checkpoint so a refused import leaves no
// trace at all.

import { createHash } from 'node:crypto';

import { reanchorPath } from '../db/comments.js';
import { updateProjectConfig } from '../db/projects.js';
import { materializeBib, upsertReferenceByKey } from '../db/references.js';
import { commitNow } from '../history.js';
import { log } from '../logger.js';
import { publishProjectEvent } from '../project-events.js';
import { writeProjectFile } from '../storage.js';
import { evictRoom, memberConnectionCount } from '../yjs-websocket.js';
import { rewriteCitations } from './citations.js';

/** A member has a target document open and `force` was not given → 409. */
export class ImportConflictError extends Error {
  constructor(paths) {
    super(`Open in the editor by a member: ${paths.join(', ')} — save and close, or re-run with force`);
    this.name = 'ImportConflictError';
    this.code = 'doc_open';
    this.paths = paths;
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const roomName = (projectId, path) => `project-${projectId}/${path}`;

/**
 * @param {object} project the project row (parsed config), already authorized
 * @param {ReturnType<import('./bundle.js').parseBundle>} bundle
 * @param {{userId: number|null, force?: boolean, label?: string|null}} opts
 */
export async function importBundle(project, bundle, { userId = null, force = false, label = null } = {}) {
  const projectId = project.id;
  const startedAt = Date.now();

  // 1. Open-document check. A member's editor holds Yjs state that would win
  // over bytes written underneath it. Eviction uses the terminal "document
  // replaced" close (story 038): the editor stops, tells the user, and the
  // next open re-seeds from storage. (The reconnectable refresh code would
  // not do — a member client auto-reconnects and re-seeds from its own
  // stale state.) Reviewer-only rooms are handled by the file_change events
  // in step 7.
  const open = bundle.docs.map((d) => d.path).filter((p) => memberConnectionCount(roomName(projectId, p)) > 0);
  if (open.length > 0) {
    if (!force) throw new ImportConflictError(open);
    for (const path of open) {
      evictRoom(roomName(projectId, path), { closeConnections: true, closeReason: 'Document replaced by import' });
    }
  }

  // 2. Pre-import checkpoint (no-op when clean).
  await commitNow(projectId, { userId, label: 'Snapshot before import' });

  // 3. References.
  const references = [];
  const keyMap = {};
  for (const record of bundle.references) {
    const result = upsertReferenceByKey(projectId, record);
    references.push({ cite_key: record.citeKey, status: result.status, actual_key: result.key });
    if (result.key !== record.citeKey) keyMap[record.citeKey] = result.key;
  }

  // 4. Docs and assets.
  const files = [];
  const citationsRewritten = {};
  const written = new Map(); // doc path → content actually written
  for (const doc of bundle.docs) {
    let content = doc.content;
    if (Object.keys(keyMap).length > 0) {
      const { text, counts } = rewriteCitations(content, keyMap);
      content = text;
      const touched = Object.keys(counts);
      if (touched.length > 0) {
        citationsRewritten[doc.path] = Object.fromEntries(touched.map((k) => [k, keyMap[k]]));
      }
    }
    const { created } = await writeProjectFile(projectId, doc.path, content);
    files.push({ path: doc.path, kind: 'doc', created });
    written.set(doc.path, content);
  }
  for (const [path, buf] of bundle.assets) {
    const { created } = await writeProjectFile(projectId, path, buf);
    files.push({ path, kind: 'asset', created });
  }

  // 5. Derived bibliography.
  if (bundle.references.length > 0) await materializeBib(projectId);

  // 6. Comment anchors.
  const comments = { reanchored: 0, orphaned: 0 };
  for (const [path, content] of written) {
    const r = reanchorPath(projectId, path, content);
    comments.reanchored += r.reanchored;
    comments.orphaned += r.orphaned;
  }

  // 7. Events — the hub persists the activity rows, evicts idle rooms and
  // refreshes reviewer-only rooms. (A plain file PUT skips this on purpose;
  // the import must not.)
  for (const f of files) {
    publishProjectEvent(projectId, { type: 'file_change', path: f.path, kind: f.created ? 'create' : 'update' }, { userId });
  }

  // 8. Post-import checkpoint. Absorbs any commit the events scheduled.
  const source = bundle.manifest.source ?? {};
  const tool = typeof source.tool === 'string' && source.tool.trim() ? source.tool.trim() : 'interchange';
  const revision = typeof source.revision === 'string' && source.revision.trim()
    ? ` @${source.revision.trim().slice(0, 12)}` : '';
  const commitLabel = `Import from ${tool}${revision}${label ? ` — ${label}` : ''}`;
  const commit = await commitNow(projectId, { userId, label: commitLabel });

  // 9. Provenance. Docs accumulate across imports (a bundle may carry a
  // subset); everything else describes the latest import.
  const previous = project.config?.interchange ?? {};
  const checkpoint = commit ?? previous.checkpoint ?? null;
  const docs = { ...(previous.docs ?? {}) };
  for (const doc of bundle.docs) {
    docs[doc.path] = { title: doc.title, meta: doc.meta, sha256: sha256(written.get(doc.path)) };
  }
  const interchange = {
    source,
    imported_at: new Date().toISOString(),
    imported_by: userId,
    checkpoint,
    docs,
  };
  await updateProjectConfig(projectId, { config: { interchange } });

  const result = { files, references, citations_rewritten: citationsRewritten, comments, checkpoint };
  log.info('interchange_import', {
    projectId, userId, tool, revision: source.revision ?? null, force,
    docs: bundle.docs.length, assets: bundle.assets.size,
    references: references.length,
    referenceOutcomes: countBy(references, (r) => r.status),
    citationsRewritten: Object.keys(keyMap).length,
    commentsReanchored: comments.reanchored, commentsOrphaned: comments.orphaned,
    evicted: open.length, checkpoint, changed: commit != null,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

function countBy(items, fn) {
  const out = {};
  for (const item of items) {
    const k = fn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
