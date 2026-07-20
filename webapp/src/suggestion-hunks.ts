// Story 008-001: suggestion-mode review in the editor. Agent edits to draft
// documents land server-side as pending edits (full base/proposed blobs; hunks
// derived with jsdiff). This module renders them for the OPEN document:
//
//  1. Fresh rows render inline — per-hunk widget decorations modeled on
//     write-suggestion.ts: deletions as struck-through inline decorations,
//     insertions as a green preview widget, ✓/✗ per hunk, plus a header bar
//     with Accept all / Reject all. Decorations live outside the doc and remap
//     across concurrent edits.
//  2. Accept/reject are SERVER-driven: buttons flush any pending save, then
//     call the REST endpoints. The server writes the file and publishes the
//     normal file_change (Yjs eviction + history commit included), so the open
//     editor refreshes through the same path as agent direct writes. Hunks are
//     NEVER applied to the doc client-side.
//  3. A stale row, or a hunk whose old-side text can't be located in the doc,
//     degrades to side-by-side review: a modal (the history-panel
//     unifiedMergeView pattern) with "Replace document with proposed"
//     (accept + force) and "Discard suggestion" (reject all).
//
// State is re-fetched (debounced) on ANY file_change event — main.ts calls
// refreshSuggestionsSoon() — and on document open (editor.ts attaches).

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';

import { unifiedMergeView } from '@codemirror/merge';
import { markdown as cmMarkdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState as CmEditorState } from '@codemirror/state';
import { EditorView as CmEditorView } from '@codemirror/view';

import {
  acceptPendingEdit,
  getPendingEdits,
  readTextFile,
  rejectPendingEdit,
  type PendingEdit,
  type PendingHunk,
} from './api';
import { agentIdentity } from './agents';
import { icon } from './icons';
import { toast } from './toast';

const key = new PluginKey<DecorationSet>('kuhn-suggestion-hunks');

type Meta = { type: 'set'; decos: Decoration[] } | { type: 'clear' };

/** Decoration-set plugin for suggestion hunks; positions remap across edits.
 *  Spread into Editor.use() alongside the /write suggestion plugin. */
export const suggestionHunksPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key,
      state: {
        init: () => DecorationSet.empty,
        apply(tr: Transaction, set: DecorationSet): DecorationSet {
          const meta = tr.getMeta(key) as Meta | undefined;
          if (meta?.type === 'set') return DecorationSet.create(tr.doc, meta.decos);
          if (meta?.type === 'clear') return DecorationSet.empty;
          return set.map(tr.mapping, tr.doc);
        },
      },
      props: {
        decorations: (state: EditorState) => key.getState(state),
      },
    }),
);

export interface SuggestionContext {
  projectId: number;
  path: string;
  /** Persist pending editor edits before any accept/reject (history-panel rule). */
  flush: () => Promise<void> | void;
}

interface Attached extends SuggestionContext {
  view: EditorView;
}

const REFRESH_DEBOUNCE_MS = 300;
// Anchor retries cover content that lands after attach (Yjs sync/seed race).
const ANCHOR_RETRY_MS = 600;
const ANCHOR_RETRIES = 5;

let attached: Attached | null = null;
let refreshTimer: number | null = null;
let refreshSeq = 0;
let anchorRetries = 0;
let busy = false; // one accept/reject in flight at a time

/** Bind the open document's editor view (editor.ts, after create). */
export function attachSuggestions(view: EditorView, ctx: SuggestionContext): void {
  attached = { view, ...ctx };
  anchorRetries = 0;
  closeModal();
  refreshSuggestionsSoon();
}

/** The document is closing — drop all suggestion state (editor.ts teardown). */
export function detachSuggestions(): void {
  attached = null;
  refreshSeq++;
  if (refreshTimer != null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  closeModal();
}

/** Debounced re-fetch + reconcile — call on any file_change event. */
export function refreshSuggestionsSoon(): void {
  if (!attached) return;
  if (refreshTimer != null) clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, REFRESH_DEBOUNCE_MS);
}

async function refresh(): Promise<void> {
  const ctx = attached;
  if (!ctx) return;
  const seq = ++refreshSeq;
  let edits: PendingEdit[];
  try {
    edits = await getPendingEdits(ctx.projectId, ctx.path);
  } catch {
    return; // backend hiccup (or endpoint not yet live) — a later event retries
  }
  if (attached !== ctx || seq !== refreshSeq) return;
  const edit = edits.find((e) => e.path === ctx.path) ?? null;
  render(ctx, edit);
}

