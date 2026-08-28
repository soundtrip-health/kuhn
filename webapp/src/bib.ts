// Bibliography cache (story 016): resolves citation keys to a reference the
// hover card can show (STH-42). Two sources, merged per key:
//
//  - the project's reference store (GET /references) — authoritative, and the
//    only place the abstract and identifiers live; the .bib is derived from it.
//  - the .bib file itself — parsed for key + display fields, so a bibliography
//    the store does not know about (hand-written, imported) still resolves.
//
// The .bib path is RESOLVED, not hard-coded (story 012-001) — see `bibPath`.

import { listReferences, readTextFile } from './api';
import type { ReferenceView } from './reference-format';
import { findBibPath } from './tree-state';

/**
 * Where a project's bibliography lives until we learn otherwise. Mirrors the
 * backend's own default (agent-backend/src/citations.js DEFAULT_BIB_PATH), which
 * is what `/cite` writes to — `addCitation` sends only a pmid, so the server
 * picks the path and hands it back in the response.
 */
const DEFAULT_BIB_PATH = 'draft/references.bib';

/** Entries parsed from the .bib file. */
const entries = new Map<string, ReferenceView>();
/** Entries from the reference store, keyed by cite key. */
const stored = new Map<string, ReferenceView>();
/**
 * The bibliography this cache is loaded from. NOT a constant since story
 * 012-001: once folders can be created and moved from the file manager, the bib
 * — or the whole `draft/` folder around it — can be somewhere else, and a
 * hard-coded path silently 404s, empties the cache and degrades every citation
 * chip in every open document to "not found in references.bib".
 */
let bibPath = DEFAULT_BIB_PATH;
let loadedForProject = 0;
/** Guards against an in-flight load for the OLD path landing after a newer one
 * and clobbering it — a move fires both (the SSE handler adopts the new path
 * while the editor's open-document load is still fetching the old one). */
let loadSeq = 0;

/** The path this cache is currently reading. Callers that see a `moved` event
 * use it to decide whether the move concerned the bibliography at all. */
export function currentBibPath(): string {
  return bibPath;
}

/**
 * (Re)load the bibliography; call on startup, on document open, and whenever a
 * `.bib` changes.
 *
 * `path` is adopted verbatim and is for callers that KNOW the new location — the
 * `moved` event that carried the bib somewhere else, and the path `/cite` echoes
 * back from the server. Everyone else omits it and the path is re-resolved from
 * the tree (the current one if it still exists, else the first `.bib` in the
 * project), which is also what recovers after a move this tab never saw.
 */
export async function refreshBib(projectId: number, path?: string): Promise<void> {
  if (projectId !== loadedForProject) {
    // A different project — nothing cached can be valid, and the previous
    // project's resolved path certainly isn't.
    entries.clear();
    stored.clear();
    bibPath = DEFAULT_BIB_PATH;
    loadedForProject = projectId;
  }
  const seq = ++loadSeq;
  await Promise.all([loadStore(projectId, seq), loadBibFile(projectId, seq, path)]);
}

async function loadStore(projectId: number, seq: number): Promise<void> {
  try {
    const refs = await listReferences(projectId);
    if (seq !== loadSeq) return;
    stored.clear();
    for (const r of refs) {
      stored.set(r.cite_key, {
        key: r.cite_key,
        authors: r.authors ?? [],
        year: r.year == null ? '' : String(r.year),
        title: r.title ?? '',
        journal: r.journal ?? '',
        volume: r.volume ?? undefined,
        issue: r.issue ?? undefined,
        pages: r.pages ?? undefined,
        abstract: r.abstract ?? undefined,
        doi: r.doi ?? undefined,
        pmid: r.pmid ?? undefined,
        url: r.url ?? undefined,
      });
    }
  } catch {
    // Backend unreachable or a viewer without the route — keep what we had.
  }
}

async function loadBibFile(projectId: number, seq: number, path?: string): Promise<void> {
  const resolved = path ?? findBibPath(bibPath);
  if (resolved == null) {
    // The project has no bibliography at all (nothing has been cited yet).
    // Requesting the default path anyway 404s on every document open and every
    // project switch — caught here, but still logged by the browser, which is
    // pure console noise. Keep the last known path so /cite's echoed path (or a
    // later `.bib` appearing in the tree) still re-resolves.
    entries.clear();
    return;
  }
  bibPath = resolved;
  try {
    const text = await readTextFile(projectId, bibPath);
    if (seq !== loadSeq) return; // a newer load superseded this one
    entries.clear();
    if (text) parseBib(text);
  } catch {
    // Backend unreachable — keep whatever we had
  }
}

/**
 * The reference behind a citation key, or null when neither the store nor
 * the .bib knows it. The store wins (it carries the abstract and identifiers);
 * the parsed .bib fills in keys the store lacks.
 */
export function referenceFor(key: string): ReferenceView | null {
  return stored.get(key) ?? entries.get(key) ?? null;
}

function parseBib(text: string): void {
  for (const chunk of text.split(/^(?=@)/m)) {
    const head = chunk.match(/^@[a-zA-Z]+\s*\{\s*([^,\s]+)\s*,/);
    if (!head) continue;
    const field = (name: string): string =>
      chunk.match(new RegExp(`^\\s*${name}\\s*=\\s*[{"]([^}"]*)[}"]`, 'im'))?.[1].trim() ?? '';
    const key = head[1];
    entries.set(key, {
      key,
      authors: field('author').split(/\s+and\s+/).map((a) => a.trim()).filter(Boolean),
      year: field('year'),
      title: field('title'),
      journal: field('journal'),
      volume: field('volume') || undefined,
      issue: field('number') || undefined,
      pages: field('pages') || undefined,
      doi: field('doi') || undefined,
      pmid: field('pmid') || undefined,
      url: field('url') || undefined,
      abstract: field('abstract') || undefined,
    });
  }
}
