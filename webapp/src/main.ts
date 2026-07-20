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
import { refreshBib } from './bib';
import { initChat, setSetupHandler } from './chat';
import {
  applyExternalChange,
  closeDocument,
  currentDocumentPath,
  discardDocument,
  flushSave,
  hasUnsavedChanges,
  openDocument,
} from './editor';
import {
  findMarkdownPath,
  initFiles,
  markSeen,
  recordFileChange,
  refreshTree,
  refreshTreeSoon,
  setActiveFile,
  type FileChange,
} from './files';
import { initHistoryButton } from './history-panel';
import { icon } from './icons';
import { initAuth } from './login';
import { initPreview, previewStoredFile } from './preview';
import { openProjectBrowser } from './project-browser';
import { notify, setVersion } from './status';
import * as workspace from './workspace';
import { openSetupWizard } from './wizard';

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
    await closeDocument();
    setActiveFile('');
    document.getElementById('editor-path')!.textContent = '';
    openProjectBrowser();
    return;
  }

  const projectId = project.id;

  // One handler for a file change regardless of which channel delivered it
  // (project feed or job stream) — badge state, tree refresh (debounced so a
  // burst or a double delivery coalesces), bib panel, and open-editor updates.
  const handleFileChange = (change: FileChange): void => {
    recordFileChange(change); // feed the files-panel status map (story 014)
    refreshTreeSoon(projectId);
    if (change.path.endsWith('.bib')) void refreshBib(projectId);
    if (change.path === currentDocumentPath()) {
      if (change.kind === 'delete') {
        // The open document was deleted remotely — another tab, a
        // collaborator, or an agent move (story 041). A clean editor closes
        // and falls back like the deleting tab does (dropOpenDoc); a dirty
        // one stays open so unsaved work isn't lost — its next save
        // re-creates the file.
        if (hasUnsavedChanges()) {
          notify(`${change.path} was deleted — your unsaved edits will re-create it on save`);
        } else {
          void discardDocument().then(() => {
            notify(`${change.path} was deleted`);
            if (change.path !== MAIN_DOCUMENT) {
              openInEditor(projectId, MAIN_DOCUMENT);
            } else {
              workspace.setActiveDocument('');
            }
          });
        }
        return;
      }
      // Live-update a clean editor in place (story 017); a dirty editor keeps
      // the reload prompt so unsaved local edits aren't clobbered.
      void applyExternalChange(change.path).then((applied) => {
        if (applied) {
          markSeen(change.path); // the update is on screen — that's seen
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
        handleFileChange({ path: event.path, kind: event.kind, agent: event.agent });
      }
    },
  });

  initFiles(projectId, {
    onOpenMarkdown: (path) => openInEditor(projectId, path),
    onPreviewFile: (path) => void previewStoredFile(path),
    flushOpenDoc: () => flushSave(),
    reopenOpenDoc: (to) => openInEditor(projectId, to),
    dropOpenDoc: (deletedPath) => {
      // Drop the deleted doc without re-saving, then fall back to the main draft
      // (unless that's what was deleted) so the editor isn't left stranded.
      void discardDocument().then(() => {
        if (deletedPath !== MAIN_DOCUMENT) {
          openInEditor(projectId, MAIN_DOCUMENT);
        } else {
          workspace.setActiveDocument('');
        }
      });
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
    await writeTextFile(projectId, MAIN_DOCUMENT, '');
    await refreshTree(projectId);
    if (seq !== switchSeq) return;
    doc = MAIN_DOCUMENT;
    maybeOpenSetupWizard(project);
  }

  setActiveFile(doc);
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

/** Open a markdown file in the editor and record it as the active document. */
function openInEditor(projectId: number, path: string): void {
  setActiveFile(path);
  workspace.setActiveDocument(path);
  void openDocument(projectId, path);
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
