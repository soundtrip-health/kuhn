// Editor pane — the MEMBER wrapper over editor-core (epic 013, story 002).
// The collaborative Crepe assembly (Yjs provider, seed grant/fallback, save
// scheduling, close-code routing) lives in editor-core.ts, shared with the
// external-reviewer surface; this module supplies today's member behavior
// verbatim: agent slash commands, pending-suggestion attach, bib refresh,
// margin-comment identity/transport, source (raw markdown) mode, move-follow,
// and the member close-code handling. Member behavior is unchanged by the
// extraction — the token-free check scripts pin that.
//
// Persistence model (story 013): Yjs is the collab/transport layer; the storage
// API is persistence. Saves happen on debounce and on Cmd/Ctrl+S.

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown as cmMarkdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView as CmEditorView, keymap as cmKeymap } from '@codemirror/view';

import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { markdownToSlice } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';

import {
  BACKEND_WS_URL,
  createComment,
  deleteComment,
  getComments,
  readTextFile,
  replyToComment,
  setCommentResolved,
  updateCommentAnchor,
  writeTextFile,
  type Comment,
} from './api';
import { agentIdentity } from './agents';
import { refreshBib } from './bib';
import { installCitationTooltips } from './citation';
import { openCitePicker } from './cite-picker';
import {
  sourceCommentGutter,
  type CommentsIdentity,
  type CommentsTransport,
} from './comments';
import {
  CLOSE_ROOM_MOVED,
  createSaveEngine,
  openDoc,
  type AwarenessUser,
  type DocHandle,
  type DocTransport,
  type ReviewerPresence,
  type SaveEngine,
} from './editor-core';
import { refreshTree } from './files';
import { icon } from './icons';
import { currentUser } from './login';
import { performRetarget, resolveMovedRoom } from './move-follow';
import { notify, setDocument, setSaveState } from './status';
import { attachSuggestions, detachSuggestions } from './suggestion-hunks';
import { toast } from './toast';
import { startWrite } from './write-suggestion';

// On open, reflect the persisted state in the top-bar "Saved" affordance.

let docHandle: DocHandle | null = null;
// Source (raw markdown) mode — story 039. When set, the document is open in a
// CodeMirror view of the stored bytes instead of Crepe; rich collab is torn
// down for the duration (single writer straight to storage). It carries its
// own save engine (same debounce/checkpoint semantics, from editor-core).
let sourceView: CmEditorView | null = null;
let sourceEngine: SaveEngine | null = null;

let currentProjectId = 0;
let currentPath = '';
// Story 012-002: the open document moved and we could not learn where to. The
// tab is parked — no autosave, no write-through — until it is retargeted or
// reloaded, because writing to `currentPath` would resurrect a dead path.
let movedAway = false;
/** Set by main.ts. A 4002 room-moved close is the one retarget signal that
 * survives a dropped SSE feed, but the editor alone cannot complete a retarget:
 * `retargetDocument` owns only editor state, while the file tree's active row
 * (files.ts `activePath`) and the workspace's active document live behind
 * main.ts. Calling back through it keeps the 4002 leg and the SSE leg on the
 * SAME path — both are re-entrancy guarded, so the doubled arrival is a no-op. */
let onRetarget: ((path: string) => void) | null = null;

export function setRetargetHandler(fn: (path: string) => void): void {
  onRetarget = fn;
}
// Writer SDK session for in-editor `/write` follow-ups ("make it shorter").
// In-session only — chat restore (story 020) owns cross-reload continuity.
let writerSession: string | undefined;

export function currentDocumentPath(): string {
  return currentPath;
}

// ---- Member transport & identity (epic 013 §3.2) ---------------------------

const memberCommentsApi: CommentsTransport = {
  getComments,
  createComment,
  replyToComment,
  setCommentResolved,
  updateCommentAnchor,
  deleteComment,
};

const memberTransport: DocTransport = {
  readFile: readTextFile,
  writeFile: writeTextFile,
  commentsApi: memberCommentsApi,
  wsUrl: BACKEND_WS_URL,
};

/** Member rules: mine = my userId (never agent rows), compose always,
 *  resolve ANY thread, delete own plus reviewer-authored threads (guests'
 *  content is deletable by the hosts — matches the server's deleteOwn),
 *  anchor writebacks on. */
