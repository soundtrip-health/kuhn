// Reviewer entry point (epic 013 story 002): boot for /review/<token>.
//
//   parse token → lookup → claim screen or refusal screen → context → openDoc
//
// The bundle's network surface is /api/review/* plus the Yjs websocket —
// nothing member-only is imported (no main.ts, login, files, chat, workspace,
// preview, history panel, SSE feed, pending edits, bib refresh). Citation
// chips render from the doc schema; their bib tooltips simply stay empty.
//
// Mode UX (§3.3): view = read-only doc + readable comments; comment = the same
// plus composing (a floating "Comment" affordance stands in for the editable-
// only selection toolbar); edit = full editing with autosave and Cmd+S
// checkpoints. Close codes: 4001 removed / 4002 moved (transparent refresh) /
// 4003 revoked / 4004 expired / 4005 refresh (file changed under a
// reviewer-only room — reconnect re-syncs fresh from storage).

import '../kuhn-tokens.css';
import '../style.css';
import './review.css';

import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { WebsocketProvider } from 'y-websocket';
import { Doc as YDoc } from 'yjs';

import { BACKEND_WS_URL, type Comment, type CommentThread } from '../api';
import { beginCommentFromSelection, type CommentsIdentity } from '../comments';
import {
  CLOSE_LINK_EXPIRED,
  CLOSE_LINK_REVOKED,
  CLOSE_ROOM_EVICTED,
  CLOSE_ROOM_MOVED,
  openDoc,
  roomName,
  type DocHandle,
  type DocTransport,
  type SaveStateName,
} from '../editor-core';
import {
  claimLink,
  getContext,
  getFile,
  lookupLink,
  putFile,
  reviewCommentsApi,
  ReviewApiError,
  type ReviewContext,
} from './review-api';
import { hideOverlay, showClaimScreen, showRefusal, type RefusalKind } from './claim';

// The reconnectable "document updated" close code (agent-backend
// yjs-websocket.js CLOSE_DOC_REFRESH). Deliberately NOT terminal in
// editor-core; the reviewer surface intercepts it and re-opens fresh — letting
// y-websocket auto-reconnect with the stale local Y.Doc would re-seed the new
// room with exactly the bytes the refresh exists to replace.
const CLOSE_DOC_REFRESH = 4005;

const TERMINAL_CODES = new Set([
  CLOSE_ROOM_EVICTED,
  CLOSE_ROOM_MOVED,
  CLOSE_LINK_REVOKED,
  CLOSE_LINK_EXPIRED,
]);

/** Concrete value of --reviewer (kuhn-tokens.css) — awareness cursor colors
 *  travel to other clients as literals, not CSS vars. */
const REVIEWER_COLOR = '#B0524E';

/** Grace period after an empty first sync before falling back to a static
 *  render: a write-capable member may be milliseconds from seeding. */
const STATIC_FALLBACK_DELAY_MS = 600;

/** Consecutive abnormal socket closes before probing the REST session to find
 *  out whether the credential (not the network) is what died. */
const PROBE_AFTER_FAILURES = 3;

const MODE_BADGE: Record<ReviewContext['mode'], string> = {
  view: 'view only',
  comment: 'can comment',
  edit: 'can edit',
};

// ---- State ------------------------------------------------------------------

let token: string | null = null;
let ctx: ReviewContext | null = null;
/** Monotonic open sequence — every (re)mount bumps it; async continuations
 *  from a superseded mount check it and bail (the member editor.ts pattern). */
let seq = 0;
let handle: DocHandle | null = null;
/** Headless room watcher while the static fallback is showing. */
let watcher: { provider: WebsocketProvider; ydoc: YDoc } | null = null;
/** A terminal screen is up — nothing may remount. */
let ended = false;
let refreshing = false;
let probing = false;

// ---- Chrome -----------------------------------------------------------------

const el = (id: string): HTMLElement | null => document.getElementById(id);

function renderChrome(c: ReviewContext): void {
  document.title = `${c.docTitle} · Kuhn review`;
  const title = el('review-title');
  if (title) title.textContent = c.docTitle;
  const badge = el('review-mode-badge');
  if (badge) {
    badge.textContent = MODE_BADGE[c.mode];
    badge.dataset.mode = c.mode;
    badge.hidden = false;
  }
  const name = el('review-name');
  if (name) name.textContent = `${c.name} · external reviewer`;
  const path = el('editor-path');
  if (path) path.textContent = c.path;
  const statusDoc = el('status-doc');
  if (statusDoc) statusDoc.textContent = c.path;
  if (c.mode !== 'edit') {
    const save = el('status-save');
    if (save) {
      save.dataset.state = 'saved';
      save.textContent = 'read-only';
    }
  }
}

