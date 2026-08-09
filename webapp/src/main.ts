// Kuhn webapp entry point (story 013; restyled for story 025; org/project
// browser wired in stories 005–007). Bootstraps the workspace (org → project →
// document) from the backend, wires the three panes — agent chat, Milkdown
// editor, file tree — the top bar, breadcrumb, and status bar, and reacts to
// workspace changes by switching the open project/document in place (no reload).

import './kuhn-tokens.css';
import './style.css';

import { initAgentSelector } from './agent-selector';
import { subscribeProjectEvents, writeTextFile } from './api';
import { initBreadcrumb } from './breadcrumb';
import { currentBibPath, refreshBib } from './bib';
import { initChat, setSetupHandler } from './chat';
import {
  applyExternalChange,
  closeDocument,
  currentDocumentPath,
  discardDocument,
  flushSave,
  hasUnsavedChanges,
  openDocument,
  retargetDocument,
  setRetargetHandler,
} from './editor';
import {
  initFiles,
  markSeen,
  recordFileChange,
  refreshTree,
  refreshTreeSoon,
  setActiveFile,
  type FileChange,
} from './files';
import { movedDocAction } from './move-follow';
import { findMarkdownPath, isUnder, movedPath } from './tree-state';
import { refreshCommentsSoon } from './comments';
import { initHistoryButton } from './history-panel';
import { icon } from './icons';
import { initAuth } from './login';
import { initPreview, previewStoredFile } from './preview';
import { openProjectBrowser } from './project-browser';
import { initShareLinks, refreshShareLinks } from './share-links';
import { notify, setVersion } from './status';
import { toast } from './toast';
import { refreshSuggestionsSoon } from './suggestion-hunks';
import * as workspace from './workspace';
import { openSetupWizard } from './wizard';

// The document a brand-new project is bootstrapped with, and the *preferred*
// fallback when the open one goes away. Never open it blind — go through
// fallbackDocument(), which checks the tree first (story 012-002: a move can
// carry draft/main.md, or the whole draft/ folder, somewhere else).
const MAIN_DOCUMENT = 'draft/main.md';

function wirePanelToggles(): void {
  const wire = (buttonId: string, panelId: string) => {
    document.getElementById(buttonId)!.addEventListener('click', () => {
      document.getElementById(panelId)!.classList.toggle('collapsed');
    });
  };
  wire('toggle-chat', 'chat-panel');
  wire('toggle-files', 'files-panel');
}

// Top-bar Export dropdown — the real #export-docx / #export-tex buttons live
// inside; preview.ts binds their click handlers (story 019).
function wireExportMenu(): void {
  const btn = document.getElementById('export-menu-btn');
  const menu = document.getElementById('export-menu');
  if (!btn || !menu) return;
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) close();
  });
  menu.addEventListener('click', () => close()); // pick a format → close
}

// Empty-state editor hero (story 025 screen 3): shown by the editor when the
// document is blank. Seeding is now chat-driven — the PM greets and interviews
// in the chat panel on a brand-new project — so the hero points there rather
// than carrying its own seed button. Start blank → dismiss and start typing.
function buildEditorHero(): void {
  const pane = document.getElementById('editor-pane');
  if (!pane || document.getElementById('editor-hero')) return;
  const hero = document.createElement('div');
  hero.id = 'editor-hero';
  hero.hidden = true;
  hero.innerHTML =
    `<div class="hero-inner">` +
      `<div class="hero-icon">${icon('file-text', { size: 24, stroke: 1.6 })}</div>` +
      `<h1 class="hero-title">Start your document</h1>` +
      `<p class="hero-sub">Your project manager is in the chat — answer a few questions and ` +
        `Kuhn will research and draft a skeleton from your materials. Or begin with a blank page.</p>` +
      `<div class="hero-actions">` +
        `<button id="hero-blank" class="btn btn-ghost">Start blank</button>` +
      `</div>` +
      `<div class="hero-privacy">${icon('lock', { size: 13, stroke: 1.8 })} Your materials stay private to this project.</div>` +
    `</div>`;
  pane.append(hero);
  hero.querySelector('#hero-blank')!.addEventListener('click', () => {
    hero.hidden = true;
    (document.querySelector('#editor .milkdown [contenteditable]') as HTMLElement | null)?.focus();
  });
}

