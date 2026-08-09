// Platform admin console (story 011-001): the super-admin-only overlay over
// every organization on the install — status badges, member counts, rename,
// suspend/reactivate, and the create form (name + first-admin email, defaulting
// to the caller so the local create → switch → seed flow keeps working).
// Entry point is the breadcrumb org menu; breadcrumb.ts only renders that item
// for super-admins, and this module re-checks on every open.
//
// Reuses org-admin.ts's admin CSS primitives (plan §4.6) untouched. Note the
// platform flag is NOT a membership: creating an org for someone else leaves
// the caller with no access to it (member:false), which is why the console
// never switches the workspace into an org it creates.

import { adminCreateOrg, adminListOrgs, adminUpdateOrg, type AdminOrg } from './api';
import { trapFocus } from './a11y';
import { icon } from './icons';
import { currentUser } from './login';
import { toast } from './toast';

let overlay: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;

let orgs: AdminOrg[] = [];
let loading = false;
/** Inline refusals (load failures, rename/suspend errors). */
let listError: string | null = null;
let createError: string | null = null;

const isSuperadmin = (): boolean => currentUser()?.is_superadmin === true;

/** A platform change (rename, suspension, self-owned creation) can touch the
 * user's own org rows — nudge workspace.ts's existing role-refresh listener
 * so the switcher and suspended banner re-render against fresh state. */
function refreshWorkspaceOrgs(): void {
  window.dispatchEvent(new CustomEvent('kuhn:role-refresh'));
}

function ensureOverlay(): HTMLElement {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'admin-console';
  overlay.className = 'admin-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Platform console');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeAdminConsole();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay!.hidden) closeAdminConsole();
  });
  document.body.append(overlay);
  return overlay;
}

export function openAdminConsole(): void {
  if (!isSuperadmin()) return;
  const root = ensureOverlay();
  const wasHidden = root.hidden;
  root.hidden = false;

  orgs = [];
  listError = null;
  createError = null;

  render();
  void reloadOrgs();

  if (wasHidden) {
    releaseFocus?.();
    releaseFocus = trapFocus(root);
  }
}

export function closeAdminConsole(): void {
  if (overlay) overlay.hidden = true;
  releaseFocus?.(); // restores focus to the opener
  releaseFocus = null;
}

// ---- Data loading ---------------------------------------------------------------

async function reloadOrgs(): Promise<void> {
  loading = orgs.length === 0;
  render();
  try {
    orgs = await adminListOrgs();
    listError = null;
  } catch (err) {
    listError = (err as Error).message;
  } finally {
    loading = false;
  }
  render();
}

// ---- Actions --------------------------------------------------------------------

async function renameOrg(org: AdminOrg): Promise<void> {
  // Native prompt/confirm, same accessibility rationale as org-admin.ts
  // (documented exception, story 005-004). Cancel aborts.
  const name = window.prompt(`New name for ${org.name}:`, org.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === org.name) return;
  try {
    const updated = await adminUpdateOrg(org.id, { name: trimmed });
    orgs = orgs.map((o) => (o.id === org.id ? updated : o));
    listError = null;
    toast(`Renamed to ${updated.name}`);
    refreshWorkspaceOrgs();
  } catch (err) {
    listError = (err as Error).message;
  }
  render();
}

async function setOrgStatus(org: AdminOrg, status: 'active' | 'suspended'): Promise<void> {
  const question =
    status === 'suspended'
      ? `Suspend ${org.name}? Every member loses access to its projects and library until it is reactivated.`
      : `Reactivate ${org.name}? Its members regain access immediately.`;
  if (!window.confirm(question)) return;
  try {
    const updated = await adminUpdateOrg(org.id, { status });
    orgs = orgs.map((o) => (o.id === org.id ? updated : o));
    listError = null;
    toast(status === 'suspended' ? `Suspended ${org.name}` : `Reactivated ${org.name}`);
    refreshWorkspaceOrgs();
  } catch (err) {
    listError = (err as Error).message;
  }
  render();
}

async function createOrgFromForm(name: string, ownerEmail: string): Promise<boolean> {
  try {
    const { org, member } = await adminCreateOrg({
      name,
      ...(ownerEmail ? { ownerEmail } : {}),
    });
    createError = null;
    if (member) {
      // ownerEmail was the caller's own account — they hold the owner
      // membership, so the org belongs in their workspace switcher too.
      toast(`Created ${org.name} — you are its first owner`);
      refreshWorkspaceOrgs();
    } else if (ownerEmail) {
      toast(`Created ${org.name} — ${ownerEmail} will be its first admin`);
    } else {
      toast(`Created ${org.name} (no members yet)`);
    }
  } catch (err) {
    createError = (err as Error).message;
    render();
    return false;
  }
  await reloadOrgs();
  return true;
}

