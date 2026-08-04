// Story 008-004: margin comments in the editor. Threads live server-side
// (routes/comments.js); this module renders them for the OPEN document:
//
//  1. Commented ranges get inline decorations (the suggestion-hunks pattern):
//     positions are found by quote search on load, then remap across local AND
//     remote edits via DecorationSet.map — collaborator Yjs changes arrive as
//     ProseMirror transactions, so live tracking needs no Yjs positions.
//  2. A side panel lists the open document's threads in anchor order: reply,
//     resolve/reopen, delete-own; resolved threads leave the margin but stay
//     browsable in a collapsed group. Click-to-focus works both ways.
//  3. A thread whose quote can't be found degrades to "orphaned" — visibly
//     listed, never dropped — and the flag round-trips to the server so other
//     tabs agree. Re-finding the text (e.g. after a version restore) clears it.
//  4. Commenting on a selection goes through a "Comment" item in Crepe's
//     selection toolbar (editor-core buildToolbar) — it captures the selection
//     as the anchor quote and opens the panel composer.
//
// State is re-fetched (debounced) on any comment event — main.ts calls
// refreshCommentsSoon() — and on document open (editor-core attaches).
//
// Epic 013 (story 002): parameterized by TRANSPORT (which REST namespace the
// calls go through — member /api/projects/* or reviewer /api/review/*) and
// IDENTITY (who "I" am and what I may do), so the external-reviewer surface
// reuses this module without touching member state. The member wrapper in
// editor.ts reproduces today's rules exactly.

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import { gutter, GutterMarker } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

import type { Comment, CommentThread } from './api';
import { agentIdentity } from './agents';
import { icon } from './icons';
import { toast } from './toast';

const key = new PluginKey<DecorationSet>('kuhn-comments');

type Meta = { type: 'set'; decos: Decoration[] } | { type: 'clear' };

/** Decoration-set plugin for commented ranges; positions remap across edits.
 *  Spread into Editor.use() alongside the suggestion plugins. */
export const commentsPlugin = $prose(
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
      // Local and remote (Yjs) edits both land here as transactions: after the
      // doc changes, re-check anchors — a deleted range orphans its thread
      // visibly, a drifted quote writes back, a restored one re-anchors.
      view: () => ({
        update: (view: EditorView, prevState: EditorState): void => {
          if (attached && view === attached.view && !prevState.doc.eq(view.state.doc)) {
            scheduleDocCheck();
          }
        },
      }),
    }),
);

/** REST access for comment threads — the member api.ts functions, or the
 *  reviewer's /api/review/* equivalents (which ignore projectId/path args:
 *  the review session pins both server-side). */
export interface CommentsTransport {
  getComments(projectId: number, path?: string): Promise<CommentThread[]>;
  createComment(
    projectId: number,
    params: { path: string; body: string; anchor?: { quote: string; start?: number; end?: number } },
  ): Promise<CommentThread>;
  replyToComment(projectId: number, rootId: number, body: string): Promise<Comment>;
  setCommentResolved(projectId: number, rootId: number, resolved: boolean): Promise<CommentThread>;
  updateCommentAnchor(
    projectId: number,
    rootId: number,
    anchor: { quote?: string; start?: number; end?: number; orphaned?: boolean },
  ): Promise<CommentThread>;
  deleteComment(projectId: number, id: number): Promise<void>;
}

/** Who the panel's user is and what they may do (epic 013 §3.2).
 *  Member: isMine by userId, compose/resolve-any/anchors on, delete-own.
 *  Reviewer: isMine by reviewLinkId; compose/resolve/delete per link mode;
 *  canPatchAnchors only in edit mode — it gates the two server writebacks
 *  (anchor drift + orphan flags) that would otherwise 403 into console noise. */
export interface CommentsIdentity {
  isMine(c: Comment): boolean;
  canCompose: boolean;
  canResolve(t: CommentThread): boolean;
  canDelete(t: CommentThread): boolean;
  canPatchAnchors: boolean;
}

interface Attached {
  view: EditorView;
  projectId: number;
  path: string;
  transport: CommentsTransport;
  identity: CommentsIdentity;
}