function memberCommentsIdentity(): CommentsIdentity {
  const isMine = (c: Comment): boolean => {
    const me = currentUser();
    return me != null && c.userId === me.id && !c.agent;
  };
  return {
    isMine,
    canCompose: true,
    canResolve: () => true,
    canDelete: (t) => isMine(t) || t.reviewLinkId != null,
    canPatchAnchors: true,
  };
}

/** Cursor label for collaborators (cosmetic; epic 013 adds it so members
 *  don't render anonymous next to named reviewers). */
function memberAwarenessUser(): AwarenessUser | null {
  const me = currentUser();
  if (!me) return null;
  return { name: me.display_name || me.email };
}

// ---- External-reviewer presence banner (epic 013 §3.3) ----------------------
// Server-attributed (MSG_REVIEWERS, unforgeable) — awareness names are only
// cosmetic cursor labels. Rendered as a strip between the editor sub-header
// and the document; styled inline so no member stylesheet changes ride along
// with this story (U7 may restyle).

let reviewerBannerEl: HTMLElement | null = null;

function renderReviewerBanner(reviewers: ReviewerPresence[]): void {
  if (reviewers.length === 0) {
    reviewerBannerEl?.remove();
    reviewerBannerEl = null;
    return;
  }
  if (!reviewerBannerEl) {
    const el = document.createElement('div');
    el.id = 'reviewer-banner';
    el.className = 'reviewer-banner';
    el.setAttribute('role', 'status');
    el.style.cssText =
      'padding:6px 16px;font-size:12.5px;line-height:1.4;' +
      'background:var(--reviewer-soft,#F4E0DD);color:var(--reviewer,#B0524E);' +
      'border-bottom:1px solid var(--reviewer,#B0524E);';
    const pane = document.getElementById('editor-pane');
    const scroll = document.getElementById('editor-scroll');
    if (pane && scroll) pane.insertBefore(el, scroll);
    else return; // no editor pane — nothing to announce into
    reviewerBannerEl = el;
  }
  const label = reviewers.map((r) => `${r.name} (${r.mode})`).join(', ');
  reviewerBannerEl.textContent =
    reviewers.length === 1
      ? `External reviewer ${label} is on this document`
      : `External reviewers on this document: ${label}`;
}

// ---- Buffer state -----------------------------------------------------------

/** The live buffer in whichever mode is open, or null if no document is. */
function currentMarkdown(): string | null {
  return sourceView
    ? sourceView.state.doc.toString()
    : docHandle
      ? docHandle.getMarkdown()
      : null;
}

/** Local edits not yet persisted to storage? (Either mode; story 041.) */
export function hasUnsavedChanges(): boolean {
  if (sourceView) return sourceEngine?.isDirty(sourceView.state.doc.toString()) ?? false;
  return docHandle?.isDirty() ?? false;
}

/**
 * Live-update the open editor when an agent changes the file underneath it
 * (story 013 carry-over). If the editor is clean, the new content is loaded in
 * one transaction (the collab plugin propagates it, the existing save path is a
 * no-op since it matches storage). If there are unsaved local edits, we refuse
 * to clobber them and return false so the caller keeps the reload prompt.
 */
export async function applyExternalChange(path: string): Promise<boolean> {
  if (path !== currentPath) return false;
  if (sourceView) {
    // Source mode mirrors storage directly: clean view → swap in the new text.
    const current = sourceView.state.doc.toString();
    if (!sourceEngine || sourceEngine.isDirty(current)) return false;
    const stored = await readTextFile(currentProjectId, path);
    if (stored == null || stored === current) return true;
    sourceEngine.noteSaved(stored);
    sourceView.dispatch({ changes: { from: 0, to: sourceView.state.doc.length, insert: stored } });
    setSaveState('saved');
    return true;
  }
  if (!docHandle) return false;
  if (docHandle.isDirty()) return false;

  const stored = await readTextFile(currentProjectId, path);
  if (stored == null || stored === docHandle.lastSaved()) return true; // nothing new to apply
  // Preset lastSaved so the markdownUpdated listener's save guard short-circuits
  // (we're mirroring storage, not making a new local edit).
  docHandle.noteSaved(stored);
  docHandle.replaceContent(stored);
  setSaveState('saved');
  return true;
}