// ---- Render ----------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function inlineError(message: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'admin-inline-error';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  return el;
}

function emptyRow(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'admin-empty';
  el.setAttribute('role', 'status');
  el.textContent = text;
  return el;
}

function orgsTable(): HTMLElement {
  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML =
    '<thead><tr><th scope="col">Organization</th><th scope="col">Status</th>' +
    '<th scope="col">Members</th><th scope="col">Created</th><th></th></tr></thead>';
  const body = document.createElement('tbody');
  for (const org of orgs) {
    const tr = document.createElement('tr');

    const who = document.createElement('td');
    const name = document.createElement('div');
    name.className = 'admin-member-name';
    name.textContent = org.name;
    const slug = document.createElement('div');
    slug.className = 'admin-member-email';
    slug.textContent = org.slug;
    who.append(name, slug);

    const status = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `status-badge is-${org.status}`;
    badge.textContent = org.status;
    status.append(badge);

    const members = document.createElement('td');
    members.textContent = String(org.member_count);

    const created = document.createElement('td');
    created.className = 'admin-member-email';
    created.textContent = formatDate(org.created_at);

    const actions = document.createElement('td');
    actions.className = 'admin-row-actions';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'btn btn-quiet btn-sm';
    rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename ${org.name}`);
    rename.addEventListener('click', () => void renameOrg(org));
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-quiet btn-sm';
    toggle.textContent = org.status === 'suspended' ? 'Reactivate' : 'Suspend';
    toggle.setAttribute(
      'aria-label',
      `${org.status === 'suspended' ? 'Reactivate' : 'Suspend'} ${org.name}`,
    );
    toggle.addEventListener('click', () =>
      void setOrgStatus(org, org.status === 'suspended' ? 'active' : 'suspended'),
    );
    actions.append(rename, toggle);

    tr.append(who, status, members, created, actions);
    body.append(tr);
  }
  table.append(body);
  return table;
}

function createForm(): HTMLElement {
  const form = document.createElement('form');
  form.className = 'admin-form-row';

  const name = document.createElement('input');
  name.className = 'pb-input';
  name.required = true;
  name.placeholder = 'Organization name';
  name.setAttribute('aria-label', 'New organization name');

  // First admin (MB1): defaults to the caller so a local create keeps them in;
  // a different email hands the org over — the caller gets NO access to it.
  const email = document.createElement('input');
  email.className = 'pb-input';
  email.type = 'email';
  email.value = currentUser()?.email ?? '';
  email.placeholder = 'first-admin@example.org';
  email.setAttribute('aria-label', 'First admin email');

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-accent btn-sm';
  submit.textContent = 'Create';

  form.append(name, email, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const orgName = name.value.trim();
    if (!orgName) return;
    submit.disabled = true;
    void createOrgFromForm(orgName, email.value.trim()).then((ok) => {
      submit.disabled = false;
      if (ok) name.value = '';
    });
  });
  return form;
}

function render(): void {
  const root = ensureOverlay();
  if (root.hidden) return;

  const panel = document.createElement('div');
  panel.className = 'admin-panel';

  const head = document.createElement('header');
  head.className = 'pb-head';
  const heading = document.createElement('div');
  heading.innerHTML = `<div class="pb-eyebrow">Platform console</div><h2 class="pb-org">Organizations</h2>`;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pb-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icon('x', { size: 16, stroke: 2 });
  closeBtn.addEventListener('click', () => closeAdminConsole());
  head.append(heading, closeBtn);

  const body = document.createElement('div');
  body.className = 'admin-body';
  if (listError) body.append(inlineError(listError));
  if (loading) {
    body.append(emptyRow('Loading organizations…'));
  } else if (orgs.length === 0 && !listError) {
    body.append(emptyRow('No organizations yet.'));
  } else if (orgs.length > 0) {
    body.append(orgsTable());
  }

  const title = document.createElement('div');
  title.className = 'admin-section-title';
  title.textContent = 'Create an organization';
  body.append(title, createForm());
  if (createError) body.append(inlineError(createError));

  panel.append(head, body);
  root.replaceChildren(panel);
}