// Each project switch bumps this; async steps bail if a newer switch started,
// so racing switches can't cross-wire one project's document into another.
let switchSeq = 0;

// The path the editor is open on *or on its way to* (story 012-002). Set
// synchronously at every open site, because openDocument only assigns its own
// currentPath after `await closeDocument()` — an event landing in that window
// would otherwise read the previous document's path and retarget the wrong
// file. It is also the re-entrancy guard for the moved handler below.
let openTarget = '';

// Always-on project event feed (story 005-003): one subscription per active
// project, torn down on switch. While it is open, the job-scoped chat stream's
// file_change side-effects stand down so the same event isn't applied twice;
// if the feed drops, EventSource auto-reconnects and the chat stream covers
// the gap in the meantime.
let closeFeed: (() => void) | null = null;
let feedOpen = false;

/**
 * Open the workspace's active project in place: re-wire the per-project panes
 * (chat, files, preview), then open its recorded document (or a sensible
 * fallback). Called on bootstrap and on every project/org switch.
 */
async function switchToActiveProject(): Promise<void> {
  const project = workspace.activeProject();
  const seq = ++switchSeq;

  if (!project) {
    // No project in this org — close the editor and invite the user to create one.
    // With zero orgs there is nothing to create into; the zero-orgs empty state
    // (org-library.ts) owns that screen instead of the project browser.
    await closeDocument();
    openTarget = '';
    setActiveFile('');
    document.getElementById('editor-path')!.textContent = '';
    if (!workspace.hasNoOrgs()) openProjectBrowser();
    return;
  }

  const projectId = project.id;

  // One handler for a file change regardless of which channel delivered it
  // (project feed or job stream) — badge state, tree refresh (debounced so a
  // burst or a double delivery coalesces), bib panel, and open-editor updates.
  const handleFileChange = (change: FileChange): void => {
    recordFileChange(change); // feed the files-panel status map (story 014)
    refreshTreeSoon(projectId);
    // Any file_change can shift the pending-suggestion set (story 008-001):
    // re-fetch (debounced) and reconcile the open doc's hunk decorations.
    refreshSuggestionsSoon();
    // Content changes also move comment anchors (story 008-004): re-anchor,
    // orphaning any thread whose quoted text the change removed.
    refreshCommentsSoon();
    // Keep the citation cache pointing at the right file (story 012-001).
    // A path is ADOPTED only when the event actually carried the current
    // bibliography somewhere else — that is the one case where the event knows
    // more than the tree does (refreshTreeSoon is debounced 250 ms, so the
    // snapshot is still pre-move at this point). Everything else refreshes with
    // no path so bib.ts re-resolves from the tree: adopting on any `.bib` event
    // would make an uploaded `sources/smith-refs.bib` the project bibliography,
    // splitting the app's reads from the `/cite` writes that still land in the
    // real one. Note the move test is NOT a `.bib` suffix test — moving the
    // whole `draft/` folder carries the bib with it and names neither end `.bib`.
    if (change.kind === 'moved' && change.from) {
      const nextBib = movedPath(currentBibPath(), change.from, change.path);
      if (nextBib != null) void refreshBib(projectId, nextBib);
      else if (change.path.endsWith('.bib') || change.from.endsWith('.bib')) void refreshBib(projectId);
    } else if (change.path.endsWith('.bib')) {
      void refreshBib(projectId);
    }
    // A move preserves the document's identity (story 012-002), so the open
    // tab FOLLOWS it instead of falling back like a delete. This is the ONE
    // retarget path in the webapp — files.ts deliberately stopped reopening
    // after its own rename, because the server fans this event out
    // synchronously *before* the move response returns, so both sites would
    // race two concurrent opens of the same document. It must also sit outside
    // the `change.path === currentDocumentPath()` guard below: `change.path`
    // is the NEW path, which by definition never matches the open one.
    if (change.kind === 'moved') {
      const open = openTarget || currentDocumentPath();
      // The decision (incl. the missing-`from` lossy-channel fallback) is
      // pure and unit-tested in move-follow.ts (story 012-004).
      const action = movedDocAction(open, change);
      if (action.kind === 'follow-blind') void followMoveBlind(projectId, open, change.path);
      else if (action.kind === 'retarget') retargetOpenDoc(action.to);
      return;
    }
    if (change.kind === 'delete') {
      // The open document was deleted remotely — another tab, a collaborator,
      // or an agent move (story 041). Matched by PREFIX, not equality (story
      // 012-001): deleting a folder publishes exactly ONE event carrying the
      // FOLDER path (routes/files.js), so an equality test leaves this tab
      // open on a descendant that no longer exists, autosaving it — and the
      // parent directory with it — back into being.
      const open = currentDocumentPath();
      if (!open || !isUnder(open, change.path)) return;
      // A clean editor closes and falls back like the deleting tab does
      // (dropOpenDoc); a dirty one stays open so unsaved work isn't lost — its
      // next save re-creates the file.
      if (hasUnsavedChanges()) {
        notify(`${open} was deleted — your unsaved edits will re-create it on save`);
      } else {
        void discardDocument().then(() => {
          notify(`${open} was deleted`);
          fallBackAfterDelete(projectId, change.path);
        });
      }
      return;
    }
    if (change.path === currentDocumentPath()) {
      // 'proposed' moves no bytes — the decoration refresh above covers it.
      if (change.kind === 'proposed') return;
      // Live-update a clean editor in place (story 017); a dirty editor keeps
      // the reload prompt so unsaved local edits aren't clobbered.
      void applyExternalChange(change.path).then((applied) => {
        if (applied) {
          markSeen(change.path); // the update is on screen — that's seen
          // Re-anchor suggestion hunks against the freshly loaded content
          // (accepting a hunk lands here via the server's real write).
          refreshSuggestionsSoon();
        } else {
          notify(`${change.path} was changed by an agent — reload to pick up the new version`);
        }
      });
    }
  };

  // A configured project (has a saved title) has already been through intake —
  // chat must not re-offer the interview greeting (story: invisible PM gating).
  const seeded = Boolean(project.config?.title);
  initChat(projectId, (change) => {
    // The project feed carries the same events; only apply from the job
    // stream while the feed is down (story 005-003 reconciliation).
    if (!feedOpen) handleFileChange(change);
  }, seeded);

  closeFeed?.();
  feedOpen = false;
  closeFeed = subscribeProjectEvents(projectId, {
    onOpen: () => { feedOpen = true; },
    onError: () => { feedOpen = false; },
    onEvent: (event) => {
      if (seq !== switchSeq) return; // stale subscription racing a switch
      // Citation events arrive alongside their own file_change — file_change
      // alone is sufficient here; chat renders citation system lines itself.
      if (event.type === 'file_change' && event.path) {
        handleFileChange({
          path: event.path,
          kind: event.kind,
          agent: event.agent,
          // On kind 'moved' (story 012-002) `path` is the NEW path and this is
          // the old one — without it nothing downstream can follow the move.
          from: event.meta?.from,
        });
      }
      // Comment mutations (story 008-004): refresh the open doc's threads and
      // the file-tree unresolved badges (the tree refetch carries the counts).
      if (event.type === 'comment' && event.path) {
        if (event.path === currentDocumentPath()) refreshCommentsSoon();
        refreshTreeSoon(projectId);
      }
      // Review-link lifecycle (epic 013 §3.4): surface mint/claim/revoke/edit
      // to members as toasts, and keep an open share dialog live. Reviewer
      // edits are NOT file_change events (that would evict the reviewer's own
      // room), so the tree/activity refresh has to ride this event instead.
      if (event.type === 'review_link') {
        const path = event.path ?? 'a document';
        const mode = event.mode ? ` (${event.mode})` : '';
        switch (event.action) {
          case 'mint':
            toast(`Review link created for ${path}${mode}`);
            break;
          case 'claim':
            toast(`Review link for ${path} claimed by ${event.name ?? 'a reviewer'}${mode}`);
            break;
          case 'revoke':
            toast(`Review link for ${path} revoked`);
            break;
          case 'edit':
            toast(`External reviewer ${event.name ?? ''} edited ${path}`.replace('  ', ' '));
            refreshTreeSoon(projectId); // external badge rides the activity log
            break;
        }
        refreshShareLinks();
      }
    },
  });

  initFiles(projectId, {
    onOpenMarkdown: (path) => openInEditor(projectId, path),
    onPreviewFile: (path) => void previewStoredFile(path),
    flushOpenDoc: () => flushSave(),
    dropOpenDoc: (deletedPath) => {
      // Drop the deleted doc without re-saving, then fall back to the main draft
      // (unless that's what was deleted) so the editor isn't left stranded.
      void discardDocument().then(() => fallBackAfterDelete(projectId, deletedPath));
    },
  });
  initPreview(projectId);

  await refreshTree(projectId);
  if (seq !== switchSeq) return; // a newer switch superseded this one

  // Pick the document: the recorded active doc if it still exists, else the
  // first markdown file, else bootstrap an empty main draft for a brand-new
  // project — the signal that the project has never been seeded.
  let doc = findMarkdownPath(project.config?.activeDocument);
  if (!doc) {
    // Bootstrapping the empty draft is a WRITE — viewers 403 on it (epic 011),
    // so land them on the no-document state instead of an error.
    if (!workspace.canEdit()) {
      await closeDocument();
      openTarget = '';
      setActiveFile('');
      workspace.setActiveDocument('');
      return;
    }
    await writeTextFile(projectId, MAIN_DOCUMENT, '');
    await refreshTree(projectId);
    if (seq !== switchSeq) return;
    doc = MAIN_DOCUMENT;
    maybeOpenSetupWizard(project);
  }

  setActiveFile(doc);
  openTarget = doc; // synchronously, before the await — see openTarget above
  await openDocument(projectId, doc);
  if (seq !== switchSeq) return;
  workspace.setActiveDocument(doc);
}