function render(ctx: Attached, edit: PendingEdit | null): void {
  if (!edit || (!edit.stale && edit.hunks.length === 0)) {
    anchorRetries = 0;
    clearDecorations(ctx.view);
    closeModal();
    return;
  }
  if (edit.stale) {
    anchorRetries = 0;
    renderFallback(ctx, edit, 'stale');
    return;
  }
  const anchored = anchorHunks(ctx.view, edit.hunks);
  if (!anchored) {
    // Content may not have synced into the view yet — retry before degrading.
    if (anchorRetries < ANCHOR_RETRIES) {
      anchorRetries++;
      window.setTimeout(() => {
        if (attached === ctx) void refresh();
      }, ANCHOR_RETRY_MS);
      return;
    }
    renderFallback(ctx, edit, 'unanchored');
    return;
  }
  anchorRetries = 0;
  closeModal();

  const decos: Decoration[] = [
    Decoration.widget(0, buildHeader(ctx, edit, 'inline'), {
      key: 'sh-bar',
      side: -1,
      ignoreSelection: true,
      stopEvent: () => true,
    }),
  ];
  for (let i = 0; i < edit.hunks.length; i++) {
    const hunk = edit.hunks[i];
    const anchor = anchored[i];
    for (const range of anchor.removed) {
      decos.push(Decoration.inline(range.from, range.to, { class: 'sh-del' }));
    }
    decos.push(
      Decoration.widget(anchor.widgetPos, buildHunkWidget(ctx, edit, hunk), {
        key: `sh-hunk-${hunk.index}-${hunk.hash}`,
        side: 1,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
  }
  ctx.view.dispatch(ctx.view.state.tr.setMeta(key, { type: 'set', decos }));
}

/** Stale or unanchorable: a header bar that routes to side-by-side review. */
function renderFallback(ctx: Attached, edit: PendingEdit, reason: 'stale' | 'unanchored'): void {
  const decos = [
    Decoration.widget(0, buildHeader(ctx, edit, reason), {
      key: 'sh-bar',
      side: -1,
      ignoreSelection: true,
      stopEvent: () => true,
    }),
  ];
  ctx.view.dispatch(ctx.view.state.tr.setMeta(key, { type: 'set', decos }));
}

function clearDecorations(view: EditorView): void {
  if (key.getState(view.state)?.find().length) {
    view.dispatch(view.state.tr.setMeta(key, { type: 'clear' }));
  }
}

// ---- Anchoring --------------------------------------------------------------

interface Block {
  from: number;
  to: number;
  norm: string;
}

interface AnchoredHunk {
  /** Inline ranges to strike through (matched removed lines). */
  removed: { from: number; to: number }[];
  /** Widget position for the insertion preview + hunk controls. */
  widgetPos: number;
}

/** The doc's textblocks with their content ranges and normalized text. */
function docBlocks(view: EditorView): Block[] {
  const blocks: Block[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ from: pos + 1, to: pos + 1 + node.content.size, norm: normalize(node.textContent) });
      return false;
    }
    return true;
  });
  return blocks;
}

/** Collapse a markdown source line and a rendered textblock onto common ground:
 *  strip block markers, emphasis/code syntax, and link syntax, then whitespace. */