function setSaveState(state: SaveStateName, detail?: string): void {
  if (ctx?.mode !== 'edit') return;
  const save = el('status-save');
  if (!save) return;
  save.dataset.state = state;
  const labels: Record<SaveStateName, string> = {
    saved: 'saved',
    saving: 'saving…',
    dirty: 'unsaved changes',
    error: `save failed${detail ? `: ${detail}` : ''}`,
  };
  save.textContent = labels[state];
}

function setNotice(text: string): void {
  const notice = el('status-notice');
  if (notice) notice.textContent = text;
}

function updateWordCount(markdown: string): void {
  const count = markdown.trim() === '' ? 0 : markdown.trim().split(/\s+/).length;
  const wc = el('editor-wordcount');
  if (wc) wc.textContent = `${count} word${count === 1 ? '' : 's'}`;
}

function openCommentsPanel(): void {
  el('comments-panel')?.classList.remove('collapsed');
  el('editor-comments-btn')?.setAttribute('aria-pressed', 'true');
}

// ---- Identity ---------------------------------------------------------------

/**
 * What this reviewer may do in the comments panel. `isMine` matches by
 * reviewLinkId presence + the reviewer's claimed name — the context endpoint
 * does not expose our numeric linkId, so this is a display heuristic; the
 * server enforces the exact-link rule on every mutation (403 on a miss).
 */
function identityFor(c: ReviewContext): CommentsIdentity {
  const isMine = (comment: Comment): boolean =>
    comment.reviewLinkId != null && (comment.reviewerName ?? null) === c.name;
  const canAct = (t: CommentThread): boolean => c.mode !== 'view' && isMine(t);
  return {
    isMine,
    canCompose: c.mode !== 'view',
    canResolve: canAct,
    canDelete: canAct,
    // View/comment reviewers never write anchors back — member tabs own
    // anchor maintenance for them (the two writeback leaks, plan §3.2).
    canPatchAnchors: c.mode === 'edit',
  };
}

// ---- Document lifecycle -----------------------------------------------------

async function teardown(): Promise<void> {
  const w = watcher;
  watcher = null;
  if (w) {
    w.provider.destroy();
    w.ydoc.destroy();
  }
  const h = handle;
  handle = null;
  if (h) await h.destroy();
}

function transportFor(editable: boolean): DocTransport {
  return {
    readFile: () => getFile(),
    writeFile: editable
      ? (_projectId, _path, content, opts): Promise<void> => putFile(content, opts)
      : undefined,
    commentsApi: reviewCommentsApi,
    wsUrl: BACKEND_WS_URL,
  };
}

/** Open the collaborative editor on the linked room. */
async function mountCollab(): Promise<void> {
  const c = ctx;
  if (!c || ended) return;
  const my = ++seq;
  await teardown();
  const editable = c.mode === 'edit';
  const h = await openDoc({
    projectId: c.projectId,
    path: c.path,
    editable,
    features: { slashCommands: false, suggestions: false, bib: false, comments: true },
    transport: transportFor(editable),
    awarenessUser: { name: c.name, external: true, color: REVIEWER_COLOR },
    commentsIdentity: identityFor(c),
    onClose: (code, reason) => void handleTerminalClose(code, reason),
    onSaveState: setSaveState,
    onMarkdownUpdated: updateWordCount,
    onSynced: ({ empty }) => {
      if (empty && !editable) scheduleStaticFallback(my);
    },
    placeholder: 'Start writing…',
  });
  if (seq !== my || ended) {
    await h.destroy();
    return;
  }
  handle = h;
  wireProviderExtras(my);
  if (c.mode === 'comment') openCommentsPanel();
}

/**
 * Empty-room strategy for read-only modes (§3.3): the room is empty and we
 * must never seed it, so render current storage statically and put a headless
 * watcher on the room — the moment a write-capable client seeds real content,
 * swap to the live collab doc. The server room never receives reviewer bytes.
 */
function scheduleStaticFallback(my: number): void {
  window.setTimeout(() => {
    if (seq !== my || ended) return;
    const frag = handle?.ydoc?.getXmlFragment('prosemirror');
    if (frag != null && frag.length > 0) return; // someone seeded meanwhile
    void mountStatic();
  }, STATIC_FALLBACK_DELAY_MS);
}

