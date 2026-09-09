// Interchange export (issue #154; docs/specs/interchange-bundle.md §4).
//
// Serializes a project for the tool that pushed it (or any tool): the docs'
// current content with their comment threads and re-resolved anchors, the
// full reference list, history head + last-import provenance. Two shapes
// from one build: JSON (the feedback payload — no binary assets) and a zip
// in the §3 bundle layout plus comments.json, which imports back into Kuhn.
//
// Read-only: anchors are re-resolved in memory for the payload, never
// persisted here (that is the importer's job on write).

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { strToU8, zipSync } from 'fflate';

import { config } from '../config.js';
import { listThreads, resolveQuote } from '../db/comments.js';
import { DEFAULT_BIB_PATH, listProjectReferences } from '../db/references.js';
import { listHistory } from '../history.js';
import { StorageError, listProjectTree, readProjectFile } from '../storage.js';

export const SCHEMA_VERSION = '1';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Build the JSON export.
 * @param {object} project project row with parsed config
 * @param {{paths?: string[]|null, user?: {id: number, email: string}|null}} opts
 *   paths: docs to export; default = the last import's docs, else every .md under draft/
 */
export async function buildExport(project, { paths = null, user = null } = {}) {
  const projectId = project.id;
  const provenance = project.config?.interchange ?? null;

  let docPaths = Array.isArray(paths) && paths.length > 0 ? [...new Set(paths)] : Object.keys(provenance?.docs ?? {});
  if (docPaths.length === 0) docPaths = await markdownUnder(projectId, 'draft');

  const docs = [];
  for (const path of docPaths) {
    const content = (await readProjectFile(projectId, path)).toString('utf-8');
    const stored = provenance?.docs?.[path] ?? null;
    docs.push({
      path,
      title: stored?.title ?? null,
      meta: stored?.meta ?? null,
      modified_since_import: stored?.sha256 ? sha256(content) !== stored.sha256 : null,
      content,
      comments: exportThreads(projectId, path, content),
    });
  }

  const references = (await listProjectReferences(projectId)).map(referenceOut);
  const head = (await listHistory(projectId, null, 1))[0] ?? null;

  return {
    schema_version: SCHEMA_VERSION,
    project: { id: project.id, name: project.name, project_type: project.project_type },
    exported_at: new Date().toISOString(),
    exported_by: user?.email ?? null,
    revision: head?.hash ?? null,
    last_import: provenance
      ? {
        source: provenance.source ?? {},
        imported_at: provenance.imported_at ?? null,
        checkpoint: provenance.checkpoint ?? null,
      }
      : null,
    docs,
    references,
  };
}

/**
 * The zip form of an export: §3 bundle layout (manifest.json, references.json,
 * files/<path> for the docs AND the non-markdown files that sit under their
 * directories — figures, tables, data) plus comments.json. Importing it into
 * another project reproduces docs, assets and references; comments ride
 * along as information only.
 * @param {object} project
 * @param {Awaited<ReturnType<typeof buildExport>>} data
 * @returns {Promise<Buffer>}
 */
export async function buildExportZip(project, data) {
  const entries = {};
  const manifest = {
    schema_version: SCHEMA_VERSION,
    source: {
      tool: 'kuhn',
      project: project.name,
      project_id: project.id,
      revision: data.revision,
      exported_at: data.exported_at,
      exported_by: data.exported_by,
    },
    project: { name: project.name, project_type: project.project_type, org_id: null },
    docs: data.docs.map((d) => ({ path: d.path, title: d.title, meta: d.meta })),
    export: { revision: data.revision, exported_at: data.exported_at, last_import: data.last_import },
  };
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  entries['references.json'] = strToU8(JSON.stringify(data.references, null, 2));
  entries['comments.json'] = strToU8(JSON.stringify(
    Object.fromEntries(data.docs.map((d) => [d.path, d.comments])), null, 2,
  ));
  const docPaths = new Set(data.docs.map((d) => d.path));
  for (const doc of data.docs) entries[`files/${doc.path}`] = strToU8(doc.content);

  // Assets: every non-markdown file under the exported docs' directories,
  // minus the derived bibliography and anything over the per-file cap.
  const dirs = [...new Set(data.docs.map((d) => posix.dirname(d.path)))];
  const seen = new Set();
  for (const dir of dirs) {
    if (dirs.some((other) => other !== dir && dir.startsWith(`${other}/`))) continue; // covered by a parent
    for (const path of await filesUnder(project.id, dir)) {
      if (seen.has(path) || docPaths.has(path) || path === DEFAULT_BIB_PATH) continue;
      if (path.toLowerCase().endsWith('.md')) continue; // unselected docs are not assets
      seen.add(path);
      try {
        const buf = await readProjectFile(project.id, path);
        entries[`files/${path}`] = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
      } catch (err) {
        if (err instanceof StorageError && err.code === 'too_large') continue;
        throw err;
      }
    }
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}

// ---- pieces ------------------------------------------------------------------

/** Threads for one path in the §3 comments.json shape, anchors re-resolved
 *  against `content` (in memory — nothing is written). */
export function exportThreads(projectId, path, content) {
  return listThreads(projectId, { path }).map((t) => {
    let anchor = null;
    let orphaned = t.orphaned;
    if (t.anchor?.quote) {
      const hit = resolveQuote(content, t.anchor.quote, { hint: t.anchor.start });
      anchor = hit
        ? { quote: t.anchor.quote, start: hit.start, end: hit.end }
        : { quote: t.anchor.quote, start: t.anchor.start, end: t.anchor.end };
      orphaned = !hit;
    }
    return {
      id: t.id,
      body: t.body,
      author: authorOf(t),
      anchor,
      orphaned,
      resolved_at: t.resolvedAt,
      resolved_by: t.resolvedAt ? (t.resolvedByName ?? t.resolvedByReviewerName ?? null) : null,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      replies: t.replies.map((r) => ({ id: r.id, body: r.body, author: authorOf(r), created_at: r.createdAt })),
    };
  });
}

function authorOf(c) {
  if (c.agent) return { kind: 'agent', name: c.agent, id: null };
  if (c.reviewLinkId != null) return { kind: 'reviewer', name: c.reviewerName ?? null, id: c.reviewLinkId };
  return { kind: 'member', name: c.userName ?? null, id: c.userId ?? null };
}

/** A stored reference in references.json shape. */
function referenceOut(r) {
  return {
    cite_key: r.cite_key,
    entry_type: r.entry_type ?? 'article',
    title: r.title,
    authors: r.authors ?? [],
    year: r.year ?? null,
    journal: r.journal ?? null,
    volume: r.volume ?? null,
    issue: r.issue ?? null,
    pages: r.pages ?? null,
    publisher: r.publisher ?? null,
    doi: r.doi ?? null,
    pmid: r.pmid ?? null,
    pmcid: r.pmcid ?? null,
    url: r.url ?? null,
    abstract: r.abstract ?? null,
  };
}

async function filesUnder(projectId, dir) {
  let tree;
  try {
    tree = await listProjectTree(projectId, dir);
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') return [];
    throw err;
  }
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'dir') walk(n.children ?? []);
      else if (n.type === 'file' && n.size <= config.storage.maxFileBytes) out.push(n.path);
    }
  };
  walk(tree);
  return out;
}

async function markdownUnder(projectId, dir) {
  return (await filesUnder(projectId, dir)).filter((p) => p.toLowerCase().endsWith('.md') && p !== DEFAULT_BIB_PATH);
}
