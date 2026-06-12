// Bibliography cache (story 016): loads the project's references.bib and
// resolves citation keys to a human-readable reference line for chip hover
// tooltips. Parsing only needs key + a few display fields; entries with
// nested braces or exotic syntax degrade to whatever fields do match.

import { readTextFile } from './api';

export const BIB_PATH = 'draft/references.bib';

interface BibEntry {
  authors: string;
  year: string;
  title: string;
  journal: string;
}

const entries = new Map<string, BibEntry>();
let loadedForProject = 0;

/** (Re)load the bibliography; call on startup and whenever the .bib changes. */
export async function refreshBib(projectId: number): Promise<void> {
  loadedForProject = projectId;
  try {
    const text = await readTextFile(projectId, BIB_PATH);
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

export function bibLoadedProject(): number {
  return loadedForProject;
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