async function mountStatic(): Promise<void> {
  const c = ctx;
  if (!c || ended) return;
  const my = ++seq;
  await teardown();
  let stored: string | null;
  try {
    stored = await getFile();
  } catch (err) {
    if (!(err instanceof ReviewApiError && err.status === 401)) setNotice('Reconnecting…');
    return; // a 401 routes through the unauthorized listener
  }
  if (seq !== my || ended) return;
  const h = await openDoc({
    projectId: c.projectId,
    path: c.path,
    editable: false,
    collab: false,
    features: { slashCommands: false, suggestions: false, bib: false, comments: true },
    transport: transportFor(false),
    awarenessUser: null,
    commentsIdentity: identityFor(c),
    stored,
    onMarkdownUpdated: updateWordCount,
  });
  if (seq !== my || ended) {
    await h.destroy();
    return;
  }
  handle = h;
  if (c.mode === 'comment') openCommentsPanel();

  const ydoc = new YDoc();
  const provider = new WebsocketProvider(
    `${BACKEND_WS_URL}/yjs-websocket`,
    roomName(c.projectId, c.path),
    ydoc,
  );
  watcher = { provider, ydoc };
  ydoc.on('update', () => {
    if (seq !== my || ended) return;
    if (ydoc.getXmlFragment('prosemirror').length > 0) void mountCollab();
  });
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (event == null || seq !== my || ended) return;
    if (event.code === CLOSE_LINK_REVOKED) void endWith('revoked');
    else if (event.code === CLOSE_LINK_EXPIRED) void endWith('expired');
    else if (event.code === CLOSE_ROOM_EVICTED) void endWith('removed');
    else if (event.code === CLOSE_ROOM_MOVED || event.code === CLOSE_DOC_REFRESH) {
      provider.disconnect();
      void refreshDoc();
    }
  });
}

/** Terminal close codes routed by editor-core's onClose. */
async function handleTerminalClose(code: number, _reason: string): Promise<void> {
  if (ended) return;
  switch (code) {
    case CLOSE_LINK_REVOKED:
      await endWith('revoked');
      break;
    case CLOSE_LINK_EXPIRED:
      await endWith('expired');
      break;
    case CLOSE_ROOM_EVICTED:
      await endWith('removed');
      break;
    case CLOSE_ROOM_MOVED:
      // The document moved: the review link row was rekeyed server-side, so a
      // fresh context carries the new path — follow it transparently.
      setNotice('Document moved — following…');
      await refreshDoc();
      break;
    default:
      break;
  }
}

/** Re-fetch context (path may have changed) and remount from scratch. */
async function refreshDoc(): Promise<void> {
  if (ended || refreshing) return;
  refreshing = true;
  try {
    const c = await getContext();
    ctx = c;
    renderChrome(c);
    await mountCollab();
    setNotice('');
  } catch (err) {
    if (err instanceof ReviewApiError && err.status === 401) {
      // The unauthorized listener resolves the end screen.
      return;
    }
    setNotice('Reconnecting…');
    window.setTimeout(() => void refreshDoc(), 3000);
  } finally {
    refreshing = false;
  }
}

/** Non-terminal close handling on the live collab provider: the 4005 refresh
 *  code, and a "why do we keep failing?" probe after repeated retries (covers
 *  upgrade-refusal loops after a revocation while the page was asleep). */
function wireProviderExtras(my: number): void {
  const provider = handle?.provider;
  if (!provider) return;
  let failures = 0;
  provider.on('sync', () => {
    failures = 0;
    setNotice('');
  });
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (event == null || seq !== my || ended) return;
    if (event.code === CLOSE_DOC_REFRESH) {
      provider.disconnect();
      setNotice('Document updated — refreshing…');
      void refreshDoc();
      return;
    }
    if (TERMINAL_CODES.has(event.code)) return; // routed via onClose
    failures += 1;
    setNotice('Reconnecting…');
    if (failures >= PROBE_AFTER_FAILURES) {
      failures = 0;
      void probeSession();
    }
  });
}

/** REST round trip to find out whether the socket failures are a dead
 *  credential (401 → end screen) or just a flaky network (keep retrying). */
async function probeSession(): Promise<void> {
  if (probing || ended) return;
  probing = true;
  try {
    await getContext();
  } catch {
    // A 401 raised kuhn:review-unauthorized; other errors mean the backend is
    // unreachable — y-websocket keeps retrying.
  } finally {
    probing = false;
  }
}

/** The session died under us — ask the lookup endpoint (token, no cookie
 *  needed) which screen tells the truth. */
async function resolveEndScreen(): Promise<void> {
  if (ended) return;
  let kind: RefusalKind = 'ended';
  if (token) {
    try {
      const looked = await lookupLink(token);
      if (looked.state === 'expired' || looked.state === 'revoked') kind = looked.state;
      else if (looked.state === 'claimed') kind = 'claimed';
      else if (looked.state === 'not_found') kind = 'ended';
    } catch {
      // keep the generic screen
    }
  }
  await endWith(kind);
}

async function endWith(kind: RefusalKind): Promise<void> {
  if (ended) return;
  ended = true;
  seq += 1;
  setNotice('');
  showRefusal(kind, { docTitle: ctx?.docTitle });
  await teardown();
}

