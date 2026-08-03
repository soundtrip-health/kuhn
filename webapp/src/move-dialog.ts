// "Move to…" destination picker (story 012-001) — the PRIMARY, keyboard-safe
// move path; drag-and-drop is layered on top of it, never a substitute.
//
// This module is deliberately dumb: it knows nothing about the API, the file
// tree or the backend's error codes. The caller hands it a pre-filtered list of
// legal destinations (the entry itself, its descendants and its current parent
// already removed) and an `onConfirm` that does the work and rejects with an
// already-human-readable Error; the dialog only picks a path and renders that
// message inline.
//
// NEVER call toast() from here: #toast-layer lives inside #editor-pane at
// z-index 70 (toast.ts, style.css) while .pb-overlay is z-index 100, so a toast
// raised from an open dialog renders behind it and the user sees nothing.
//
// Chrome is the canonical app modal, copied from project-browser.ts: a lazily
// built, module-cached .pb-overlay with role="dialog"/aria-modal, backdrop-click
// close, one document-level Escape listener guarded by !hidden, and trapFocus().

import { trapFocus } from './a11y';
import { icon } from './icons';

export interface MoveTarget {
  /** Destination directory, relative to the project root. '' = project root. */
  path: string;
  /** Folder name shown as the option's primary line. */
  label: string;
  /** Nesting depth, used for the visual indent only. */
  depth: number;
}

export interface MoveDialogOptions {
  /** Names what is being moved, e.g. `Move “notes.md”` — becomes the a11y name. */
  title: string;
  /** Caller-filtered legal destinations, tree order. path '' = project root. */
  targets: MoveTarget[];
  /** Performs the move. Rejects with an Error whose .message is user-facing. */
  onConfirm: (toDir: string) => Promise<void>;
}

const TITLE_ID = 'mv-title';
const LIST_ID = 'mv-list';

let overlay: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
/** Close fn for the currently open dialog — the shared Escape/backdrop path. */
let closeCurrent: (() => void) | null = null;

function ensureOverlay(): HTMLElement {
  if (overlay) return overlay;
  const root = document.createElement('div');
  overlay = root;
  root.id = 'move-dialog';
  root.className = 'pb-overlay';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  // Named by the heading, not a static aria-label: firing Move on the wrong row
  // must announce "Move “notes.md”, dialog", not just "Move to".
  root.setAttribute('aria-labelledby', TITLE_ID);
  root.addEventListener('click', (e) => {
    if (e.target === root) closeCurrent?.(); // backdrop click closes
  });
  document.body.append(root);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) {
      e.preventDefault();
      closeCurrent?.();
    }
  });
  return root;
}

