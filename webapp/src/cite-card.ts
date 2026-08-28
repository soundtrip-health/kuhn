// Citation hover card (STH-42). Hovering a `[@key]` chip in the rich editor
// shows what it cites — authors (up to five), title, year, journal — without
// leaving the document; "Details" adds the abstract and DOI/PubMed links, and
// "Open in references.bib" jumps to the entry in the bibliography file.
//
// One card element for the whole editor, driven by delegated mouse events on
// the editor container (chips are re-rendered by ProseMirror at will, so
// per-node listeners would leak). Positioned `fixed` from the chip's rect and
// hidden on scroll, Escape, or a click elsewhere.

import { currentBibPath, referenceFor } from './bib';
import { authorsLine, referenceLinks, sourceLine, type ReferenceView } from './reference-format';

export interface CiteCardHandlers {
  /** The bibliography file to open for a key, or null when there is none. */
  bibFile: () => string | null;
  /** Open the bibliography file and reveal the entry for `key`. */
  openInBib: (key: string, path: string) => void;
}

const SHOW_DELAY_MS = 140;
const HIDE_DELAY_MS = 220;
const GAP_PX = 6;
const MARGIN_PX = 8;

let card: HTMLElement | null = null;
let anchor: HTMLElement | null = null;
let showTimer: number | null = null;
let hideTimer: number | null = null;
let expanded = false;

export function installCitationCards(container: HTMLElement, handlers: CiteCardHandlers): void {
  container.addEventListener('mouseover', (event) => {
    const chip = (event.target as HTMLElement).closest?.('.citation-chip');
    if (!(chip instanceof HTMLElement)) return;
    cancelHide();
    if (chip === anchor && card && !card.hidden) return;
    scheduleShow(chip, handlers);
  });
  container.addEventListener('mouseout', (event) => {
    const chip = (event.target as HTMLElement).closest?.('.citation-chip');
    if (!(chip instanceof HTMLElement)) return;
    const to = event.relatedTarget as Node | null;
    if (card && to && card.contains(to)) return; // moving into the card
    cancelShow();
    scheduleHide();
  });
  // The chip moves with the document; the card does not follow it.
  container.addEventListener('scroll', hide, { capture: true, passive: true });
  document.addEventListener('mousedown', (event) => {
    if (!card || card.hidden) return;
    const target = event.target as Node;
    if (card.contains(target) || anchor?.contains(target)) return;
    hide();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && card && !card.hidden) hide();
  });
}

function scheduleShow(chip: HTMLElement, handlers: CiteCardHandlers): void {
  cancelShow();
  showTimer = window.setTimeout(() => {
    showTimer = null;
    show(chip, handlers);
  }, SHOW_DELAY_MS);
}

function cancelShow(): void {
  if (showTimer != null) window.clearTimeout(showTimer);
  showTimer = null;
}

function scheduleHide(): void {
  cancelHide();
  hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
}

function cancelHide(): void {
  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = null;
}

function hide(): void {
  cancelShow();
  cancelHide();
  if (card) card.hidden = true;
  anchor = null;
  expanded = false;
}

function ensureCard(): HTMLElement {
  if (card) return card;
  card = document.createElement('div');
  card.className = 'cite-card';
  card.hidden = true;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Citation details');
  // Keep the card open while the pointer is on it; let it go when it leaves.
  card.addEventListener('mouseenter', cancelHide);
  card.addEventListener('mouseleave', (event) => {
    const to = event.relatedTarget as Node | null;
    if (to && anchor?.contains(to)) return;
    scheduleHide();
  });
  document.body.append(card);
  return card;
}

function show(chip: HTMLElement, handlers: CiteCardHandlers): void {
  if (!chip.isConnected) return;
  const key = chip.getAttribute('data-citation-key') ?? '';
  const el = ensureCard();
  if (chip !== anchor) expanded = false;
  anchor = chip;
  el.replaceChildren(...build(key, referenceFor(key), handlers));
  el.hidden = false;
  place(el, chip);
}

function build(key: string, ref: ReferenceView | null, handlers: CiteCardHandlers): HTMLElement[] {
  const keyLine = document.createElement('div');
  keyLine.className = 'cite-card-key';
  keyLine.textContent = `@${key}`;

  if (!ref) {
    const missing = document.createElement('p');
    missing.className = 'cite-card-missing';
    missing.textContent = `Not in ${currentBibPath()}. Ask the RA to add it, or cite it again with /cite.`;
    return [keyLine, missing];
  }

  const authors = document.createElement('div');
  authors.className = 'cite-card-authors';
  authors.textContent = authorsLine(ref.authors) || 'Unknown authors';

  const title = document.createElement('div');
  title.className = 'cite-card-title';
  title.textContent = ref.title || '(untitled)';

  const source = document.createElement('div');
  source.className = 'cite-card-source';
  source.textContent = sourceLine(ref);

  const details = document.createElement('div');
  details.className = 'cite-card-details';
  details.hidden = !expanded;
  const abstract = document.createElement('p');
  abstract.className = 'cite-card-abstract';
  abstract.textContent = ref.abstract?.trim() || 'No abstract stored for this reference.';
  details.append(abstract);
  const links = referenceLinks(ref);
  if (links.length > 0) {
    const row = document.createElement('div');
    row.className = 'cite-card-links';
    for (const link of links) {
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label;
      row.append(a);
    }
    details.append(row);
  }

  const actions = document.createElement('div');
  actions.className = 'cite-card-actions';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-quiet btn-sm';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.textContent = expanded ? 'Less' : 'Details';
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    details.hidden = !expanded;
    toggle.textContent = expanded ? 'Less' : 'Details';
    toggle.setAttribute('aria-expanded', String(expanded));
    if (card && anchor) place(card, anchor);
  });
  actions.append(toggle);
  const bibFile = handlers.bibFile();
  if (bibFile) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-quiet btn-sm';
    open.title = `Show this entry in ${bibFile}`;
    open.textContent = `Open in ${bibFile.split('/').pop() ?? bibFile}`;
    open.addEventListener('click', () => {
      hide();
      handlers.openInBib(key, bibFile);
    });
    actions.append(open);
  }

  return [keyLine, authors, title, source, actions, details];
}

/** Below the chip, left-aligned; flips above when the viewport runs out. */
function place(el: HTMLElement, chip: HTMLElement): void {
  const rect = chip.getBoundingClientRect();
  el.style.left = '0px';
  el.style.top = '0px';
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const maxLeft = window.innerWidth - width - MARGIN_PX;
  const left = Math.max(MARGIN_PX, Math.min(rect.left, maxLeft));
  const below = rect.bottom + GAP_PX;
  const fitsBelow = below + height <= window.innerHeight - MARGIN_PX;
  const top = fitsBelow ? below : Math.max(MARGIN_PX, rect.top - GAP_PX - height);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}
