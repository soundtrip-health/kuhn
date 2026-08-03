// Editor pane: a Milkdown Crepe build (story 001) — a Notion-style WYSIWYG
// markdown editor (toolbar, block-edit slash menu, block handle, image block,
// table, CodeMirror code blocks, link tooltip, list items, placeholder, LaTeX,
// cursor) themed to the "Column" design. Collaboration (Yjs) and the custom
// agent/citation surface are layered onto Crepe's underlying editor (stories
// 002/003): citation chips, `/cite`, and `/write` re-attach as plugins, and the
// agent-routed slash commands fold into Crepe's block-edit menu as one group.
//
// Persistence model (story 013): Yjs is the collab/transport layer; the storage
// API is persistence. Saves happen on debounce and on Cmd/Ctrl+S.

import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { latex } from '@milkdown/crepe/feature/latex';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { toolbar } from '@milkdown/crepe/feature/toolbar';

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown as cmMarkdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView as CmEditorView, keymap as cmKeymap } from '@codemirror/view';

import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { getMarkdown, markdownToSlice, replaceAll } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import * as decoding from 'lib0/decoding';
import { Doc as YDoc } from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import '@milkdown/crepe/theme/common/style.css';
import 'katex/dist/katex.min.css';

import { BACKEND_WS_URL, readTextFile, writeTextFile } from './api';
import { agentIdentity } from './agents';
import { refreshBib } from './bib';
import { citationPlugins, installCitationTooltips } from './citation';
import { openCitePicker } from './cite-picker';
import {
  attachComments,
  beginCommentFromSelection,
  commentsPlugin,
  detachComments,
  sourceCommentGutter,
} from './comments';
import { refreshTree } from './files';
import { icon } from './icons';
import { notify, setDocument, setSaveState } from './status';
import { attachSuggestions, detachSuggestions, suggestionHunksPlugin } from './suggestion-hunks';
import { toast } from './toast';
import { startWrite, writeSuggestionPlugin } from './write-suggestion';

// On open, reflect the persisted state in the top-bar "Saved" affordance.

const SAVE_DEBOUNCE_MS = 1500;

// Story 041 collab-lifecycle constants, mirroring the backend:
// custom y-websocket message naming this connection the room's template
// seeder (yjs-websocket.js MSG_SEED_GRANT), and the eviction close code.
const MSG_SEED_GRANT = 64;
const CLOSE_ROOM_EVICTED = 4001;
// Story 012-002: the room's document was MOVED. The close reason carries the
// new path, and is blank when that would exceed the 123-UTF-8-byte close-frame
// cap — then we must not guess (see strandMovedDocument). It is a hint, not
// gospel: followMovedRoom reads the target back before following it, so a
// reason that isn't this room's own document (a folder move currently sends
// the FOLDER's new path to every descendant room) parks the tab rather than
// retargeting it onto the wrong path.
const CLOSE_ROOM_MOVED = 4002;
// If the granted seeder dies before seeding, seed ourselves once the room
// has stayed empty this long (re-checked at apply time).
const SEED_FALLBACK_MS = 3000;

const DEFAULT_TEMPLATE = `# Untitled draft

Start writing, or ask an agent in the chat panel.
`;

let crepe: CrepeBuilder | null = null;
let provider: WebsocketProvider | null = null;
let ydoc: YDoc | null = null;
// Source (raw markdown) mode — story 039. When set, the document is open in a
// CodeMirror view of the stored bytes instead of Crepe; rich collab is torn
// down for the duration (single writer straight to storage).
let sourceView: CmEditorView | null = null;

let currentProjectId = 0;
let currentPath = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedMarkdown = '';
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

/** The live buffer in whichever mode is open, or null if no document is. */
function currentMarkdown(): string | null {
  return sourceView
    ? sourceView.state.doc.toString()
    : crepe
      ? crepe.editor.action(getMarkdown())
      : null;
}