const REFRESH_DEBOUNCE_MS = 300;
// Anchor retries cover content that lands after attach (Yjs sync/seed race).
const ANCHOR_RETRY_MS = 600;
const ANCHOR_RETRIES = 5;

let attached: Attached | null = null;
let threads: CommentThread[] = [];
/** Root ids anchored in the current doc (subset of unresolved threads). */
let anchoredIds = new Set<number>();
let activeThreadId: number | null = null;
let refreshTimer: number | null = null;
let refreshSeq = 0;
let anchorRetries = 0;
/** Root id whose reply composer is open (survives re-renders). */
let replyOpenId: number | null = null;

/** Bind the open document's editor view (editor-core, after create). */
export function attachComments(view: EditorView, ctx: Omit<Attached, 'view'>): void {
  attached = { view, ...ctx };
  threads = [];
  anchoredIds = new Set();
  activeThreadId = null;
  replyOpenId = null;
  anchorRetries = 0;
  wirePanelToggle();
  wireDocClicks(view);
  closeComposer();
  renderPanel();
  refreshCommentsSoon();
}

/** The document is closing — drop all comment state (editor-core teardown).
 *  Pass the closing view to make the detach a no-op when a NEWER document has
 *  already attached (a superseded open racing a fresh one, story 012-002). */
export function detachComments(view?: EditorView): void {
  if (view && attached && attached.view !== view) return;
  attached = null;
  threads = [];
  anchoredIds = new Set();
  activeThreadId = null;
  replyOpenId = null;
  refreshSeq++;
  if (refreshTimer != null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (docCheckTimer != null) {
    clearTimeout(docCheckTimer);
    docCheckTimer = null;
  }
  closeComposer();
  renderPanel();
}

/** Debounced re-fetch + reconcile — call on any comment event. */
export function refreshCommentsSoon(): void {
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
  let fetched: CommentThread[];
  try {
    fetched = await ctx.transport.getComments(ctx.projectId, ctx.path);
  } catch {
    return; // backend hiccup — a later event retries
  }
  if (attached !== ctx || seq !== refreshSeq) return;
  threads = fetched;
  reconcile(ctx);
}

// Doc-change checks are debounced past the typing cadence; the decoration
// set itself remaps per keystroke, so nothing is stale in between.
const DOC_CHECK_MS = 700;
let docCheckTimer: number | null = null;

function scheduleDocCheck(): void {
  if (docCheckTimer != null) clearTimeout(docCheckTimer);
  docCheckTimer = window.setTimeout(() => {
    docCheckTimer = null;
    if (attached) reconcile(attached);
  }, DOC_CHECK_MS);
}

function reconcile(ctx: Attached): void {
  const doc = docTextWithMap(ctx.view);
  anchoredIds = new Set();
  const decos: Decoration[] = [];
  const withQuote = threads.filter((t) => !t.resolvedAt && t.anchor?.quote);

  for (const t of withQuote) {
    // A live (edit-mapped) decoration is the best anchor — it survives edits
    // inside the quoted text, which a quote re-search would misread as
    // deletion. Quote search covers fresh loads and restored text.
    const range = liveRange(ctx.view, t.id) ?? anchorInDoc(doc, t.anchor!.quote!, t.anchor!.start);
    if (!range || range.from >= range.to) continue;
    anchoredIds.add(t.id);
    decos.push(
      Decoration.inline(
        range.from,
        range.to,
        {
          class: `mc-range${t.id === activeThreadId ? ' is-active' : ''}`,
          'data-mc': String(t.id),
        },
        { comment: t.id },
      ),
    );
    if (ctx.identity.canPatchAnchors) maybeSyncQuote(ctx, t, range);
  }

  // Sync/seed race: nothing anchors while the doc is still empty — retry
  // before believing the orphan verdicts.
  if (withQuote.length > 0 && anchoredIds.size === 0 && doc.text.trim() === '' && anchorRetries < ANCHOR_RETRIES) {
    anchorRetries++;
    window.setTimeout(() => {
      if (attached === ctx) reconcile(ctx);
    }, ANCHOR_RETRY_MS);
    return;
  }
  anchorRetries = 0;

  // Orphan transitions before the panel renders, so the chip is current.
  // Server writeback is fire-and-forget: keeps the flag honest for other
  // tabs; a re-found anchor clears it. Identities without anchor-patch rights
  // (view/comment reviewers) keep the local flag but never write back —
  // member tabs own anchor maintenance for them.
  for (const t of withQuote) {
    const found = anchoredIds.has(t.id);
    if (found === t.orphaned) {
      t.orphaned = !found;
      if (ctx.identity.canPatchAnchors) {
        void ctx.transport.updateCommentAnchor(ctx.projectId, t.id, { orphaned: !found }).catch(() => {
          /* cosmetic — the next reconcile retries */
        });
      }
    }
  }

  ctx.view.dispatch(ctx.view.state.tr.setMeta(key, { type: 'set', decos }));
  renderPanel();
  updateToggleCount();
}

/**
 * Quote-drift writeback: edits inside a live-tracked range change what the
 * anchor text IS — persist the new quote (and offset hints) so the thread
 * re-anchors on the next load instead of orphaning. Also normalizes agent
 * quotes (markdown source) to rendered text on first anchor. No-op once the
 * stored quote matches.
 */
function maybeSyncQuote(ctx: Attached, t: CommentThread, range: { from: number; to: number }): void {
  const text = ctx.view.state.doc.textBetween(range.from, range.to, '\n', '');
  if (!text.trim() || !t.anchor || t.anchor.quote === text) return;
  t.anchor.quote = text;
  t.anchor.start = range.from;
  t.anchor.end = range.to;
  void ctx.transport.updateCommentAnchor(ctx.projectId, t.id, { quote: text, start: range.from, end: range.to })
    .catch(() => { /* cosmetic — the next reconcile retries */ });
}

// ---- Anchoring --------------------------------------------------------------
// The doc's visible text as one string with a per-character map back to
// ProseMirror positions; blocks join with single newlines.

interface DocText {
  text: string;
  /** pos[i] = PM position of text[i]. */
  pos: number[];
}

function docTextWithMap(view: EditorView): DocText {
  let text = '';
  const pos: number[] = [];
  view.state.doc.descendants((node, p) => {
    if (!node.isTextblock) return true;
    node.descendants((child, cp) => {
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) {
          text += child.text[i];
          pos.push(p + 1 + cp + i);
        }
      }
      return true;
    });
    text += '\n';
    pos.push(p + node.nodeSize - 1);
    return false;
  });
  return { text, pos };
}

