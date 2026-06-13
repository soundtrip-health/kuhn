// Project & document browser overlay (story 006): the projects dashboard for
// the active organization. Lists the org's projects as cards, lets the user
// switch to one (no full reload — it drives workspace state, which main reacts
// to), and creates a new project that drops into the seeding hero. The org
// switcher itself lives in the breadcrumb's org menu (story 007); this overlay
// is the project surface.

import { icon } from './icons';
import * as workspace from './workspace';

const PROJECT_TYPES: { value: string; label: string }[] = [
  { value: 'manuscript', label: 'Manuscript' },
  { value: 'rwe-protocol', label: 'RWE protocol' },
  { value: 'rct-protocol', label: 'RCT protocol' },
  { value: 'grant', label: 'Grant' },
  { value: 'sop', label: 'SOP' },
];

const TYPE_LABEL: Record<string, string> =
  Object.fromEntries(PROJECT_TYPES.map((t) => [t.value, t.label]));

let overlay: HTMLElement | null = null;
let creating = false;

function ensureOverlay(): HTMLElement {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'project-browser';
  overlay.className = 'pb-overlay';
  overlay.hidden = true;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(); // backdrop click closes
  });
  document.body.append(overlay);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay!.hidden) close();
  });
  // Keep the dashboard live while open as projects load or are created.
  workspace.subscribe((change) => {
    if (!overlay!.hidden && (change === 'projects' || change === 'project')) render();
  });
  return overlay;
}

export function openProjectBrowser(): void {
  ensureOverlay().hidden = false;
  render();
}

export function close(): void {
  if (overlay) overlay.hidden = true;
}

function render(): void {
  const root = ensureOverlay();
  const org = workspace.activeOrg();
  const projects = workspace.projects();
  const activeId = workspace.activeProject()?.id;

  const modal = document.createElement('div');
  modal.className = 'pb-modal';

  // Header
  const head = document.createElement('header');
  head.className = 'pb-head';
  const heading = document.createElement('div');
  heading.innerHTML =
    `<div class="pb-eyebrow">Projects</div>` +
    `<h2 class="pb-org"></h2>`;
  (heading.querySelector('.pb-org') as HTMLElement).textContent = org?.name ?? 'No organization';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pb-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icon('x', { size: 16, stroke: 2 });
  closeBtn.addEventListener('click', () => close());
  head.append(heading, closeBtn);

  // Project grid
  const grid = document.createElement('div');
  grid.className = 'pb-grid';
  if (projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pb-empty';
    empty.textContent = 'No projects yet — create your first below.';
    grid.append(empty);
  } else {
    for (const project of projects) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pb-card';
      if (project.id === activeId) card.classList.add('is-active');
      const name = document.createElement('div');
      name.className = 'pb-card-name';
      name.textContent = project.name;
      const meta = document.createElement('div');
      meta.className = 'pb-card-meta';
      const typePill = document.createElement('span');
      typePill.className = 'pb-type-pill';
      typePill.textContent = TYPE_LABEL[project.project_type] ?? project.project_type;
      meta.append(typePill);
      if (project.id === activeId) {
        const open = document.createElement('span');
        open.className = 'pb-open-tag';
        open.textContent = 'Open';
        meta.append(open);
      }
      card.append(name, meta);
      card.addEventListener('click', () => {
        workspace.setActiveProject(project.id);
        close();
      });
      grid.append(card);
    }
  }

  // New-project form
  const form = document.createElement('form');
  form.className = 'pb-new';
  const nameInput = document.createElement('input');
  nameInput.className = 'pb-input';
  nameInput.placeholder = 'New project name…';
  nameInput.required = true;
  const typeSelect = document.createElement('select');
  typeSelect.className = 'pb-select';
  for (const t of PROJECT_TYPES) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    typeSelect.append(opt);
  }
  const createBtn = document.createElement('button');
  createBtn.type = 'submit';
  createBtn.className = 'btn btn-accent';
  createBtn.textContent = 'Create project';
  form.append(nameInput, typeSelect, createBtn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name || creating) return;
    creating = true;
    createBtn.disabled = true;
    void workspace
      .createNewProject(name, typeSelect.value)
      .then(() => close())
      .catch((err: Error) => {
        creating = false;
        createBtn.disabled = false;
        nameInput.setCustomValidity(err.message);
        nameInput.reportValidity();
        nameInput.addEventListener('input', () => nameInput.setCustomValidity(''), { once: true });
      })
      .finally(() => {
        creating = false;
      });
  });

  modal.append(head, grid, form);
  root.replaceChildren(modal);
}