/** Local edits not yet persisted to storage? (Either mode; story 041.) */
export function hasUnsavedChanges(): boolean {
  if (saveTimer != null) return true;
  const current = currentMarkdown();
  return current != null && current !== lastSavedMarkdown;
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
    if (saveTimer != null || current !== lastSavedMarkdown) return false;
    const stored = await readTextFile(currentProjectId, path);
    if (stored == null || stored === current) return true;
    lastSavedMarkdown = stored;
    sourceView.dispatch({ changes: { from: 0, to: sourceView.state.doc.length, insert: stored } });
    setSaveState('saved');
    return true;
  }
  if (!crepe) return false;
  const current = crepe.editor.action(getMarkdown());
  const dirty = saveTimer != null || current !== lastSavedMarkdown;
  if (dirty) return false;

  const stored = await readTextFile(currentProjectId, path);
  if (stored == null || stored === lastSavedMarkdown) return true; // nothing new to apply
  // Preset lastSaved so the markdownUpdated listener's save guard short-circuits
  // (we're mirroring storage, not making a new local edit).
  lastSavedMarkdown = stored;
  crepe.editor.action(replaceAll(stored));
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
          toSlice: (markdown) => crepe!.editor.action(markdownToSlice(markdown)),
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
// mount a Crepe view and assign the module singletons: the first provider is
// orphaned but stays connected to the new room, and two editors autosave the
// same path with divergent content. A call for the path already being opened
// is a no-op; a superseded call bails before it touches crepe/provider/ydoc.
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
    lastSavedMarkdown = stored;
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
  const template = stored ?? DEFAULT_TEMPLATE;
  lastSavedMarkdown = stored ?? '';

  const commands = agentCommands();
  crepe = new CrepeBuilder({ root: '#editor' });
  crepe
    // The selection toolbar carries the margin-comment entry point (story
    // 008-004): comment-on-selection lives beside bold/italic, where Docs
    // users expect it.
    .addFeature(toolbar, {
      buildToolbar: (builder) => {
        builder
          .addGroup('kuhn-comment', 'Comment')
          .addItem('comment', {
            active: () => false,
            icon: icon('comment'),
            onRun: (ctx) => beginCommentFromSelection(ctx.get(editorViewCtx)),
          });
      },
    })
    .addFeature(blockEdit, {
      buildMenu: (builder) => {
        const group = builder.addGroup('kuhn-agents', 'AI commands');
        for (const command of commands) {
          group.addItem(command.label.toLowerCase(), {
            label: command.label,
            icon: icon('sparkle'),
            onRun: (ctx) => runAgentCommand(ctx, command),
          });
        }
      },
    })
    .addFeature(imageBlock)
    .addFeature(table)
    .addFeature(codeMirror)
    .addFeature(listItem)
    .addFeature(linkTooltip)
    .addFeature(placeholder, { text: 'Type "/" for commands', mode: 'block' })
    .addFeature(latex)
    .addFeature(cursor)
    // Custom Kuhn surface (story 003): citation chips, the `/write` suggestion
    // decoration, and the Yjs collab plugin all attach to the underlying editor.
    .addFeature((editor: Editor) => {
      editor.use(citationPlugins).use(writeSuggestionPlugin).use(suggestionHunksPlugin).use(commentsPlugin).use(collab);
    });

  crepe.on((api) => {
    api.markdownUpdated((_ctx, markdown, prev) => {
      updateDocMeta(markdown);
      if (prev != null && markdown !== prev) scheduleSave(markdown);
    });
  });

  await crepe.create();

  updateDocMeta(template);
  setSaveState('saved');

  crepe.editor.action((ctx) => {
    const collabService = ctx.get(collabServiceCtx);
    ydoc = new YDoc();
    provider = new WebsocketProvider(`${BACKEND_WS_URL}/yjs-websocket`, roomName(projectId, path), ydoc);
    collabService.bindDoc(ydoc).setAwareness(provider.awareness);
    const boundProvider = provider;
    const boundYdoc = ydoc;
    // The server names exactly one connection per empty room as its seeder
    // (story 041) — deciding client-side let two simultaneous openers both
    // observe an empty room and both apply the template.
    let seedGranted = false;
    boundProvider.messageHandlers[MSG_SEED_GRANT] = (_encoder, decoder) => {
      seedGranted = decoding.readVarUint(decoder) === 1;
    };
    // Close 4001 = the server evicted this room (file deleted/replaced,
    // story 038); 4002 = its document moved (story 012-002). Either way,
    // auto-reconnecting would repopulate the fresh room from this client's
    // local state — stop for good. On a delete the project feed delivers the
    // news to the UI (story 041); on a move the close reason carries the new
    // path, which is the only retarget signal that survives a dropped SSE
    // feed. y-websocket re-enters this handler with a null event when
    // disconnect() closes the socket, so everything below must be idempotent.
    boundProvider.on('connection-close', (event: CloseEvent | null) => {
      if (event?.code !== CLOSE_ROOM_EVICTED && event?.code !== CLOSE_ROOM_MOVED) return;
      boundProvider.disconnect();
      if (event.code !== CLOSE_ROOM_MOVED) return;
      if (provider !== boundProvider) return; // a newer document already took over
      void followMovedRoom(event.reason ?? '');
    });
    provider.once('sync', (isSynced: boolean) => {
      // Bail if the document was switched before sync arrived (story 024).
      if (!isSynced || provider !== boundProvider) return;
      if (seedGranted) {
        // Sole seeder: apply the storage template (its own empty-room
        // condition still re-checks at apply time).
        collabService.applyTemplate(template).connect();
      } else {
        collabService.connect();
        // Seeder-death fallback: if nobody has seeded the room after a
        // grace period, do it ourselves.
        setTimeout(() => {
          if (provider !== boundProvider || !crepe) return;
          if (boundYdoc.getXmlFragment('prosemirror').length > 0) return;
          collabService.disconnect();
          collabService.applyTemplate(template).connect();
        }, SEED_FALLBACK_MS);
      }
      // Force local text over whatever the room replayed (it propagates to
      // peers via collab). Two callers: returning from source mode (story
      // 039 — edits went straight to storage, which any still-warm room
      // predates), and a move retarget (story 012-002 — the unsaved buffer
      // rides into the new room, then persists to the new path).
      const override = opts.restore ?? (opts.preferStored ? template : null);
      if (override == null) return;
      setTimeout(() => {
        if (provider !== boundProvider || !crepe) return;
        const same = crepe.editor.action(getMarkdown()) === override;
        if (!same) {
          lastSavedMarkdown = template;
          crepe.editor.action(replaceAll(override));
        }
        if (opts.restore != null) void flushSave();
        else if (!same) setSaveState('saved');
      }, 0);
    });
  });

  // Pending agent suggestions for this doc (story 008-001): the module fetches
  // GET /pending-edits itself and renders hunk decorations; accept/reject go
  // through REST after flushing any local save.
  crepe.editor.action((ctx) => {
    attachSuggestions(ctx.get(editorViewCtx), {
      projectId,
      path,
      flush: () => flushSave(),
    });
    // Margin comments for this doc (story 008-004): fetched by the module,
    // anchored by quote, tracked live via decoration mapping.
    attachComments(ctx.get(editorViewCtx), { projectId, path });
  });
}