// Slash-command registry (story 016, expanded for stories 017/025). These fold
// into Crepe's block-edit menu as one "AI commands" group (story 003) — typing
// `/` at the start of a block opens the unified menu; the block types come from
// Crepe, the agent commands from here. /cite is fully wired (PubMed search →
// chip) and /write streams a suggestion; the rest route to the owning agent (a
// stub toast for now — real dispatch lands with later stories).
interface AgentCommand {
  /** Filterable label shown in the menu, e.g. 'Cite'. */
  label: string;
  /** Owning agent slug — drives the routed-toast label. */
  agent: string;
  /** One-line description (currently menu-internal; kept for parity). */
  description: string;
  /** Invoked after the typed `/...` run has been removed from the document. */
  run: (view: EditorView) => void;
}

function agentCommands(): AgentCommand[] {
  const routed = (label: string, agent: string, description: string): AgentCommand => ({
    label,
    agent,
    description,
    run: () => toast(`Routed to ${agentIdentity(agent).label}`),
  });

  return [
    {
      label: 'Cite',
      agent: 'ra',
      description: 'Search PubMed & insert a citation',
      run: (view) => {
        const coords = view.coordsAtPos(view.state.selection.from);
        openCitePicker({
          projectId: currentProjectId,
          anchor: { x: coords.left, y: coords.bottom },
          onPick: (key, bibPath) => {
            insertCitation(view, key);
            // The backend already wrote the bibliography and told us where
            // (story 012-001: it need not be draft/references.bib) — reload
            // exactly that file rather than re-resolving from a stale tree.
            void refreshBib(currentProjectId, bibPath);
            void refreshTree(currentProjectId);
            toast(`Citation inserted · ${bibPath} updated`);
          },
          onClose: () => view.focus(),
        });
      },
    },
    {
      label: 'Write',
      agent: 'writer',
      description: 'Writer drafts text right here',
      run: (view) =>
        startWrite(view, {
          projectId: currentProjectId,
          path: currentPath,
          // Parse the accepted markdown with the live parser (decision 2).
          toSlice: (markdown) => docHandle!.crepe.editor.action(markdownToSlice(markdown)),
          getSession: () => writerSession,
          setSession: (id) => {
            writerSession = id;
          },
        }),
    },
    routed('Research', 'ra', 'Ask Research a question'),
    routed('Figure', 'analyst', 'Analyst makes a figure or table'),
    routed('Review', 'reviewer', 'Reviewer critiques this section'),
    routed('Ask', 'pm', 'Ask any agent inline'),
    routed('Status', 'pm', 'What is the team doing?'),
  ];
}

/**
 * The `/filter` run immediately before the caret, if any. Crepe's block-edit
 * menu leaves the typed `/...` text in the document and delegates removal to the
 * selected item's handler; agent commands remove just that run (not the whole
 * block) before acting.
 */
function matchSlashRun(view: EditorView): { from: number; to: number } | null {
  const { $from, empty } = view.state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const match = textBefore.match(/(?:^|\s)\/([a-zA-Z]*)$/);
  if (!match) return null;
  return { from: $from.pos - match[1].length - 1, to: $from.pos };
}

/** Remove the typed `/...` run, then run an agent command at the caret. */
function runAgentCommand(ctx: Ctx, command: AgentCommand): void {
  const view = ctx.get(editorViewCtx);
  const run = matchSlashRun(view);
  if (run) view.dispatch(view.state.tr.delete(run.from, run.to));
  command.run(view);
}

