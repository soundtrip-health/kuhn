// Top-left breadcrumb (story 007): live org / project / document segments wired
// to the workspace store (stories 005/006), replacing the hardcoded "Okafor
// Lab / Phase 2" text. Each segment is navigable — the org segment opens an org
// menu (switch org, or create one), the project segment opens the projects
// dashboard, and the document segment reveals the open file in the tree. The
// breadcrumb re-renders on every workspace change so it always shows where you
// are.

import { openAdminConsole } from './admin-console';
import { revealFile } from './files';
import { icon } from './icons';
import { authMode, currentUser, signOut } from './login';
import { openOrgAdmin } from './org-admin';
import {
  libraryNeedsSetup,
  openCreateOrgModal,
  openOrgLibrary,
  refreshLibraryHint,
} from './org-library';
import { openProjectBrowser } from './project-browser';
import { TYPE_LABEL } from './project-types';
import * as workspace from './workspace';

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
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', String(orgMenuOpen));
  btn.innerHTML = `<span></span>${icon('chevron-down', { size: 12, stroke: 2 })}`;
  (btn.querySelector('span') as HTMLElement).textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    orgMenuOpen = !orgMenuOpen;
    render();
    if (orgMenuOpen) {
      document
        .querySelector<HTMLElement>('.breadcrumb-menu .breadcrumb-menu-item')
        ?.focus();
    }
  });
  wrap.append(btn);

  if (orgMenuOpen) wrap.append(orgMenu());
  return wrap;
}

/** Close the org menu and hand focus back to its trigger (story 005-004). */
function closeOrgMenu(): void {
  orgMenuOpen = false;
  render();
  document.querySelector<HTMLElement>('.breadcrumb-org')?.focus();
}

function orgMenu(): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'breadcrumb-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Organization');
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeOrgMenu();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
    items[(next + items.length) % items.length]?.focus();
  });
  const activeId = workspace.activeOrg()?.id;
  for (const org of workspace.orgs()) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'breadcrumb-menu-item';
    item.setAttribute('role', 'menuitem');
    if (org.id === activeId) item.classList.add('is-active');
    item.innerHTML = `<span class="bm-check">${org.id === activeId ? icon('check', { size: 13, stroke: 2 }) : ''}</span><span></span>`;
    (item.querySelector('span:last-child') as HTMLElement).textContent = org.name;
    item.addEventListener('click', () => {
      orgMenuOpen = false;
      void workspace.setActiveOrg(org.id);
    });
    menu.append(item);
  }

  // Org library entry (story 006-004) — carries a subtle "Set up" hint until
  // the org's first document is ready. The cached answer renders immediately;
  // a background refresh corrects the tag in place if it's stale.
  const orgId = activeId;
  if (orgId != null) {
    const library = document.createElement('button');
    library.type = 'button';
    library.className = 'breadcrumb-menu-item bm-library';
    library.setAttribute('role', 'menuitem');
    library.innerHTML =
      `<span class="bm-check">${icon('book', { size: 13, stroke: 1.8 })}</span>` +
      `<span>Org library…</span><span class="bm-hint" hidden>Set up</span>`;
    const hint = library.querySelector('.bm-hint') as HTMLElement;
    hint.hidden = libraryNeedsSetup(orgId) !== true;
    void refreshLibraryHint(orgId).then((needs) => {
      if (needs !== undefined) hint.hidden = !needs;
    });
    library.addEventListener('click', () => {
      closeOrgMenu();
      openOrgLibrary();
    });
    menu.append(library);
  }

  // Org admin entry (epic 011) — owners only; the overlay re-checks the role
  // on open and closes itself if a role refresh demotes the user.
  if (orgId != null && workspace.isOwner()) {
    const admin = document.createElement('button');
    admin.type = 'button';
    admin.className = 'breadcrumb-menu-item bm-admin';
    admin.setAttribute('role', 'menuitem');
    admin.innerHTML =
      `<span class="bm-check">${icon('lock', { size: 13, stroke: 1.8 })}</span>` +
      `<span>Org admin…</span>`;
    admin.addEventListener('click', () => {
      closeOrgMenu();
      openOrgAdmin();
    });
    menu.append(admin);
  } else if (orgId != null && workspace.activeOrgRole() != null) {
    // Non-owner members (issue #65): the same overlay, opened on its only
    // tab for them — the read-only Knowledge view.
    const knowledgeItem = document.createElement('button');
    knowledgeItem.type = 'button';
    knowledgeItem.className = 'breadcrumb-menu-item bm-knowledge';
    knowledgeItem.setAttribute('role', 'menuitem');
    knowledgeItem.innerHTML =
      `<span class="bm-check">${icon('sparkle', { size: 13, stroke: 1.8 })}</span>` +
      `<span>Org knowledge…</span>`;
    knowledgeItem.addEventListener('click', () => {
      closeOrgMenu();
      openOrgAdmin('knowledge');
    });
    menu.append(knowledgeItem);
  }

  // Platform items (epic 011): org creation moved behind the super-admin flag
  // (011-001 — orgs are provisioned, not self-served), and super-admins also
  // get the console (all orgs: rename, suspend, member counts).
  if (currentUser()?.is_superadmin) {
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'breadcrumb-menu-item bm-create';
    create.setAttribute('role', 'menuitem');
    create.innerHTML = `<span class="bm-check">${icon('plus', { size: 13, stroke: 2 })}</span><span>New organization…</span>`;
    create.addEventListener('click', () => {
      closeOrgMenu();
      openCreateOrgModal(); // modal with the library-seeding step (story 006-004)
    });
    menu.append(create);

    const console_ = document.createElement('button');
    console_.type = 'button';
    console_.className = 'breadcrumb-menu-item bm-console';
    console_.setAttribute('role', 'menuitem');
    console_.innerHTML = `<span class="bm-check">${icon('sparkle', { size: 13, stroke: 1.8 })}</span><span>Platform console…</span>`;
    console_.addEventListener('click', () => {
      closeOrgMenu();
      openAdminConsole();
    });
    menu.append(console_);
  }

  // Sign out (story 007-002) — only in real auth mode; dev mode has no
  // session to end. Labelled with the signed-in email so it doubles as the
  // "who am I" answer.
  if (authMode() !== 'dev') {
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'breadcrumb-menu-item bm-signout';
    out.setAttribute('role', 'menuitem');
    out.innerHTML = `<span class="bm-check">${icon('lock', { size: 13, stroke: 1.8 })}</span><span></span>`;
    (out.querySelector('span:last-child') as HTMLElement).textContent =
      `Sign out${currentUser() ? ` (${currentUser()!.email})` : ''}`;
    out.addEventListener('click', () => {
      closeOrgMenu();
      void signOut();
    });
    menu.append(out);
  }

  // Nothing actionable to show. In practice this is the dev-mode org-less
  // non-super-admin: no orgs to switch to, no org-scoped entries, org creation
  // is super-admin-only (011-001), and dev mode has no session to sign out of.
  // Rather than an unexplained empty popover, say why it's empty and who you
  // are — in dev mode the identity is the `x-kuhn-user` header, which is the
  // thing you'd want to check.
  if (menu.querySelector('[role="menuitem"]') === null) {
    const note = document.createElement('div');
    note.className = 'breadcrumb-menu-note';
    const who = currentUser()?.email;
    const lines = ['No organizations yet — organizations are invitation-only.'];
    if (who) lines.push(`Signed in as ${who}`);
    if (authMode() === 'dev') lines.push('Dev mode — no session to sign out of.');
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      note.append(p);
    }
    menu.append(note);
  }
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