export async function closeDocument(): Promise<void> {
  if (saveTimer) await flushSave();
  await teardownRich();
  destroySourceView();
  setModeToggle(null);
}

/** Tear down Crepe + collab (used by close and by entering source mode). */
async function teardownRich(): Promise<void> {
  detachSuggestions();
  detachComments();
  // Detach the collab plugins before any teardown: late provider/awareness
  // events otherwise dispatch into the view after editor.destroy() has
  // removed the editorState ctx slice (story 024).
  crepe?.editor.action((ctx) => ctx.get(collabServiceCtx).disconnect());
  provider?.destroy();
  provider = null;
  ydoc?.destroy();
  ydoc = null;
  if (crepe) await crepe.destroy();
  crepe = null;
}

function destroySourceView(): void {
  sourceView?.destroy();
  sourceView = null;
  document.getElementById('editor')?.classList.remove('editor-source');
}

// ---- Source (raw markdown) mode — story 039 ---------------------------------

/** Swap the rich editor for a CodeMirror view of the bytes in storage. */
async function enterSourceMode(): Promise<void> {
  if (!crepe || sourceView) return;
  await flushSave();
  const projectId = currentProjectId;
  const path = currentPath;
  // Show the stored bytes, not the rich serialization — source mode exists to
  // reach syntax the WYSIWYG view hides or normalizes (broken links, raw HTML).
  const stored = (await readTextFile(projectId, path)) ?? lastSavedMarkdown;
  if (projectId !== currentProjectId || path !== currentPath || !crepe) return; // switched away
  await teardownRich();
  lastSavedMarkdown = stored;
  // Gutter markers for commented lines (story 008-004, source-mode v1).
  const commentGutter = await sourceCommentGutter(projectId, path, stored);
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
          scheduleSave(text); // same debounce + PUT as the rich editor
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

function roomName(projectId: number, path: string): string {
  return `project-${projectId}/${path}`;
}

function scheduleSave(markdown: string): void {
  if (markdown === lastSavedMarkdown || movedAway) return;
  setSaveState('dirty');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void doSave(markdown), SAVE_DEBOUNCE_MS);
}

/** Cancel a pending debounced save without writing (the file is about to be
 * deleted — flushing would resurrect it). */