function normalize(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*|__|[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function blockMatches(blockNorm: string, lineNorm: string): boolean {
  if (blockNorm === lineNorm) return true;
  // Inline atoms (citation chips) drop out of textContent — allow containment
  // for lines long enough that it can't be a coincidence.
  return lineNorm.length > 12 && (blockNorm.includes(lineNorm) || lineNorm.includes(blockNorm));
}

/** Anchor every hunk's old side in the doc; null if any hunk fails. */
function anchorHunks(view: EditorView, hunks: PendingHunk[]): AnchoredHunk[] | null {
  const blocks = docBlocks(view);
  const anchored: AnchoredHunk[] = [];
  for (const hunk of hunks) {
    const anchor = anchorHunk(hunk, blocks);
    if (!anchor) return null;
    anchored.push(anchor);
  }
  return anchored;
}

function anchorHunk(hunk: PendingHunk, blocks: Block[]): AnchoredHunk | null {
  // Old side of the hunk (context + removals) as normalized non-blank lines;
  // blank markdown lines separate blocks and have no textblock of their own.
  const oldSide: { norm: string; removed: boolean }[] = [];
  // How many old-side entries precede the first insertion — the widget slots
  // after that block so the preview reads in place.
  let beforeInsert: number | null = null;
  for (const line of hunk.lines) {
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) {
      if (beforeInsert == null) beforeInsert = oldSide.length;
      continue;
    }
    const norm = normalize(line.slice(1));
    if (norm) oldSide.push({ norm, removed: line.startsWith('-') });
  }
  if (beforeInsert == null) beforeInsert = oldSide.length;

  if (oldSide.length === 0) {
    // Insertion into an empty document — anchor at the start.
    return { removed: [], widgetPos: 0 };
  }

  outer: for (let i = 0; i <= blocks.length - oldSide.length; i++) {
    for (let j = 0; j < oldSide.length; j++) {
      if (!blockMatches(blocks[i + j].norm, oldSide[j].norm)) continue outer;
    }
    const matched = blocks.slice(i, i + oldSide.length);
    const removed = matched
      .filter((_, j) => oldSide[j].removed)
      .map((b) => ({ from: b.from, to: b.to }));
    const widgetPos =
      beforeInsert > 0
        ? matched[beforeInsert - 1].to
        : Math.max(0, matched[0].from - 1);
    return { removed, widgetPos };
  }
  return null;
}

// ---- Widget DOM -------------------------------------------------------------

function agentLabel(edit: PendingEdit): string {
  return edit.agent ? agentIdentity(edit.agent).label : 'an agent';
}

function buildHeader(
  ctx: Attached,
  edit: PendingEdit,
  mode: 'inline' | 'stale' | 'unanchored',
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'suggestion-bar';
  bar.setAttribute('contenteditable', 'false');
  const roleVar = edit.agent ? agentIdentity(edit.agent).colorVar : '--writer';
  bar.style.setProperty('--role', `var(${roleVar})`);

  const n = edit.hunks.length;
  const label = document.createElement('span');
  label.className = 'sh-bar-text';
  label.textContent =
    mode === 'inline'
      ? `${n} suggested change${n === 1 ? '' : 's'} from ${agentLabel(edit)}`
      : mode === 'stale'
        ? `Suggested changes from ${agentLabel(edit)} — the document moved on; review side-by-side`
        : `Suggested changes from ${agentLabel(edit)} — review side-by-side`;

  const dot = document.createElement('span');
  dot.className = 'sh-bar-dot';
  bar.append(dot, label);

  if (mode === 'inline') {
    bar.append(
      barButton('Accept all', 'sh-accept-all btn btn-accent', () =>
        mutate(ctx, () => acceptPendingEdit(ctx.projectId, edit.id), 'Suggestion applied'),
      ),
      barSep(),
      barButton('Reject all', 'sh-reject-all btn btn-ghost', () =>
        mutate(ctx, () => rejectPendingEdit(ctx.projectId, edit.id), 'Suggestion discarded'),
      ),
    );
  } else {
    bar.append(
      barButton('Review', 'sh-review btn btn-accent', () => void openReviewModal(ctx, edit)),
      barSep(),
      barButton('Discard', 'sh-reject-all btn btn-ghost', () =>
        mutate(ctx, () => rejectPendingEdit(ctx.projectId, edit.id), 'Suggestion discarded'),
      ),
    );
  }
  return bar;
}

function barSep(): HTMLElement {
  const sep = document.createElement('span');
  sep.className = 'sh-bar-sep';
  sep.textContent = '·';
  return sep;
}

function barButton(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}

function buildHunkWidget(ctx: Attached, edit: PendingEdit, hunk: PendingHunk): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'suggestion-hunk';
  wrap.setAttribute('contenteditable', 'false');

  const added = hunk.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
  const insText = added.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (insText) {
    const ins = document.createElement('div');
    ins.className = 'sh-ins';
    ins.textContent = insText;
    wrap.append(ins);
  }

  const actions = document.createElement('div');
  actions.className = 'sh-hunk-actions';
  const ref = { index: hunk.index, hash: hunk.hash };
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.className = 'sh-accept';
  accept.title = 'Accept this change';
  accept.innerHTML = icon('check', { size: 13, stroke: 2.2 });
  accept.addEventListener('mousedown', (e) => e.preventDefault());
  accept.addEventListener('click', () =>
    mutate(ctx, () => acceptPendingEdit(ctx.projectId, edit.id, { hunk: ref }), 'Change applied'),
  );
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'sh-reject';
  reject.title = 'Reject this change';
  reject.innerHTML = icon('x', { size: 13, stroke: 2.2 });
  reject.addEventListener('mousedown', (e) => e.preventDefault());
  reject.addEventListener('click', () =>
    mutate(ctx, () => rejectPendingEdit(ctx.projectId, edit.id, ref), 'Change discarded'),
  );
  actions.append(accept, reject);
  wrap.append(actions);
  return wrap;
}

// ---- Accept / reject --------------------------------------------------------