// A brand-new project (no markdown yet) that was never set up: open the setup
// wizard automatically. It stamps a draft on open (config.setup) so it opens
// exactly once — after that, re-entry is manual from the project browser.
function maybeOpenSetupWizard(
  project: NonNullable<ReturnType<typeof workspace.activeProject>>,
): void {
  if (project.config?.title) return; // already configured
  if (project.config?.setup) return; // wizard already shown/aborted once
  openSetupWizard(project.id, { auto: true });
}

/** Open a text file in the editor and record it as the active document. */
function openInEditor(projectId: number, path: string): void {
  openTarget = path;
  setActiveFile(path);
  workspace.setActiveDocument(path);
  void openDocument(projectId, path);
}

/**
 * Where the editor lands when the open document goes away: draft/main.md if it
 * is still in the tree, else whatever markdown the project actually has, else
 * nothing. Resolved through the tree rather than off the MAIN_DOCUMENT constant
 * because a move (story 012-002) can carry draft/main.md — or the whole draft/
 * folder — elsewhere, and opening a path that no longer exists seeds an empty
 * room from the template and re-creates the file on the first save.
 */
function fallbackDocument(): string | null {
  return findMarkdownPath(MAIN_DOCUMENT);
}

/**
 * Land the editor somewhere sane after `deletedPath` went away — a file, or
 * (story 012-001, now that folders have a delete button) a whole folder.
 *
 * The prefix test is the point. `deletedPath` can be an ANCESTOR of the open
 * document and of the fallback, and re-opening a document inside a folder that
 * was just deleted is not a cosmetic bug: openDocument seeds an empty Yjs room
 * from the template and the first autosave writes it back to disk, re-creating
 * the parent directory recursively. Closing the editor is the correct outcome
 * when nothing survives.
 *
 * Caveat, deliberate: on the local delete leg `files.ts` calls `dropOpenDoc`
 * BEFORE its `await deleteFile`, so `fallbackDocument()` reads a PRE-delete tree
 * snapshot. The prefix test makes that safe rather than correct — if the only
 * surviving markdown sorts after a doomed one, we close instead of opening it,
 * and the user re-opens from the tree. Refreshing here instead would race the
 * in-flight delete (and files.ts's own post-delete refresh) for no guarantee.
 */
