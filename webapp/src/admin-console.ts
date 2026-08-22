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
//
// It also owns the access-request queue (STH-35). That lives here rather than
// in org-admin.ts because a stranger who asked for access belongs to no org
// yet — deciding who gets in at all is a platform call, not an org owner's.

import {
  adminApproveAccessRequest,
  adminCreateOrg,
  adminDenyAccessRequest,
  adminListAccessRequests,
  adminListOrgs,
  adminUpdateOrg,
  type AccessRequest,
  type AdminOrg,
  type Role,
} from './api';
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

/** The pending access-request queue (STH-35) and its own inline refusal. */
let requests: AccessRequest[] = [];
let requestsLoading = false;
let requestsError: string | null = null;
/** Ids with a decision in flight — keeps a double-click from double-inviting. */
const deciding = new Set<number>();

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
  requests = [];
  listError = null;
  createError = null;
  requestsError = null;
  deciding.clear();

  render();
  void reloadOrgs();
  void reloadRequests();

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

async function reloadRequests(): Promise<void> {
  requestsLoading = requests.length === 0;
  render();
  try {
    requests = await adminListAccessRequests('pending');
    requestsError = null;
  } catch (err) {
    requestsError = (err as Error).message;
  } finally {
    requestsLoading = false;
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

/**
 * Approve: mint an invitation to the chosen org+role. The server does the
 * real work (and the real refusing) — this only reports the outcome and drops
 * the settled row out of the pending queue.
 */
async function approveRequest(request: AccessRequest, orgId: number, role: Role): Promise<void> {
  if (deciding.has(request.id)) return;
  deciding.add(request.id);
  render();
  try {
    await adminApproveAccessRequest(request.id, { orgId, role });
    requests = requests.filter((r) => r.id !== request.id);
    requestsError = null;
    const org = orgs.find((o) => o.id === orgId);
    toast(`Invited ${request.email} to ${org?.name ?? 'the organization'} as ${role}`);
  } catch (err) {
    requestsError = (err as Error).message;
  } finally {
    deciding.delete(request.id);
  }
  render();
}

async function denyRequest(request: AccessRequest): Promise<void> {
  if (deciding.has(request.id)) return;
  // Native confirm/prompt, same documented exception as renameOrg above.
  if (!window.confirm(`Deny access for ${request.email}? They are not notified.`)) return;
  const note = window.prompt('Reason (optional, for the record):', '') ?? '';
  deciding.add(request.id);
  render();
  try {
    await adminDenyAccessRequest(request.id, note.trim() || undefined);
    requests = requests.filter((r) => r.id !== request.id);
    requestsError = null;
    toast(`Denied ${request.email}`);
  } catch (err) {
    requestsError = (err as Error).message;
  } finally {
    deciding.delete(request.id);
  }
  render();
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

/**
 * One pending request per row: who asked, what they said about themselves,
 * and the two choices that turn it into an invitation. Approving REQUIRES
 * picking an org — there is no default landing place, and inventing one is
 * how people end up somewhere they should not be.
 */
function requestsTable(): HTMLElement {
  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML =
    '<thead><tr><th scope="col">Requester</th><th scope="col">Asked</th>' +
    '<th scope="col">Invite to</th><th></th></tr></thead>';
  const body = document.createElement('tbody');
  const active = orgs.filter((o) => o.status === 'active');

  for (const request of requests) {
    const tr = document.createElement('tr');
    const busy = deciding.has(request.id);

    const who = document.createElement('td');
    const email = document.createElement('div');
    email.className = 'admin-member-name';
    email.textContent = request.email;
    who.append(email);
    if (request.note) {
      const note = document.createElement('div');
      note.className = 'admin-request-note';
      note.textContent = request.note;
      who.append(note);
    }

    const asked = document.createElement('td');
    asked.className = 'admin-member-email';
    asked.textContent = request.request_count > 1
      ? `${formatDate(request.last_requested_at)} (×${request.request_count})`
      : formatDate(request.last_requested_at);

    const target = document.createElement('td');
    target.className = 'admin-request-target';
    const org = document.createElement('select');
    org.className = 'pb-select';
    org.setAttribute('aria-label', `Organization to invite ${request.email} to`);
    org.disabled = busy || active.length === 0;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = active.length ? 'Choose…' : 'No active organizations';
    org.append(placeholder);
    for (const o of active) {
      const option = document.createElement('option');
      option.value = String(o.id);
      option.textContent = o.name;
      org.append(option);
    }
    const role = document.createElement('select');
    role.className = 'pb-select';
    role.setAttribute('aria-label', `Role for ${request.email}`);
    role.disabled = busy;
    for (const r of ['viewer', 'editor', 'owner'] as Role[]) {
      const option = document.createElement('option');
      option.value = r;
      option.textContent = r;
      if (r === 'editor') option.selected = true; // the ordinary case
      role.append(option);
    }
    target.append(org, role);

    const actions = document.createElement('td');
    actions.className = 'admin-row-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'btn btn-accent btn-sm';
    approve.textContent = busy ? 'Working…' : 'Approve & invite';
    approve.disabled = busy;
    approve.setAttribute('aria-label', `Approve and invite ${request.email}`);
    approve.addEventListener('click', () => {
      if (!org.value) {
        requestsError = `Choose an organization to invite ${request.email} to.`;
        render();
        org.focus();
        return;
      }
      void approveRequest(request, Number(org.value), role.value as Role);
    });
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'btn btn-quiet btn-sm';
    deny.textContent = 'Deny';
    deny.disabled = busy;
    deny.setAttribute('aria-label', `Deny access for ${request.email}`);
    deny.addEventListener('click', () => void denyRequest(request));
    actions.append(approve, deny);

    tr.append(who, asked, target, actions);
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

  const queueTitle = document.createElement('div');
  queueTitle.className = 'admin-section-title';
  queueTitle.textContent = requests.length
    ? `Access requests (${requests.length})`
    : 'Access requests';
  body.append(queueTitle);
  if (requestsError) body.append(inlineError(requestsError));
  if (requestsLoading) {
    body.append(emptyRow('Loading access requests…'));
  } else if (requests.length === 0) {
    body.append(emptyRow('No one is waiting for access.'));
  } else {
    body.append(requestsTable());
  }

  const title = document.createElement('div');
  title.className = 'admin-section-title';
  title.textContent = 'Create an organization';
  body.append(title, createForm());
  if (createError) body.append(inlineError(createError));

  panel.append(head, body);
  root.replaceChildren(panel);
}