/** The containing folder shown as the option's dimmed second line. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

export function openMoveDialog(opts: MoveDialogOptions): void {
  const root = ensureOverlay();
  const wasHidden = root.hidden;

  const modal = document.createElement('div');
  modal.className = 'pb-modal mv-modal';

  // --- header -------------------------------------------------------------
  const head = document.createElement('header');
  head.className = 'pb-head';
  const heading = document.createElement('div');
  const eyebrow = document.createElement('div');
  eyebrow.className = 'pb-eyebrow';
  eyebrow.textContent = 'Move to';
  const h2 = document.createElement('h2');
  h2.className = 'pb-org';
  h2.id = TITLE_ID;
  h2.textContent = opts.title; // textContent: the title carries a file name
  heading.append(eyebrow, h2);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pb-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icon('x', { size: 16, stroke: 2 });
  head.append(heading, closeBtn);

  // --- filter (editable combobox) ----------------------------------------
  // Standard combobox pattern: DOM focus stays here and the active option is
  // tracked with aria-activedescendant, which is only honoured on the focused
  // element. Options are non-focusable divs, so the Tab order inside the dialog
  // is filter -> Cancel -> Move -> Close no matter how many folders exist.
  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'pb-input mv-filter';
  filter.placeholder = 'Filter folders…';
  filter.autocomplete = 'off';
  filter.setAttribute('aria-label', 'Filter folders');
  filter.setAttribute('role', 'combobox');
  filter.setAttribute('aria-controls', LIST_ID);
  filter.setAttribute('aria-expanded', 'true');
  filter.setAttribute('aria-autocomplete', 'list');

  const list = document.createElement('div');
  list.id = LIST_ID;
  list.className = 'mv-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Destination folders');
  // Chrome makes a scrollable box with no focusable children a Tab stop of its
  // own (keyboard-focusable scrollers), which would insert a stop between the
  // filter and Cancel — and only when the list happens to overflow, so the Tab
  // order would vary with folder count. Arrow keys already scroll the list via
  // the active option, so opt out explicitly. tabindex="-1" is excluded by
  // a11y.ts FOCUSABLE, so trapFocus is unaffected.
  list.tabIndex = -1;

  const empty = document.createElement('div');
  empty.className = 'mv-empty';
  empty.setAttribute('role', 'status');
  empty.textContent = 'No folders match';
  empty.hidden = true;

  // Persistent live region: errors are rendered here, never as a toast.
  const error = document.createElement('div');
  error.className = 'mv-error';
  error.setAttribute('role', 'alert');

  // --- actions ------------------------------------------------------------
  const actions = document.createElement('div');
  actions.className = 'om-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-quiet btn-sm';
  cancelBtn.textContent = 'Cancel';
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn btn-sm btn-accent';
  confirmBtn.textContent = 'Move';
  confirmBtn.disabled = true;
  actions.append(cancelBtn, confirmBtn);

  modal.append(head, filter, list, empty, error, actions);

  // --- state --------------------------------------------------------------
  let filtered: MoveTarget[] = opts.targets;
  let active = opts.targets.length > 0 ? 0 : -1;
  let busy = false;

  const syncActive = (): void => {
    const options = [...list.children] as HTMLElement[];
    options.forEach((el, i) => {
      const on = i === active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
    });
    const activeEl = options[active];
    if (activeEl) {
      filter.setAttribute('aria-activedescendant', activeEl.id);
      activeEl.scrollIntoView({ block: 'nearest' });
    } else {
      filter.removeAttribute('aria-activedescendant');
    }
    confirmBtn.disabled = busy || active < 0;
  };

  const optionEl = (target: MoveTarget, index: number): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'mv-item';
    el.id = `mv-opt-${index}`;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.dataset.path = target.path;
    // Two folders can share a name (draft/figures vs sources/figures); the
    // indent alone is invisible to a screen reader, so every option carries its
    // containing folder as a second line, in its title, and in its a11y name.
    const parent = parentOf(target.path);
    const where = target.path === '' ? '' : parent || 'Project root';
    el.title = target.path || 'Project root';
    el.setAttribute(
      'aria-label',
      target.path === '' ? target.label : `${target.label}, in ${parent || 'the project root'}`,
    );
    el.style.paddingLeft = `calc(8px + ${target.depth} * 12px)`;

    const glyph = document.createElement('span');
    glyph.className = 'ol-doc-icon';
    glyph.innerHTML = icon('folder', { size: 14, stroke: 1.7 });
    const body = document.createElement('div');
    body.className = 'ol-doc-body';
    const name = document.createElement('div');
    name.className = 'ol-doc-name';
    name.textContent = target.label;
    body.append(name);
    if (where) {
      const meta = document.createElement('div');
      meta.className = 'ol-doc-meta';
      meta.textContent = where;
      body.append(meta);
    }
    el.append(glyph, body);

    // Keep DOM focus in the combobox — aria-activedescendant is ignored on an
    // unfocused element, so a click must not blur the filter.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', () => {
      active = index;
      syncActive();
      filter.focus();
    });
    el.addEventListener('dblclick', () => void confirmMove());
    return el;
  };

  const renderList = (): void => {
    list.replaceChildren(...filtered.map(optionEl));
    list.hidden = filtered.length === 0;
    empty.hidden = filtered.length > 0;
    filter.setAttribute('aria-expanded', String(filtered.length > 0));
    syncActive();
  };

  const applyFilter = (): void => {
    const query = filter.value.trim().toLowerCase();
    filtered = query
      ? opts.targets.filter(
          (t) =>
            t.label.toLowerCase().includes(query) || t.path.toLowerCase().includes(query),
        )
      : opts.targets;
    active = filtered.length > 0 ? 0 : -1;
    renderList();
  };

  const close = (): void => {
    if (root.hidden || busy) return; // never close over an in-flight move
    root.hidden = true;
    closeCurrent = null;
    // trapFocus's release restores focus to the opener (a11y.ts). On the cancel
    // path that row is still in the document and this is exactly right. On the
    // success path the caller's refresh has already replaced the tree, so the
    // captured node is detached and focus() is a no-op — post-move focus is the
    // caller's job (it re-resolves the row by its new path after the render).
    releaseFocus?.();
    releaseFocus = null;
  };

  const confirmMove = async (): Promise<void> => {
    if (busy || active < 0) return;
    const target = filtered[active];
    if (!target) return;
    busy = true;
    confirmBtn.disabled = true;
    error.textContent = '';
    try {
      await opts.onConfirm(target.path);
      busy = false;
      close();
    } catch (err) {
      busy = false;
      error.textContent = (err as Error).message || 'Could not move it there.';
      confirmBtn.disabled = active < 0;
      filter.focus();
    }
  };

  // --- wiring -------------------------------------------------------------
  closeBtn.addEventListener('click', () => close());
  cancelBtn.addEventListener('click', () => close());
  confirmBtn.addEventListener('click', () => void confirmMove());
  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', (e) => {
    // Home/End move the active option rather than the text caret: this is a
    // filter box, not an autocomplete that writes the value back.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (filtered.length === 0) return;
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + delta + filtered.length) % filtered.length;
      syncActive();
    } else if (e.key === 'Home' || e.key === 'End') {
      if (filtered.length === 0) return;
      e.preventDefault();
      active = e.key === 'Home' ? 0 : filtered.length - 1;
      syncActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void confirmMove();
    }
  });

  // --- open ---------------------------------------------------------------
  root.replaceChildren(modal);
  root.hidden = false; // before trapFocus: it filters on offsetParent
  closeCurrent = close;
  renderList();
  if (wasHidden) {
    releaseFocus?.();
    releaseFocus = trapFocus(root);
  }
  filter.focus(); // trapFocus lands on the close button; the filter is the entry
}

/**
 * Close the dialog from outside — e.g. when a remote change invalidates the
 * frozen target list. No-op when nothing is open or a move is in flight.
 */
export function closeMoveDialog(): void {
  closeCurrent?.();
}