function fallBackAfterDelete(projectId: number, deletedPath: string): void {
  const fallback = fallbackDocument();
  if (fallback && !isUnder(fallback, deletedPath)) {
    openInEditor(projectId, fallback);
  } else {
    openTarget = '';
    workspace.setActiveDocument('');
  }
}

/**
 * Follow the open document to `next` after a move (story 012-002). Retarget,
 * never reopen: editor.retargetDocument sets the path FIRST and only then
 * decides clean vs dirty, so an autosave firing in the window between the fs
 * rename and this event can only land on the new path instead of resurrecting
 * the old one. Reopening is its job too — a tab left out of the new Yjs room
 * would be a silent second writer.
 *
 * `openTarget` makes this re-entrant. The mover's own tab receives the event
 * while its own move request is still in flight (the hub fans out before the
 * route responds), and a 4002 room close can retarget the editor independently,
 * so the same move legitimately arrives twice.
 */
// The 4002 room-moved close retargets through here too, not straight into
// editor.retargetDocument, so the tree row and workspace follow on that leg as
// well (it is the leg that exists precisely for when the SSE feed is down).
setRetargetHandler((next) => retargetOpenDoc(next));

function retargetOpenDoc(next: string): void {
  if (!next || next === openTarget) return;
  openTarget = next;
  setActiveFile(next);
  workspace.setActiveDocument(next);
  void retargetDocument(next);
}