/**
 * Find a quote in the doc text. Ladder: exact (blank-line runs collapsed) →
 * whitespace-normalized → markdown-syntax-stripped (agent quotes come from
 * the markdown source; the rendered doc has no `**` or `#`). The occurrence
 * nearest the stored start hint wins.
 */
function anchorInDoc(doc: DocText, quote: string, hint: number | null): { from: number; to: number } | null {
  const exact = quote.replace(/\n{2,}/g, '\n');
  let idx = pickOccurrence(doc.text, exact, hint);
  if (idx != null) return spanToPositions(doc, idx, exact.length);

  const { norm, map } = normalizeWithMap(doc.text);
  for (const candidate of [collapseWs(quote), collapseWs(stripMarkdown(quote))]) {
    if (!candidate) continue;
    idx = pickOccurrence(norm, candidate, hint);
    if (idx != null) {
      const start = map[idx];
      const end = map[idx + candidate.length - 1] + 1;
      return spanToPositions(doc, start, end - start);
    }
  }
  return null;
}

function spanToPositions(doc: DocText, start: number, length: number): { from: number; to: number } {
  return { from: doc.pos[start], to: doc.pos[start + length - 1] + 1 };
}

function pickOccurrence(haystack: string, needle: string, hint: number | null): number | null {
  const occ: number[] = [];
  let from = 0;
  while (occ.length < 50) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    occ.push(i);
    from = i + 1;
  }
  if (occ.length === 0) return null;
  if (hint == null || occ.length === 1) return occ[0];
  return occ.reduce((best, o) => (Math.abs(o - hint) < Math.abs(best - hint) ? o : best));
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Strip markdown block/inline syntax so a source-quoted string can match the
 *  rendered text (same normalization family as suggestion-hunks). */