/** Update the sub-header word count and toggle the empty-state hero. */
function updateDocMeta(markdown: string): void {
  const words = (markdown.trim().match(/\S+/g) ?? []).length;
  const wc = document.getElementById('editor-wordcount');
  if (wc) wc.textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}`;
  // The seeding hero belongs to the rich draft view — never over raw text.
  const hero = document.getElementById('editor-hero');
  if (hero) hero.hidden = sourceView != null || markdown.trim().length > 0;
}

/** Insert a citation chip atom at the current selection. */
function insertCitation(view: EditorView, key: string): void {
  const node = view.state.schema.nodes.citation.create({ key });
  view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
}

let tooltipsInstalled = false;

// Re-entrancy guard (story 012-002). A move retargets the open document at the
// same moment the mover's own tab reopens it, so openDocument can legitimately
// be called twice for the same path within one tick. Without this, both calls
// mount a Crepe view and assign the module singletons: the first handle is
// orphaned but stays connected to the new room, and two editors autosave the
// same path with divergent content. A call for the path already being opened
// is a no-op; a superseded call bails before it touches the singletons.
let openSeq = 0;
let openingPath: string | null = null;

export async function openDocument(
  projectId: number,
  path: string,
  // `preferStored` forces the stored bytes over whatever the room replays
  // (story 039); `restore` does the same with an explicit buffer carried in
  // from a moved document (story 012-002) and persists it to the new path.
  opts: { preferStored?: boolean; restore?: string } = {},
): Promise<void> {
  if (openingPath === path && currentProjectId === projectId) return;
  const seq = ++openSeq;
  openingPath = path;
  try {
    await openDocumentInner(projectId, path, seq, opts);
  } finally {
    if (seq === openSeq) openingPath = null;
  }
}

async function openDocumentInner(
  projectId: number,
  path: string,
  seq: number,
  opts: { preferStored?: boolean; restore?: string },
): Promise<void> {
  await closeDocument();
  if (seq !== openSeq) return; // a newer open superseded this one
  currentProjectId = projectId;
  currentPath = path;
  movedAway = false;
  writerSession = undefined; // a new document starts a fresh writer thread
  setDocument(path);
  const pathEl = document.getElementById('editor-path');
  if (pathEl) pathEl.textContent = path.replace(/\//g, ' / ');
  void refreshBib(projectId);
  if (!tooltipsInstalled) {
    installCitationTooltips(document.getElementById('editor')!);
    tooltipsInstalled = true;
  }
  wireModeToggle();

  // Non-markdown text files (issue #44: .bib, .json, .txt, …) open as raw
  // text — a plain CodeMirror view straight on storage, no rich mode to
  // toggle to and no Yjs room (single writer, like source mode).
  if (!path.endsWith('.md')) {
    const stored = (await readTextFile(projectId, path)) ?? '';
    if (seq !== openSeq) return; // switched away
    createSourceView(stored, [], { markdown: false });
    setModeToggle(null);
    updateDocMeta(stored);
    setSaveState('saved');
    // Unsaved bytes carried in from the old path (story 012-002) — raw-text
    // files have no room to seed, so apply and persist them here.
    if (opts.restore != null && opts.restore !== stored) {
      sourceView!.dispatch({
        changes: { from: 0, to: sourceView!.state.doc.length, insert: opts.restore },
      });
      void flushSave();
    }
    return;
  }
  setModeToggle('rich');

  const stored = await readTextFile(projectId, path);
  if (seq !== openSeq) return; // switched away before we touched the singletons

  const commands = agentCommands();
  const handle = await openDoc({
    projectId,
    path,
    editable: true,
    features: { slashCommands: true, suggestions: true, bib: true, comments: true },
    transport: memberTransport,
    awarenessUser: memberAwarenessUser(),
    commentsIdentity: memberCommentsIdentity(),
    stored,
    override: { restore: opts.restore, preferStored: opts.preferStored },
    buildBlockEditMenu: (builder) => {
      const group = builder.addGroup('kuhn-agents', 'AI commands');
      for (const command of commands) {
        group.addItem(command.label.toLowerCase(), {
          label: command.label,
          icon: icon('sparkle'),
          onRun: (ctx) => runAgentCommand(ctx, command),
        });
      }
    },
    onMarkdownUpdated: updateDocMeta,
    onSaveState: setSaveState,
    beforeSave: () => !movedAway,
    // Close 4001 = the server evicted this room (file deleted/replaced,
    // story 038) — the project feed delivers the news to the UI (story 041);
    // 4002 = its document moved (story 012-002) — the close reason carries
    // the new path, the only retarget signal that survives a dropped SSE feed.
    onClose: (code, reason) => {
      if (code === CLOSE_ROOM_MOVED) void followMovedRoom(reason);
    },
    onReviewers: renderReviewerBanner,
    // Pending agent suggestions for this doc (story 008-001): the module
    // fetches GET /pending-edits itself and renders hunk decorations;
    // accept/reject go through REST after flushing any local save. (Margin
    // comments attach inside editor-core, right after this.)
    onReady: (view) => {
      attachSuggestions(view, {
        projectId,
        path,
        flush: () => flushSave(),
      });
    },
  });
  // The open ran to completion but a newer openDocument superseded it while
  // Crepe was mounting — this handle must not become the module singleton.
  // destroy() detaches only ITS OWN comments attach (view-scoped), so a
  // newer document's panel survives.
  if (seq !== openSeq) {
    void handle.destroy();
    return;
  }
  docHandle = handle;
}

export async function closeDocument(): Promise<void> {
  if (docHandle?.pendingSave() || sourceEngine?.pending()) await flushSave();
  await teardownRich();
  destroySourceView();
  setModeToggle(null);
}

/** Tear down Crepe + collab (used by close and by entering source mode). */
async function teardownRich(): Promise<void> {
  detachSuggestions();
  renderReviewerBanner([]);
  const handle = docHandle;
  docHandle = null;
  // Comments detach + collab disconnect + provider/ydoc/crepe teardown all
  // live in the handle (editor-core), in the story-024-safe order.
  if (handle) await handle.destroy();
}

function destroySourceView(): void {
  sourceEngine?.cancel();
  sourceEngine = null;
  sourceView?.destroy();
  sourceView = null;
  document.getElementById('editor')?.classList.remove('editor-source');
}

// ---- Source (raw markdown) mode — story 039 ---------------------------------

/** Swap the rich editor for a CodeMirror view of the bytes in storage. */
async function enterSourceMode(): Promise<void> {
  if (!docHandle || sourceView) return;
  await flushSave();
  const projectId = currentProjectId;
  const path = currentPath;
  // Show the stored bytes, not the rich serialization — source mode exists to
  // reach syntax the WYSIWYG view hides or normalizes (broken links, raw HTML).
  const stored = (await readTextFile(projectId, path)) ?? docHandle.lastSaved();
  if (projectId !== currentProjectId || path !== currentPath || !docHandle) return; // switched away
  await teardownRich();
  // Gutter markers for commented lines (story 008-004, source-mode v1).
  const commentGutter = await sourceCommentGutter(projectId, path, stored, memberCommentsApi);
  if (projectId !== currentProjectId || path !== currentPath || sourceView) return;
  createSourceView(stored, [commentGutter], { markdown: true });
  updateDocMeta(stored);
  setSaveState('saved');
  setModeToggle('source');
  sourceView!.focus();
}

/** Build the raw-text CodeMirror view (source mode, and non-md files). */
function createSourceView(
  doc: string,
  extra: Extension[],
  opts: { markdown: boolean },
): void {
  const root = document.getElementById('editor')!;
  root.classList.add('editor-source');
  // Same debounce + PUT semantics as the rich editor, straight to storage
  // (single writer — no Yjs room in these modes).
  const engine = createSaveEngine({
    write: (content, o) => writeTextFile(currentProjectId, currentPath, content, o),
    onState: setSaveState,
    beforeSave: () => !movedAway,
  });
  engine.noteSaved(doc);
  sourceEngine = engine;
  sourceView = new CmEditorView({
    parent: root,
    state: EditorState.create({
      doc,
      extensions: [
        ...extra,
        history(),
        cmKeymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        ...(opts.markdown ? [cmMarkdown()] : []),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        CmEditorView.lineWrapping,
        CmEditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          updateDocMeta(text);
          engine.schedule(text);
        }),
      ],
    }),
  });
}

/** Persist the raw text, then reopen the rich editor on the stored bytes. */
async function exitSourceMode(): Promise<void> {
  if (!sourceView) return;
  await flushSave();
  const projectId = currentProjectId;
  const path = currentPath;
  destroySourceView();
  await openDocument(projectId, path, { preferStored: true });
}

let modeToggleWired = false;

function wireModeToggle(): void {
  if (modeToggleWired) return;
  modeToggleWired = true;
  document.getElementById('editor-mode-toggle')?.addEventListener('click', () => {
    void (sourceView ? exitSourceMode() : enterSourceMode());
  });
}

/** Reflect the mode on the toggle button; null hides it (no document open). */
function setModeToggle(mode: 'rich' | 'source' | null): void {
  const btn = document.getElementById('editor-mode-toggle') as HTMLButtonElement | null;
  if (!btn) return;
  if (mode == null) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.setAttribute('aria-pressed', String(mode === 'source'));
  btn.classList.toggle('is-active', mode === 'source');
  btn.textContent = mode === 'source' ? 'Rich text' : 'Source';
  btn.title = mode === 'source'
    ? 'Back to the rich-text editor'
    : 'Edit the raw markdown source';
}

/** Cancel a pending debounced save without writing (the file is about to be
 * deleted — flushing would resurrect it). */
export function cancelPendingSave(): void {
  sourceEngine?.cancel();
  docHandle?.cancelPendingSave();
}

// ---- Moved documents — story 012-002 ---------------------------------------

/**
 * Resolve a 4002 (room moved) close into a retarget or a parked tab — the
 * decision rules and their rationale are in move-follow.ts resolveMovedRoom.
 * Returning to rich mode is deliberate: a moved document reopens through
 * openDocument, which owns the mode.
 */
async function followMovedRoom(reason: string): Promise<void> {
  // The decision logic (and its rationale) lives in move-follow.ts, where it
  // is unit-tested (story 012-004); this is the host adapter over editor state.
  await resolveMovedRoom({
    projectId: () => currentProjectId,
    currentPath: () => currentPath,
    readTextFile,
    // Dirtiness is content-based, so cancelling the debounce here does not
    // hide the buffer from retargetDocument.
    cancelPendingSave,
    strand: strandMovedDocument,
    // Through main.ts, not straight to retargetDocument: the tree's active row
    // and the workspace's active document would otherwise stay on the dead path.
    retarget: (next) => (onRetarget ? onRetarget(next) : retargetDocument(next)),
  }, reason);
}

/**
 * Follow the open document to `path` after it moved out from under us. The
 * two load-bearing rules (retarget FIRST so a racing autosave lands on the
 * new path; full reopen so the new room gets a FRESH Y.Doc and provider) are
 * specified and tested in move-follow.ts performRetarget — this adapter
 * supplies the editor state. One host-specific note: editor-core's openDoc is
 * the only site that builds a provider, and mutating provider.roomname instead
 * would leave the BroadcastChannel pinned to the dead room (frozen at
 * construction).
 */
export async function retargetDocument(path: string): Promise<void> {
  if (!currentPath || path === currentPath) return;
  const projectId = currentProjectId;
  await performRetarget({
    setCurrentPath: (p) => {
      currentPath = p;
      // The rich handle captures its save path internally — retarget it too,
      // so a racing autosave lands on the new path (rule 1).
      docHandle?.setPath(p);
    },
    announce: (p) => {
      setDocument(p);
      const pathEl = document.getElementById('editor-path');
      if (pathEl) pathEl.textContent = p.replace(/\//g, ' / ');
    },
    pendingMarkdown: () => (hasUnsavedChanges() ? currentMarkdown() : null),
    cancelPendingSave,
    clearMovedAway: () => { movedAway = false; }, // we know where the document went
    flushSave: () => flushSave(),
    reopen: (p, restore) =>
      openDocument(projectId, p, restore == null ? {} : { restore }),
  }, path);
}

/**
 * The document moved and we could not learn where to (the server had to blank
 * an over-long close reason, and the project feed has not delivered the move).
 * Guessing is worse than stopping: park the tab in an explicit moved state
 * with autosave cancelled and writes refused, so it cannot resurrect the old
 * path. A later feed event retargets us; a reload always recovers.
 */
function strandMovedDocument(): void {
  if (movedAway) return;
  movedAway = true;
  cancelPendingSave();
  setSaveState('error', 'this document moved — reload to continue');
  notify(`${currentPath} moved — reload to continue editing`);
  toast('This document moved — reload to continue editing');
}

/** Tear down the open document without persisting it (e.g. it was just deleted
 * out from under the editor). Leaves no current path. */
export async function discardDocument(): Promise<void> {
  cancelPendingSave();
  movedAway = false;
  await closeDocument(); // no save is pending now, so this won't write back
  currentPath = '';
  setDocument('');
}

/**
 * Explicit save — serializes the current doc and writes through. `checkpoint`
 * (Cmd/Ctrl+S) additionally commits a history version now (story 008-002).
 */
export async function flushSave(opts: { checkpoint?: boolean } = {}): Promise<void> {
  if (sourceView) {
    await sourceEngine?.flush(sourceView.state.doc.toString(), opts);
    return;
  }
  await docHandle?.flushSave(opts);
}
