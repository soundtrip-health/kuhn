// Top-left breadcrumb (story 007): live org / project / document segments wired
// to the workspace store (stories 005/006), replacing the hardcoded "Okafor
// Lab / Phase 2" text. Each segment is navigable — the org segment opens an org
// menu (switch org, or create one), the project segment opens the projects
// dashboard, and the document segment reveals the open file in the tree. The
// breadcrumb re-renders on every workspace change so it always shows where you
// are.

import { revealFile } from './files';
import { icon } from './icons';
import { openProjectBrowser } from './project-browser';
import * as workspace from './workspace';

const TYPE_LABEL: Record<string, string> = {
  manuscript: 'Manuscript',
  'rwe-protocol': 'RWE protocol',
  'rct-protocol': 'RCT protocol',
  grant: 'Grant',
  sop: 'SOP',
};

let orgMenuOpen = false;

export function initBreadcrumb(): void {
  workspace.subscribe(() => render());
  document.addEventListener('click', (e) => {
    const nav = document.getElementById('breadcrumb');
    if (orgMenuOpen && nav && !nav.contains(e.target as Node)) {
      orgMenuOpen = false;
      render();
    }
  });
  render();
}

function sep(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'breadcrumb-sep';
  s.textContent = '/';
  return s;
}

function render(): void {
  const nav = document.getElementById('breadcrumb');
  if (!nav) return;

  const org = workspace.activeOrg();
  const project = workspace.activeProject();
  const docPath = workspace.activeDocPath();

  const children: Node[] = [orgSegment(org?.name ?? 'No organization')];

  children.push(sep());
  children.push(projectSegment(project?.name ?? 'Select a project'));

  if (project) {
    const pill = document.createElement('span');
    pill.className = 'phase-pill';
    pill.textContent = TYPE_LABEL[project.project_type] ?? project.project_type;
    children.push(pill);
  }

  children.push(sep());
  children.push(documentSegment(docPath));

  nav.replaceChildren(...children);
}

function orgSegment(label: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'breadcrumb-orgwrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'breadcrumb-seg breadcrumb-org';
  btn.innerHTML = `<span></span>${icon('chevron-down', { size: 12, stroke: 2 })}`;
  (btn.querySelector('span') as HTMLElement).textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    orgMenuOpen = !orgMenuOpen;
    render();
  });
  wrap.append(btn);

  if (orgMenuOpen) wrap.append(orgMenu());
  return wrap;
}

function orgMenu(): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'breadcrumb-menu';
  const activeId = workspace.activeOrg()?.id;
  for (const org of workspace.orgs()) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'breadcrumb-menu-item';
    if (org.id === activeId) item.classList.add('is-active');
    item.innerHTML = `<span class="bm-check">${org.id === activeId ? icon('check', { size: 13, stroke: 2 }) : ''}</span><span></span>`;
    (item.querySelector('span:last-child') as HTMLElement).textContent = org.name;
    item.addEventListener('click', () => {
      orgMenuOpen = false;
      void workspace.setActiveOrg(org.id);
    });
    menu.append(item);
  }

  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'breadcrumb-menu-item bm-create';
  create.innerHTML = `<span class="bm-check">${icon('plus', { size: 13, stroke: 2 })}</span><span>New organization…</span>`;
  create.addEventListener('click', () => {
    orgMenuOpen = false;
    render();
    const name = window.prompt('New organization name')?.trim();
    if (name) void workspace.createNewOrg(name);
  });
  menu.append(create);
  return menu;
}

function projectSegment(label: string): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'breadcrumb-seg breadcrumb-project';
  btn.textContent = label;
  btn.title = 'Browse and switch projects';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openProjectBrowser();
  });
  return btn;
}

function documentSegment(path: string): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'breadcrumb-seg breadcrumb-doc';
  if (!path) {
    btn.textContent = 'No document';
    btn.disabled = true;
    return btn;
  }
  btn.textContent = path.split('/').pop() ?? path;
  btn.title = `Reveal ${path} in the file tree`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    revealFile(path);
  });
  return btn;
}
