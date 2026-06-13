// Kuhn webapp entry point (story 013; restyled for story 025; org/project
// browser wired in stories 005–007). Bootstraps the workspace (org → project →
// document) from the backend, wires the three panes — agent chat, Milkdown
// editor, file tree — the top bar, breadcrumb, and status bar, and reacts to
// workspace changes by switching the open project/document in place (no reload).

import './kuhn-tokens.css';
import './style.css';

import { initAgentSelector } from './agent-selector';
import { writeTextFile } from './api';
import { initBreadcrumb } from './breadcrumb';
import { refreshBib } from './bib';
import { initChat, startSeeding } from './chat';
import {
  applyExternalChange,
  closeDocument,
  currentDocumentPath,
  discardDocument,
  flushSave,
  openDocument,
} from './editor';
import { findMarkdownPath, initFiles, recordFileChange, refreshTree, setActiveFile } from './files';
import { icon } from './icons';
import { initPreview, previewStoredFile } from './preview';
import { openProjectBrowser } from './project-browser';
import { notify } from './status';
import * as workspace from './workspace';

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
// document is blank. Seed project → seeding pipeline; Start blank → dismiss.
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
      `<p class="hero-sub">Seed the project to get a researched skeleton — background, ` +
        `objectives, design, endpoints — drafted from your materials. Or begin with a blank page.</p>` +
      `<div class="hero-actions">` +
        `<button id="hero-seed" class="btn btn-accent">${icon('sparkle', { size: 15, stroke: 2 })} Seed project</button>` +
        `<button id="hero-blank" class="btn btn-ghost">Start blank</button>` +
      `</div>` +
      `<div class="hero-privacy">${icon('lock', { size: 13, stroke: 1.8 })} Your materials stay private to this project.</div>` +
    `</div>`;
  pane.append(hero);
  hero.querySelector('#hero-seed')!.addEventListener('click', () => void startSeeding());
  hero.querySelector('#hero-blank')!.addEventListener('click', () => {
    hero.hidden = true;
    (document.querySelector('#editor .milkdown [contenteditable]') as HTMLElement | null)?.focus();
  });
}

// Each project switch bumps this; async steps bail if a newer switch started,
// so racing switches can't cross-wire one project's document into another.
let switchSeq = 0;

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

  initChat(projectId, (change) => {
    recordFileChange(change); // feed the files-panel status map (story 014)
    const changedPath = change.path;
    void refreshTree(projectId);
    if (changedPath.endsWith('.bib')) void refreshBib(projectId);
    if (changedPath === currentDocumentPath()) {
      // Live-update a clean editor in place (story 017); a dirty editor keeps
      // the reload prompt so unsaved local edits aren't clobbered.
      void applyExternalChange(changedPath).then((applied) => {
        if (!applied) {
          notify(`${changedPath} was changed by an agent — reload to pick up the new version`);
        }
      });
    }
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
  // first markdown file, else bootstrap an empty main draft (which shows the
  // seeding hero) for a brand-new project.
  let doc = findMarkdownPath(project.config?.activeDocument);
  if (!doc) {
    await writeTextFile(projectId, MAIN_DOCUMENT, '');
    await refreshTree(projectId);
    if (seq !== switchSeq) return;
    doc = MAIN_DOCUMENT;
  }

  setActiveFile(doc);
  await openDocument(projectId, doc);
  if (seq !== switchSeq) return;
  workspace.setActiveDocument(doc);
}

/** Open a markdown file in the editor and record it as the active document. */
function openInEditor(projectId: number, path: string): void {
  setActiveFile(path);
  workspace.setActiveDocument(path);
  void openDocument(projectId, path);
}

async function main(): Promise<void> {
  wirePanelToggles();
  wireExportMenu();
  initAgentSelector();
  buildEditorHero();
  initBreadcrumb();
  const sendBtn = document.querySelector('.send-btn');
  if (sendBtn) sendBtn.innerHTML = icon('send', { size: 15, stroke: 2 });

  // Seeding pipeline (story 015): PM interview → research → skeleton draft
  document.getElementById('seed-project')!.addEventListener('click', () => void startSeeding());

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void flushSave();
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