/**
 * A 'moved' event arrived without its old path (a lossy channel — the job
 * stream carries file_change only while the project feed is down). Guessing the
 * new path is impossible, and doing nothing leaves the tab autosaving to a path
 * that no longer exists, so re-read the tree and decide by inspection: if the
 * open document is still there the move wasn't ours; if it is gone and the
 * event names a file that now exists, follow it; otherwise say so out loud.
 */
async function followMoveBlind(projectId: number, open: string, to: string): Promise<void> {
  // This is the one place that awaits refreshTree for its DATA. A deferred
  // refresh (inline input open) leaves the snapshot stale, and deciding from a
  // stale tree would silently conclude "still on disk — not our document" for a
  // file that just moved, leaving the tab autosaving to a dead path.
  if (!(await refreshTree(projectId))) {
    notify(`${open} moved — reload to continue editing`);
    return;
  }
  if (findMarkdownPath(open) === open) return; // still on disk — not our document
  if (findMarkdownPath(to) === to) {
    retargetOpenDoc(to);
    return;
  }
  notify(`${open} moved — reload to continue editing`);
}

async function main(): Promise<void> {
  // Auth gate first (story 007-002): in real auth mode nothing below can load
  // without a session — initAuth puts up the login screen and we stop here.
  // The magic-link verify redirect reloads the page into the signed-in path.
  if (!(await initAuth())) return;
  setVersion();
  wirePanelToggles();
  wireExportMenu();
  initAgentSelector();
  buildEditorHero();
  setSetupHandler((projectId) => openSetupWizard(projectId));
  initHistoryButton(() => ({
    projectId: workspace.activeProject()?.id ?? 0,
    path: currentDocumentPath(),
  }));
  // Share for external review (epic 013): mint/list/revoke links for the doc.
  initShareLinks(() => ({
    projectId: workspace.activeProject()?.id ?? 0,
    path: currentDocumentPath(),
  }));
  initBreadcrumb();
  const sendBtn = document.querySelector('.send-btn');
  if (sendBtn) sendBtn.innerHTML = icon('send', { size: 15, stroke: 2 });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void flushSave({ checkpoint: true }); // explicit save = history version
    }
  });
  window.addEventListener('beforeunload', () => void closeDocument());

  // React to workspace changes: a project switch re-opens the project in place;
  // a document segment click in the breadcrumb reveals the file in the tree.
  workspace.subscribe((change) => {
    if (change === 'project') void switchToActiveProject();
  });

  try {
    await workspace.initWorkspace();
  } catch (err) {
    document.getElementById('editor')!.textContent =
      `Cannot reach the agent backend: ${(err as Error).message}. ` +
      'Start it with `npm run dev` in agent-backend/ and reload.';
    return;
  }

  await switchToActiveProject();
}

void main();