/**
 * Run one accept/reject: flush any pending editor save, call the endpoint,
 * drop the (now position/hash-stale) decorations, and re-fetch. On accept the
 * server's real file_change refreshes the editor content through the existing
 * agent-write path; the scheduled refresh here covers a downed feed.
 */
function mutate(
  ctx: Attached,
  call: () => Promise<{ remaining: number }>,
  successMsg: string,
): void {
  if (busy) return;
  busy = true;
  void (async () => {
    try {
      await ctx.flush();
      await call();
      clearDecorations(ctx.view);
      closeModal();
      toast(successMsg);
    } catch (err) {
      // 409 = the hunk moved underneath us — the refresh below re-anchors.
      toast(`Could not update the suggestion: ${(err as Error).message}`);
    } finally {
      busy = false;
      refreshSuggestionsSoon();
    }
  })();
}

// ---- Side-by-side fallback modal --------------------------------------------

let modal: HTMLElement | null = null;
let modalDiff: CmEditorView | null = null;

function closeModal(): void {
  modalDiff?.destroy();
  modalDiff = null;
  modal?.remove();
  modal = null;
}

/** Reconstruct the proposed text from base + hunks when the row omitted it
 *  (fresh rows return only hunks). Display-only — never written anywhere. */
function applyHunksToText(base: string, hunks: PendingHunk[]): string {
  const lines = base.split('\n');
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    out.push(...lines.slice(cursor, start));
    cursor = start;
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue;
      if (line.startsWith('+')) {
        out.push(line.slice(1));
      } else {
        if (line.startsWith(' ')) out.push(line.slice(1));
        cursor++;
      }
    }
  }
  out.push(...lines.slice(cursor));
  return out.join('\n');
}

async function openReviewModal(ctx: Attached, edit: PendingEdit): Promise<void> {
  closeModal();
  // Stale rows carry both blobs inline; a fresh (unanchorable) row's base is
  // the disk content by definition — fetch it, and rebuild proposed if absent.
  const base = edit.baseContent ?? (await readTextFile(ctx.projectId, edit.path)) ?? '';
  const proposed = edit.proposedContent ?? applyHunksToText(base, edit.hunks);
  if (attached !== ctx) return;

  modal = document.createElement('div');
  modal.className = 'hy-overlay';
  modal.id = 'suggestion-review';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Review suggested changes');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  const card = document.createElement('div');
  card.className = 'hy-card';

  const head = document.createElement('div');
  head.className = 'hy-head';
  head.innerHTML =
    `<span class="panel-eyebrow">Suggested changes</span>` +
    `<span class="hy-path"></span>` +
    `<span class="spacer"></span>`;
  head.querySelector('.hy-path')!.textContent = `${edit.path} · from ${agentLabel(edit)}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'preview-close';
  close.title = 'Close review';
  close.setAttribute('aria-label', 'Close review');
  close.innerHTML = '&times;';
  close.addEventListener('click', closeModal);
  head.append(close);

  const body = document.createElement('div');
  body.className = 'hy-body';
  const diff = document.createElement('div');
  diff.className = 'hy-diff';
  body.append(diff);
  modalDiff = new CmEditorView({
    parent: diff,
    state: CmEditorState.create({
      doc: proposed,
      extensions: [
        unifiedMergeView({ original: base, mergeControls: false, gutter: true }),
        CmEditorView.editable.of(false),
        CmEditorState.readOnly.of(true),
        cmMarkdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        CmEditorView.lineWrapping,
      ],
    }),
  });

  const foot = document.createElement('div');
  foot.className = 'hy-foot';
  const hint = document.createElement('span');
  hint.className = 'hy-hint';
  hint.textContent =
    'Replacing overwrites the document with the proposed version — the current state is kept in history.';
  const actions = document.createElement('div');
  actions.className = 'sh-modal-actions';
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'sh-modal-discard btn btn-ghost btn-sm';
  discard.textContent = 'Discard suggestion';
  discard.addEventListener('click', () =>
    mutate(ctx, () => rejectPendingEdit(ctx.projectId, edit.id), 'Suggestion discarded'),
  );
  const replace = document.createElement('button');
  replace.type = 'button';
  replace.className = 'sh-modal-replace btn btn-solid btn-sm';
  replace.textContent = 'Replace document with proposed';
  replace.addEventListener('click', () =>
    mutate(ctx, () => acceptPendingEdit(ctx.projectId, edit.id, { force: true }), 'Suggestion applied'),
  );
  actions.append(discard, replace);
  foot.append(hint, actions);

  card.append(head, body, foot);
  modal.append(card);
  document.body.append(modal);
}