export function cancelPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// ---- Moved documents — story 012-002 ---------------------------------------

/**
 * Resolve a 4002 (room moved) close into a retarget. The close reason is the
 * only retarget signal that survives a dropped project feed, so we act on it —
 * but never blindly: a target we cannot read back (a folder's path, a stale or
 * blanked reason) would otherwise be conjured into existence by the next save,
 * so it parks the tab instead. Returning to rich mode is deliberate: a moved
 * document reopens through openDocument, which owns the mode.
 */
async function followMovedRoom(reason: string): Promise<void> {
  const projectId = currentProjectId;
  const from = currentPath;
  // Stop the debounce now — until the new path is known, a save could only
  // land on the path that just went away. Dirtiness is also content-based, so
  // cancelling here does not hide the buffer from retargetDocument.
  cancelPendingSave();
  const next = reason.trim();
  if (!next || next === from) {
    strandMovedDocument();
    return;
  }
  let exists = false;
  try {
    exists = (await readTextFile(projectId, next)) != null;
  } catch {
    exists = false;
  }
  if (currentProjectId !== projectId || currentPath !== from) return; // the feed got there first
  if (!exists) {
    strandMovedDocument();
    return;
  }
  // Through main.ts, not straight to retargetDocument: the tree's active row
  // and the workspace's active document would otherwise stay on the dead path.
  if (onRetarget) onRetarget(next);
  else await retargetDocument(next); // no host wired (tests) — editor-only
}

/**
 * Follow the open document to `path` after it moved out from under us. Two
 * rules, both load-bearing:
 *
 * 1. Retarget FIRST, decide clean/dirty SECOND. The autosave debounce can fire
 *    between the fs rename and this signal arriving, so `currentPath` moves
 *    before anything else is evaluated — an in-flight save then lands on the
 *    new path instead of resurrecting the old one.
 * 2. Never leave the tab offline. The 4002 handler disconnected the provider
 *    for good and `openDocument` is the only site that builds one, so anything
 *    short of a full reopen leaves a second, room-less writer autosaving the
 *    same path against its collaborators. The reopen is also what gives us a
 *    FRESH Y.Doc for the new room: mutating provider.roomname would leave the
 *    BroadcastChannel pinned to the dead room (it is frozen at construction)
 *    and carry the stale lineage across — the 2× duplicate-doc merge hazard.
 *
 * Unsaved edits ride across twice over: written to the new path up front (the
 * reopen below is a no-op if another retarget for the same path is already in
 * flight) and re-applied over the room's replay once it syncs.
 */
export async function retargetDocument(path: string): Promise<void> {
  if (!currentPath || path === currentPath) return;
  const projectId = currentProjectId;
  currentPath = path; // rule 1 — before anything reads it
  setDocument(path);
  const pathEl = document.getElementById('editor-path');
  if (pathEl) pathEl.textContent = path.replace(/\//g, ' / ');
  const pending = hasUnsavedChanges() ? currentMarkdown() : null;
  cancelPendingSave();
  movedAway = false; // we know where the document went
  if (pending != null) await flushSave();
  await openDocument(projectId, path, pending == null ? {} : { restore: pending });
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
  await closeDocument(); // saveTimer is null now, so this won't write back
  currentPath = '';
  setDocument('');
}

/**
 * Explicit save — serializes the current doc and writes through. `checkpoint`
 * (Cmd/Ctrl+S) additionally commits a history version now (story 008-002).
 */
export async function flushSave(opts: { checkpoint?: boolean } = {}): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const markdown = currentMarkdown();
  if (markdown == null) return;
  await doSave(markdown, opts.checkpoint ?? false);
}

async function doSave(markdown: string, checkpoint = false): Promise<void> {
  saveTimer = null;
  // The document moved and we don't know where (story 012-002): writing to
  // currentPath would mkdir-p the dead path back into existence.
  if (movedAway) return;
  // A checkpoint (explicit Cmd/Ctrl+S) writes through even when the content
  // is already saved: the debounced autosave may have stored the bytes, but
  // the history version is cut by the checkpointed request (story 008-002).
  if (markdown === lastSavedMarkdown && !checkpoint) {
    setSaveState('saved');
    return;
  }
  setSaveState('saving');
  try {
    await writeTextFile(currentProjectId, currentPath, markdown, { checkpoint });
    lastSavedMarkdown = markdown;
    setSaveState('saved');
  } catch (err) {
    setSaveState('error', (err as Error).message);
  }
}