// ---- Comment affordance for the non-editable comment mode -------------------
// Crepe's selection toolbar only exists on editable surfaces, so comment mode
// gets a floating "Comment" button: DOM selection → ProseMirror positions →
// beginCommentFromSelection (which captures the quote and opens the composer).

function wireFloatingComment(): void {
  const scroll = el('editor-scroll');
  if (!scroll) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rv-float-comment btn btn-accent btn-sm';
  btn.textContent = 'Comment';
  btn.hidden = true;
  scroll.append(btn);

  const hide = (): void => {
    btn.hidden = true;
  };

  const liveView = (): EditorView | null => {
    if (!handle) return null;
    try {
      return handle.view();
    } catch {
      return null; // mid-teardown
    }
  };

  /** DOM selection → PM range, or null when it isn't a usable doc selection. */
  const selectedRange = (view: EditorView): { from: number; to: number; rect: DOMRect } | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!view.dom.contains(range.commonAncestorContainer)) return null;
    let from: number;
    let to: number;
    try {
      from = view.posAtDOM(range.startContainer, range.startOffset);
      to = view.posAtDOM(range.endContainer, range.endOffset);
    } catch {
      return null;
    }
    if (from === to) return null;
    return { from: Math.min(from, to), to: Math.max(from, to), rect: range.getBoundingClientRect() };
  };

  let timer: number | null = null;
  document.addEventListener('selectionchange', () => {
    if (ended || ctx?.mode !== 'comment') return;
    if (timer != null) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const view = liveView();
      const found = view ? selectedRange(view) : null;
      if (!view || !found) {
        hide();
        return;
      }
      const host = scroll.getBoundingClientRect();
      btn.style.top = `${found.rect.bottom - host.top + scroll.scrollTop + 6}px`;
      btn.style.left = `${Math.max(8, Math.min(found.rect.right - host.left, host.width - 96))}px`;
      btn.hidden = false;
    }, 150);
  });

  // mousedown would collapse the selection before click lands — keep it.
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    const view = liveView();
    const found = view ? selectedRange(view) : null;
    hide();
    if (!view || !found) return;
    // Read-only views don't track DOM selections as PM state — install the
    // selection explicitly, then hand off to the shared composer entry point.
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, found.from, found.to)),
    );
    beginCommentFromSelection(view);
  });
}

// ---- Boot -------------------------------------------------------------------

async function enter(context: ReviewContext): Promise<void> {
  ctx = context;
  ended = false;
  // Cosmetic: keep the token out of the visible URL bar once a session cookie
  // carries the credential. A reload of /review re-enters via getContext().
  if (location.pathname !== '/review') history.replaceState(null, '', '/review');
  renderChrome(context);
  hideOverlay();
  await mountCollab();
}

async function boot(): Promise<void> {
  window.addEventListener('kuhn:review-unauthorized', () => {
    if (ctx != null && !ended) void resolveEndScreen();
  });
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault(); // never the browser save dialog, even in view mode
      if (ctx?.mode === 'edit' && !ended) void handle?.flushSave({ checkpoint: true });
    }
  });
  wireFloatingComment();

  const match = location.pathname.match(/^\/review\/([^/]+)\/?$/);
  token = match ? decodeURIComponent(match[1]) : null;

  if (!token) {
    // Reload after replaceState (or a bare /review): an existing review
    // session cookie may still be live — ask the context endpoint.
    try {
      await enter(await getContext());
    } catch {
      showRefusal('not_found');
    }
    return;
  }

  let looked;
  try {
    looked = await lookupLink(token);
  } catch {
    showRefusal('error');
    return;
  }

  switch (looked.state) {
    case 'yours':
      await enter(looked.context);
      return;
    case 'unclaimed':
      showClaimScreen({
        docTitle: looked.docTitle ?? 'Document',
        mode: looked.mode ?? 'view',
        onSubmit: async (name) => {
          const result = await claimLink(token!, name);
          if (result.ok) {
            void enter(result.context);
            return null;
          }
          switch (result.code) {
            case 'link_claimed':
              showRefusal('claimed');
              return null;
            case 'link_expired':
              showRefusal('expired');
              return null;
            case 'link_revoked':
              showRefusal('revoked');
              return null;
            case 'link_not_found':
              showRefusal('not_found');
              return null;
            default:
              return result.error || 'Something went wrong — try again.';
          }
        },
      });
      return;
    case 'claimed':
      showRefusal('claimed', { docTitle: looked.docTitle });
      return;
    case 'expired':
      showRefusal('expired', { docTitle: looked.docTitle });
      return;
    case 'revoked':
      showRefusal('revoked', { docTitle: looked.docTitle });
      return;
    case 'not_found':
    default:
      showRefusal('not_found');
  }
}

void boot();
