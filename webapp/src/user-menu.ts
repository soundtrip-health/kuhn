// Signed-in user popover: the topbar avatar (initials) opens a card saying
// who you are — display name / email, platform super-admin flag, your role
// in the active organization — with sign out at the bottom. Sign out lives
// here rather than in the org menu: the org menu is about *where* you are,
// this is about *who* you are. Same button+menu idiom as help.ts.

import { icon } from './icons';
import { authMode, currentUser, signOut } from './login';
import * as workspace from './workspace';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
};

export function initUserMenu(): void {
  const button = document.getElementById('user-btn');
  const menu = document.getElementById('user-menu');
  if (!button || !menu) return;

  renderButton(button);
  // Roles and the active org change under us (org switch, role refresh);
  // the button only needs to know the user, but a re-render is cheap.
  workspace.subscribe(() => {
    renderButton(button);
    if (!menu.hidden) renderMenu(menu);
  });

  const close = (): void => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    renderMenu(menu);
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector<HTMLElement>('button')?.focus();
  };

  button.addEventListener('click', (e) => {
    e.preventDefault();
    menu.hidden ? open() : close();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !button.contains(e.target as Node) && !menu.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      close();
      button.focus();
    }
  });
}

/** Two-letter initials from the display name, else the email's local part. */
function initials(): string {
  const me = currentUser();
  if (!me) return '?';
  const name = me.display_name?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  return me.email.slice(0, 2).toUpperCase();
}

function renderButton(button: HTMLElement): void {
  const me = currentUser();
  if (!me) {
    button.innerHTML = icon('user', { size: 16, stroke: 1.8 });
    button.title = 'Account';
    return;
  }
  button.textContent = initials();
  const who = me.display_name ? `${me.display_name} (${me.email})` : me.email;
  button.title = `Signed in as ${who}`;
  button.setAttribute('aria-label', `Account: ${who}`);
}

function line(className: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

function renderMenu(menu: HTMLElement): void {
  const me = currentUser();
  const children: Node[] = [];

  const head = document.createElement('div');
  head.className = 'user-menu-head';
  const avatar = document.createElement('span');
  avatar.className = 'user-avatar user-avatar-lg';
  avatar.textContent = initials();
  const ident = document.createElement('div');
  ident.className = 'user-menu-ident';
  if (me) {
    if (me.display_name) ident.append(line('user-menu-name', me.display_name));
    ident.append(line(me.display_name ? 'user-menu-email' : 'user-menu-name', me.email));
  } else {
    ident.append(line('user-menu-name', 'Not signed in'));
  }
  head.append(avatar, ident);
  children.push(head);

  // Roles: platform-wide first, then the active org.
  const roles = document.createElement('div');
  roles.className = 'user-menu-roles';
  if (me?.is_superadmin) {
    roles.append(role('Platform super-admin', 'sparkle', 'Manage all organizations from the platform console (org menu).'));
  }
  const org = workspace.activeOrg();
  if (org) {
    const r = workspace.activeOrgRole();
    const label = r ? ROLE_LABEL[r] ?? r : 'Member';
    const detail =
      r === 'owner' ? 'Manage members, settings and knowledge for this organization.'
      : r === 'editor' ? 'Edit projects and documents in this organization.'
      : r === 'viewer' ? 'Read-only access to this organization.'
      : '';
    roles.append(role(`${label} of ${org.name}`, r === 'viewer' ? 'lock' : 'pencil', detail));
  } else if (me) {
    roles.append(role('No organization', 'lock', 'Organizations are invitation-only.'));
  }
  const orgCount = workspace.orgs().length;
  if (orgCount > 1) {
    roles.append(line('user-menu-note', `Member of ${orgCount} organizations — switch in the breadcrumb.`));
  }
  if (roles.childElementCount) children.push(roles);

  const foot = document.createElement('div');
  foot.className = 'user-menu-foot';
  if (authMode() === 'dev') {
    foot.append(line('user-menu-note', 'Dev mode — identity comes from the x-kuhn-user header; there is no session to sign out of.'));
  } else {
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'user-menu-item';
    out.innerHTML = `${icon('log-out', { size: 14, stroke: 1.8 })}<span>Sign out</span>`;
    out.title = 'End this session on this device';
    out.addEventListener('click', () => void signOut());
    foot.append(out);
  }
  children.push(foot);

  menu.replaceChildren(...children);
}

function role(label: string, iconName: 'sparkle' | 'lock' | 'pencil', detail: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'user-menu-role';
  row.innerHTML = `<span class="user-menu-role-icon">${icon(iconName, { size: 13, stroke: 1.8 })}</span>`;
  const text = document.createElement('div');
  text.append(line('user-menu-role-label', label));
  if (detail) text.append(line('user-menu-role-detail', detail));
  row.append(text);
  return row;
}