function stripMarkdown(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*|__|[*_`~]/g, '');
}

/** Whitespace runs → single spaces, with map[i] = raw offset of norm[i]. */
function normalizeWithMap(content: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < content.length; i++) {
    if (/\s/.test(content[i])) {
      inSpace = true;
      continue;
    }
    if (inSpace && norm.length > 0) {
      norm += ' ';
      map.push(i - 1);
    }
    inSpace = false;
    norm += content[i];
    map.push(i);
  }
  return { norm, map };
}

/** Live (edit-mapped) range of a thread's decoration, if it is on screen. */
function liveRange(view: EditorView, id: number): { from: number; to: number } | null {
  const found = key
    .getState(view.state)
    ?.find(undefined, undefined, (spec) => (spec as { comment?: number }).comment === id);
  if (!found || found.length === 0) return null;
  return { from: found[0].from, to: found[found.length - 1].to };
}

// ---- Author identity --------------------------------------------------------

function authorOf(c: Comment): { label: string; colorVar: string } {
  if (c.agent) {
    const id = agentIdentity(c.agent);
    return { label: id.label, colorVar: id.colorVar };
  }
  // Externally-authored comment (epic 013): joined reviewer name + a distinct
  // color so external voices never render as members.
  if (c.reviewLinkId != null || c.reviewerName != null) {
    return { label: `${c.reviewerName ?? 'Reviewer'} · external reviewer`, colorVar: '--reviewer' };
  }
  return { label: c.userName ?? 'User', colorVar: '--accent' };
}

// ---- Panel ------------------------------------------------------------------

function panel(): HTMLElement | null {
  return document.getElementById('comments-panel');
}

let panelWired = false;

function wirePanelToggle(): void {
  if (panelWired) return;
  panelWired = true;
  document.getElementById('editor-comments-btn')?.addEventListener('click', () => togglePanel());
  document.getElementById('comments-close')?.addEventListener('click', () => togglePanel(false));
}

function togglePanel(open?: boolean): void {
  const p = panel();
  if (!p) return;
  const show = open ?? p.classList.contains('collapsed');
  p.classList.toggle('collapsed', !show);
  document.getElementById('editor-comments-btn')?.setAttribute('aria-pressed', String(show));
}

function updateToggleCount(): void {
  const btn = document.getElementById('editor-comments-btn');
  if (!btn) return;
  const n = threads.filter((t) => !t.resolvedAt).length;
  btn.textContent = n > 0 ? `Comments (${n})` : 'Comments';
}

function renderPanel(): void {
  const list = document.getElementById('comments-list');
  if (!list) return;
  const ctx = attached;
  if (!ctx || threads.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'mc-empty';
    empty.textContent = ctx
      ? ctx.identity.canCompose
        ? 'No comments yet. Select text in the document to comment on it.'
        : 'No comments on this document yet.'
      : 'Open a document to see its comments.';
    list.replaceChildren(empty);
    updateToggleCount();
    return;
  }

  const open = threads.filter((t) => !t.resolvedAt);
  const resolved = threads.filter((t) => t.resolvedAt);

  // Anchor order: live position when on screen, then orphans, then unanchored.
  const posOf = (t: CommentThread): number =>
    liveRange(ctx.view, t.id)?.from ?? (t.anchor?.quote ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER);
  open.sort((a, b) => posOf(a) - posOf(b));

  const frag = document.createDocumentFragment();
  for (const t of open) frag.append(threadCard(ctx, t));
  if (resolved.length > 0) {
    const details = document.createElement('details');
    details.className = 'mc-resolved';
    const summary = document.createElement('summary');
    summary.textContent = `Resolved (${resolved.length})`;
    details.append(summary);
    for (const t of resolved) details.append(threadCard(ctx, t));
    frag.append(details);
  }
  list.replaceChildren(frag);
  updateToggleCount();
}

function threadCard(ctx: Attached, t: CommentThread): HTMLElement {
  const card = document.createElement('article');
  card.className = 'mc-card';
  card.dataset.mc = String(t.id);
  if (t.id === activeThreadId) card.classList.add('is-active');
  if (t.resolvedAt) card.classList.add('is-resolved');

  card.append(commentHead(t));

  if (t.anchor?.quote) {
    const quote = document.createElement('blockquote');
    quote.className = 'mc-quote';
    quote.textContent = truncate(t.anchor.quote, 120);
    card.append(quote);
  }
  if (t.orphaned && !t.resolvedAt) {
    const chip = document.createElement('span');
    chip.className = 'mc-orphan';
    chip.textContent = 'Original text was removed';
    card.append(chip);
  }

  card.append(bodyEl(t));
  for (const r of t.replies) {
    const reply = document.createElement('div');
    reply.className = 'mc-reply';
    reply.append(commentHead(r), bodyEl(r));
    card.append(reply);
  }

  card.append(cardActions(ctx, t));

  // Click-to-focus (panel → document); buttons/inputs handle themselves.
  card.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, textarea, input, details')) return;
    focusThread(t.id, { scrollEditor: true });
  });
  return card;
}

function commentHead(c: Comment): HTMLElement {
  const head = document.createElement('div');
  head.className = 'mc-head';
  const author = authorOf(c);
  const dot = document.createElement('span');
  dot.className = 'mc-dot';
  dot.style.background = `var(${author.colorVar})`;
  const name = document.createElement('span');
  name.className = 'mc-author';
  name.textContent = author.label;
  const time = document.createElement('time');
  time.className = 'mc-time';
  time.textContent = new Date(c.createdAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  head.append(dot, name, time);
  return head;
}

function bodyEl(c: Comment): HTMLElement {
  const body = document.createElement('p');
  body.className = 'mc-body';
  body.textContent = c.body;
  return body;
}

function cardActions(ctx: Attached, t: CommentThread): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'mc-actions';

  if (!t.resolvedAt) {
    if (ctx.identity.canCompose) {
      actions.append(
        smallButton('Reply', () => {
          replyOpenId = replyOpenId === t.id ? null : t.id;
          renderPanel();
        }),
      );
    }
    if (ctx.identity.canResolve(t)) {
      actions.append(
        smallButton('Resolve', () =>
          void mutate(() => ctx.transport.setCommentResolved(ctx.projectId, t.id, true), 'Thread resolved')),
      );
    }
  } else if (ctx.identity.canResolve(t)) {
    actions.append(
      smallButton('Reopen', () =>
        void mutate(() => ctx.transport.setCommentResolved(ctx.projectId, t.id, false), 'Thread reopened')),
    );
  }
  if (ctx.identity.canDelete(t)) {
    actions.append(
      smallButton('Delete', () =>
        void mutate(() => ctx.transport.deleteComment(ctx.projectId, t.id), 'Comment deleted')),
    );
  }

  const wrap = document.createElement('div');
  wrap.append(actions);
  if (replyOpenId === t.id && !t.resolvedAt) wrap.append(replyComposer(ctx, t));
  return wrap;
}

function replyComposer(ctx: Attached, t: CommentThread): HTMLElement {
  const form = document.createElement('form');
  form.className = 'mc-compose';
  const input = document.createElement('textarea');
  input.className = 'mc-input';
  input.rows = 2;
  input.placeholder = 'Reply…';
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'btn btn-accent btn-sm';
  send.textContent = 'Reply';
  form.append(input, send);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    replyOpenId = null;
    void mutate(() => ctx.transport.replyToComment(ctx.projectId, t.id, body), 'Reply added');
  });
  setTimeout(() => input.focus(), 0);
  return form;
}

function smallButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-ghost btn-sm';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

async function mutate(call: () => Promise<unknown>, successMsg: string): Promise<void> {
  try {
    await call();
    toast(successMsg);
  } catch (err) {
    toast(`Comment update failed: ${(err as Error).message}`);
  } finally {
    refreshCommentsSoon();
  }
}

// ---- Click-to-focus (both ways) ---------------------------------------------

const wiredViews = new WeakSet<EditorView>();

function wireDocClicks(view: EditorView): void {
  if (wiredViews.has(view)) return;
  wiredViews.add(view);
  view.dom.addEventListener('click', (e) => {
    const hit = (e.target as HTMLElement).closest('[data-mc]');
    if (!hit) return;
    const id = parseInt((hit as HTMLElement).dataset.mc ?? '');
    if (Number.isNaN(id)) return;
    togglePanel(true);
    focusThread(id, { scrollPanel: true });
  });
}

function focusThread(id: number, opts: { scrollEditor?: boolean; scrollPanel?: boolean } = {}): void {
  const ctx = attached;
  if (!ctx) return;
  activeThreadId = id;
  // Restyle decorations with the new active id (positions unchanged).
  reconcile(ctx);
  if (opts.scrollEditor) {
    const range = liveRange(ctx.view, id);
    if (range) {
      const tr = ctx.view.state.tr
        .setSelection(TextSelection.create(ctx.view.state.doc, range.from))
        .scrollIntoView();
      ctx.view.dispatch(tr);
      ctx.view.focus();
    }
  }
  if (opts.scrollPanel) {
    document
      .querySelector(`#comments-list .mc-card[data-mc="${id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// ---- Selection composer -----------------------------------------------------

/**
 * Entry point for the Crepe toolbar "Comment" item (editor-core buildToolbar)
 * and the reviewer surface's selection affordance: capture the current
 * selection as the anchor quote and open the composer.
 */
export function beginCommentFromSelection(view: EditorView): void {
  if (!attached?.identity.canCompose) return;
  const sel = view.state.selection;
  if (sel.empty) return;
  const quote = view.state.doc.textBetween(sel.from, sel.to, '\n', '');
  if (!quote.trim()) return;
  openComposer({ quote, from: sel.from, to: sel.to });
}

function openComposer(sel: { quote: string; from: number; to: number }): void {
  const ctx = attached;
  const composer = document.getElementById('comments-composer');
  if (!ctx || !ctx.identity.canCompose || !composer) return;
  togglePanel(true);
  composer.hidden = false;

  const quote = composer.querySelector('.mc-quote') as HTMLElement;
  quote.textContent = truncate(sel.quote, 120);
  const input = composer.querySelector('.mc-input') as HTMLTextAreaElement;
  input.value = '';

  const form = composer.querySelector('form') as HTMLFormElement;
  form.onsubmit = (e): void => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    closeComposer();
    void mutate(() =>
      ctx.transport.createComment(ctx.projectId, {
        path: ctx.path,
        body,
        anchor: { quote: sel.quote, start: sel.from, end: sel.to },
      }), 'Comment added');
  };
  (composer.querySelector('.mc-cancel') as HTMLButtonElement).onclick = closeComposer;
  input.focus();
}

function closeComposer(): void {
  const composer = document.getElementById('comments-composer');
  if (composer) composer.hidden = true;
}

function truncate(s: string, n: number): string {
  const flat = collapseWs(s);
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

// ---- Source-mode gutter (story 039 surface; v1 static markers) --------------

class CommentMarker extends GutterMarker {
  toDOM(): Node {
    const span = document.createElement('span');
    span.className = 'cm-comment-marker';
    span.title = 'This line has margin comments (switch to rich text to read them)';
    span.innerHTML = icon('comment', { size: 11, stroke: 1.8 });
    return span;
  }
}

const COMMENT_MARKER = new CommentMarker();

/**
 * A CodeMirror gutter marking lines covered by unresolved comment anchors in
 * the raw markdown. Computed once at source-mode entry — source mode is a
 * single-writer detour, not a live collab surface.
 */
export async function sourceCommentGutter(
  projectId: number,
  path: string,
  text: string,
  transport: CommentsTransport,
): Promise<Extension> {
  let lines = new Set<number>();
  try {
    const fetched = await transport.getComments(projectId, path);
    lines = commentedLines(text, fetched);
  } catch {
    /* no gutter beats no source mode */
  }
  if (lines.size === 0) return [];
  return gutter({
    class: 'cm-comment-gutter',
    lineMarker: (view, line) => {
      const lineNo = view.state.doc.lineAt(line.from).number;
      return lines.has(lineNo) ? COMMENT_MARKER : null;
    },
  });
}

/** 1-based line numbers covered by each unresolved thread's quote in `text`. */
export function commentedLines(text: string, fetched: CommentThread[]): Set<number> {
  const lines = new Set<number>();
  for (const t of fetched) {
    if (t.resolvedAt || !t.anchor?.quote) continue;
    const idx = pickOccurrence(text, t.anchor.quote, t.anchor.start);
    if (idx == null) continue;
    const startLine = text.slice(0, idx).split('\n').length;
    const quoteLines = t.anchor.quote.split('\n').length;
    for (let l = startLine; l < startLine + quoteLines; l++) lines.add(l);
  }
  return lines;
}
