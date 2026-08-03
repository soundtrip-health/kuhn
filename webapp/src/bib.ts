// Bibliography cache (story 016): loads the project's .bib and resolves
// citation keys to a human-readable reference line for chip hover tooltips.
// Parsing only needs key + a few display fields; entries with nested braces or
// exotic syntax degrade to whatever fields do match.
//
// The path is RESOLVED, not hard-coded (story 012-001) — see `bibPath` below.

import { readTextFile } from './api';
import { findBibPath } from './tree-state';

/**
 * Where a project's bibliography lives until we learn otherwise. Mirrors the
 * backend's own default (agent-backend/src/citations.js DEFAULT_BIB_PATH), which
 * is what `/cite` writes to — `addCitation` sends only a pmid, so the server
 * picks the path and hands it back in the response.
 */
const DEFAULT_BIB_PATH = 'draft/references.bib';

interface BibEntry {
  authors: string;
  year: string;
  title: string;
  journal: string;
}

const entries = new Map<string, BibEntry>();
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
    bibPath = DEFAULT_BIB_PATH;
    loadedForProject = projectId;
  }
  bibPath = path ?? findBibPath(bibPath) ?? bibPath;
  const seq = ++loadSeq;
  try {
    const text = await readTextFile(projectId, bibPath);
    if (seq !== loadSeq) return; // a newer load superseded this one
    entries.clear();
    if (text) parseBib(text);
  } catch {
    // Backend unreachable — keep whatever we had
  }
}

/** Tooltip line for a citation key, or null when the key is not in the bib. */
export function bibTooltip(key: string): string | null {
  const entry = entries.get(key);
  if (!entry) return null;
  const authors = entry.authors
    .split(/\s+and\s+/)
    .map((a) => a.split(',')[0].trim())
    .filter(Boolean);
  const authorPart =
    authors.length > 2 ? `${authors[0]} et al.` : authors.join(' & ');
  return [
    [authorPart, entry.year ? `(${entry.year})` : ''].filter(Boolean).join(' '),
    entry.title,
    entry.journal,
  ]
    .filter(Boolean)
    .join('. ');
}

function parseBib(text: string): void {
  for (const chunk of text.split(/^(?=@)/m)) {
    const head = chunk.match(/^@[a-zA-Z]+\s*\{\s*([^,\s]+)\s*,/);
    if (!head) continue;
    const field = (name: string): string =>
      chunk.match(new RegExp(`^\\s*${name}\\s*=\\s*[{"]([^}"]*)[}"]`, 'im'))?.[1].trim() ?? '';
    entries.set(head[1], {
      authors: field('author'),
      year: field('year'),
      title: field('title'),
      journal: field('journal'),
    });
  }
}
