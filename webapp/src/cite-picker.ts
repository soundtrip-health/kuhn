// /cite picker (story 016): a floating panel at the caret that searches
// PubMed through the backend citation service and inserts the chosen work as
// a citation chip, upserting it into the project bibliography (the server
// chooses the path and echoes it back — see onPick). Every candidate
// shown comes from PubMed metadata — grounding rule from Epic 003.

import { addCitation, searchCitations, type CitationCandidate } from './api';

const SEARCH_DEBOUNCE_MS = 350;

export interface CitePickerOptions {
  projectId: number;
  anchor: { x: number; y: number };
  /**
   * Called after the bibliography upsert succeeds, with the BibTeX key and the
   * path of the bibliography the server actually wrote (story 012-001: the bib
   * is no longer guaranteed to be at `draft/references.bib`, so the caller must
   * be told which file to reload rather than assuming).
   */
  onPick: (key: string, bibPath: string) => void;
  onClose: () => void;
}

export function openCitePicker(options: CitePickerOptions): void {
  const panel = document.createElement('div');
  panel.className = 'cite-picker';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cite-input';
  input.placeholder = 'Search PubMed… (Esc to cancel)';

  const status = document.createElement('div');
  status.className = 'cite-status';
  status.textContent = 'Type to search';

  const list = document.createElement('ul');
  list.className = 'cite-results';

  panel.append(input, status, list);
  document.body.append(panel);

  // Clamp to the viewport so the panel never opens off-screen
  const { x, y } = options.anchor;
  panel.style.left = `${Math.min(x, window.innerWidth - panel.offsetWidth - 12)}px`;
  panel.style.top = `${Math.min(y + 6, window.innerHeight - panel.offsetHeight - 12)}px`;

  let candidates: CitationCandidate[] = [];
  let active = 0;
  let adding = false;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;

  const close = (): void => {
    if (searchTimer) clearTimeout(searchTimer);
    abort?.abort();
    document.removeEventListener('mousedown', onOutsideMousedown, true);
    panel.remove();
    options.onClose();
  };

  const onOutsideMousedown = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };
  document.addEventListener('mousedown', onOutsideMousedown, true);

  const setStatus = (text: string, variant: '' | 'error' = ''): void => {
    status.textContent = text;
    status.className = `cite-status${variant ? ` cite-status-${variant}` : ''}`;
  };

  const render = (): void => {
    list.replaceChildren(
      ...candidates.map((c, i) => {
        const li = document.createElement('li');
        li.className = `cite-candidate${i === active ? ' active' : ''}`;
        const title = document.createElement('div');
        title.className = 'cite-title';
        title.textContent = c.title;
        const meta = document.createElement('div');
        meta.className = 'cite-meta';
        const authors = c.authors.length > 3 ? `${c.authors.slice(0, 3).join(', ')} et al.` : c.authors.join(', ');
        meta.textContent = [authors, c.journal, c.year].filter(Boolean).join(' · ');
        li.append(title, meta);
        li.addEventListener('mousedown', (e) => e.preventDefault());
        li.addEventListener('click', () => void pick(c));
        return li;
      }),
    );
    const activeEl = list.children[active];
    if (activeEl) (activeEl as HTMLElement).scrollIntoView({ block: 'nearest' });
  };

  const search = async (query: string): Promise<void> => {
    abort?.abort();
    abort = new AbortController();
    setStatus('Searching PubMed…');
    try {
      candidates = await searchCitations(options.projectId, query, 8, abort.signal);
      active = 0;
      render();
      setStatus(candidates.length === 0 ? 'No results — try different terms' : `${candidates.length} result${candidates.length > 1 ? 's' : ''} · ↑↓ select, Enter to cite`);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      candidates = [];
      render();
      setStatus(`Search failed: ${(err as Error).message}`, 'error');
    }
  };

  const pick = async (candidate: CitationCandidate): Promise<void> => {
    if (adding) return;
    adding = true;
    setStatus('Adding to bibliography…');
    try {
      const { key, path } = await addCitation(options.projectId, candidate.pmid);
      options.onPick(key, path);
      close();
    } catch (err) {
      adding = false;
      setStatus(`Could not add citation: ${(err as Error).message}`, 'error');
    }
  };

  input.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    const query = input.value.trim();
    if (!query) {
      candidates = [];
      render();
      setStatus('Type to search');
      return;
    }
    searchTimer = setTimeout(() => void search(query), SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (candidates.length === 0) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + delta + candidates.length) % candidates.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (candidates[active]) void pick(candidates[active]);
    }
  });

  input.focus();
}
