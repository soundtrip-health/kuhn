// Kuhn webapp entry point (story 013; restyled for story 025): bootstrap the
// active project, then wire the three panes — agent chat, Milkdown editor, file
// tree — the top bar, and the status bar against the "Column" design.

import './kuhn-tokens.css';
import './style.css';

import { initAgentSelector } from './agent-selector';
import { createProject, listProjects, writeTextFile, type Project } from './api';
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
import { initFiles, recordFileChange, refreshTree, setActiveFile } from './files';
import { icon } from './icons';
import { initPreview, previewStoredFile } from './preview';
import { notify } from './status';

const MAIN_DOCUMENT = 'draft/main.md';

const BOOTSTRAP_DOCUMENT = `# Demo Manuscript

## Introduction

Welcome to Kuhn. This document lives at \`${MAIN_DOCUMENT}\` in your project.
Edit it here, or ask the agents in the chat panel to work on it.

Inline math works too: $e^{i\\pi} + 1 = 0$.
`;

async function activeProject(): Promise<Project> {
  const projects = await listProjects();
  if (projects.length > 0) return projects[0];
  const project = await createProject('Demo Manuscript');
  await writeTextFile(project.id, MAIN_DOCUMENT, BOOTSTRAP_DOCUMENT);
  return project;
}

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

async function main(): Promise<void> {
  wirePanelToggles();
  wireExportMenu();
  initAgentSelector();
  buildEditorHero();
  const sendBtn = document.querySelector('.send-btn');
  if (sendBtn) sendBtn.innerHTML = icon('send', { size: 15, stroke: 2 });

  let project: Project;
  try {
    project = await activeProject();
  } catch (err) {
    document.getElementById('editor')!.textContent =
      `Cannot reach the agent backend: ${(err as Error).message}. ` +
      'Start it with `npm run dev` in agent-backend/ and reload.';
    return;
  }

  document.getElementById('project-name')!.textContent = project.name;

  initChat(project.id, (change) => {
    recordFileChange(change); // feed the files-panel status map (story 014)
    const changedPath = change.path;
    void refreshTree(project.id);
    if (changedPath.endsWith('.bib')) void refreshBib(project.id);
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

  initFiles(project.id, {
    onOpenMarkdown: (path) => {
      setActiveFile(path);
      void openDocument(project.id, path);
    },
    onPreviewFile: (path) => void previewStoredFile(path),
    flushOpenDoc: () => flushSave(),
    reopenOpenDoc: (to) => {
      setActiveFile(to);
      void openDocument(project.id, to);
    },
    dropOpenDoc: (deletedPath) => {
      // Drop the deleted doc without re-saving, then fall back to the main draft
      // (unless that's what was deleted) so the editor isn't left stranded.
      void discardDocument().then(() => {
        if (deletedPath !== MAIN_DOCUMENT) {
          setActiveFile(MAIN_DOCUMENT);
          void openDocument(project.id, MAIN_DOCUMENT);
        }
      });
    },
  });
  initPreview(project.id);

  // Seeding pipeline (story 015): PM interview → research → skeleton draft
  document.getElementById('seed-project')!.addEventListener('click', () => void startSeeding());

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void flushSave();
    }
  });
  window.addEventListener('beforeunload', () => void closeDocument());

  await refreshTree(project.id);
  setActiveFile(MAIN_DOCUMENT);
  await openDocument(project.id, MAIN_DOCUMENT);
}

void main();
