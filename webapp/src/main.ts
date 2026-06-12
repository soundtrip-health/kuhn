// Kuhn webapp entry point (story 013): bootstrap the active project, then
// wire the three panes — agent chat, Milkdown editor, file tree — and the
// status bar.

import './style.css';

import { createProject, listProjects, writeTextFile, type Project } from './api';
import { initChat, startSeeding } from './chat';
import { closeDocument, currentDocumentPath, flushSave, openDocument } from './editor';
import { onOpenMarkdownFile, refreshTree } from './files';
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

async function main(): Promise<void> {
  wirePanelToggles();

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

  initChat(project.id, (changedPath) => {
    void refreshTree(project.id);
    if (changedPath === currentDocumentPath()) {
      notify(`${changedPath} was changed by an agent — reload to pick up the new version`);
    }
  });

  onOpenMarkdownFile((path) => void openDocument(project.id, path));

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
  await openDocument(project.id, MAIN_DOCUMENT);
}

void main();
