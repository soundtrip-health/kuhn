// Org admin overlay (010-003 + stories 011-002/003/004): the owner-only
// three-tab panel — Members (roles, removal, invitations), Settings (rename +
// org knobs), Promotions (pending library suggestions with preview and
// approve/reject). Entry point is the breadcrumb org menu; breadcrumb.ts only
// renders that item for owners, and this module re-checks on every open.
//
// The promotions preview is deliberately built from api.ts primitives
// (readTextFile / fileBlobUrl with an EXPLICIT project id): preview.ts is a
// singleton bound to the ACTIVE project and cannot render files from the
// arbitrary projects a promotion request points at.

import { marked } from 'marked';
import {
  ApiError,
  approvePromotion,
  createInvitation,
  fileBlobUrl,
  getOrgKnowledge,
  getOrgSettings,
  listInvitations,
  listOrgMembers,
  listPromotions,
  putKnowledgeSelections,
  readTextFile,
  reimportKnowledgeItems,
  rejectPromotion,
  removeOrgMember,
  revokeInvitation,
  updateMemberRole,
  updateOrgSettings,
  type Invitation,
  type KnowledgePackage,
  type OrgKnowledgeItem,
  type OrgMember,
  type OrgSettings,
  type PromotionRequest,
  type Role,
} from './api';
import { trapFocus } from './a11y';
import { icon } from './icons';
import { addOrgFeedListener, refreshLibraryHint } from './org-library';
import { toast } from './toast';
import * as workspace from './workspace';

type Tab = 'members' | 'settings' | 'promotions' | 'knowledge';

/** Owner-only tabs; non-owner members see only the read-only Knowledge tab. */
const OWNER_TABS: Tab[] = ['members', 'settings', 'promotions', 'knowledge'];
const MEMBER_TABS: Tab[] = ['knowledge'];

const ROLE_OPTIONS: Role[] = ['viewer', 'editor', 'owner'];

// ---- Overlay state ------------------------------------------------------------

let overlay: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let adminOrgId = 0;
let activeTab: Tab = 'members';

let members: OrgMember[] = [];
let invitations: Invitation[] = [];
let promotions: PromotionRequest[] = [];
let orgRow: { id: number; name: string; slug: string; status: 'active' | 'suspended' } | null = null;
let settings: OrgSettings | null = null;

let membersLoading = false;
let promotionsLoading = false;
let settingsLoading = false;

/** Inline refusals (last-owner 409s, already-member invites, …). */
let membersError: string | null = null;
let inviteError: string | null = null;
let promotionsError: string | null = null;
/** Settings knob → its rejected-save message (field-level 400s). */
let settingsErrors: Partial<Record<string, string>> = {};

// Promotion preview: the expanded request row and its loaded content.
interface PreviewState {
  kind: 'markdown' | 'text' | 'binary' | 'missing' | 'error';
  content?: string;
}
let openPreviewId: number | null = null;
const previews = new Map<number, PreviewState>();

// Knowledge tab (issue #65): the catalog merged with this org's state.
let knowledge: KnowledgePackage<OrgKnowledgeItem>[] | null = null;
let knowledgeLoading = false;
let knowledgeError: string | null = null;
/** A selection PUT / reimport is in flight — controls disabled meanwhile. */
let knowledgeBusy = false;
const expandedPackages = new Set<string>();
let stopKnowledgeFeed: (() => void) | null = null;

// Close (or refresh) the overlay when roles change under us: api.ts raises
// `kuhn:role-refresh` on guard-shaped 403s and workspace re-emits 'orgs'.
workspace.subscribe((change) => {
  if (!overlay || overlay.hidden) return;
  if (workspace.activeOrgRole() == null || workspace.activeOrg()?.id !== adminOrgId) {
    closeOrgAdmin();
    return;
  }
  // Demoted from owner while open → only the Knowledge tab remains legal.
  if (!workspace.isOwner() && activeTab !== 'knowledge') {
    activeTab = 'knowledge';
  }
  if (change === 'orgs') render();
});

function ensureOverlay(): HTMLElement {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'org-admin';
  overlay.className = 'admin-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Organization admin');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOrgAdmin();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay!.hidden) closeOrgAdmin();
  });
  document.body.append(overlay);
  return overlay;
}

export function openOrgAdmin(initialTab: Tab = 'members'): void {
  const org = workspace.activeOrg();
  // Any member may open (issue #65: read-only Knowledge for non-owners);
  // owner-only tabs and their fetches stay gated below.
  if (!org || workspace.activeOrgRole() == null) return;
  const owner = workspace.isOwner();
  const root = ensureOverlay();
  const wasHidden = root.hidden;
  root.hidden = false;

  adminOrgId = org.id;
  activeTab = owner ? initialTab : 'knowledge';
  members = [];
  invitations = [];
  promotions = [];
  orgRow = null;
  settings = null;
  membersError = null;
  inviteError = null;
  promotionsError = null;
  settingsErrors = {};
  openPreviewId = null;
  previews.clear();
  knowledge = null;
  knowledgeError = null;
  knowledgeBusy = false;
  expandedPackages.clear();

  render();
  if (owner) {
    void reloadMembers();
    void reloadInvitations();
    void reloadSettings();
    void reloadPromotions(); // eager: the tab badge counts pending requests
  }
  void reloadKnowledge();

  // Live import status for the Knowledge tab: doc_status events land on the
  // shared org feed; a poll tick (feed down) refetches the merged state.
  stopKnowledgeFeed?.();
  stopKnowledgeFeed = addOrgFeedListener(org.id, (event) => {
    if (!knowledge) return;
    if (event.type === 'poll') {
      void reloadKnowledge();
      return;
    }
    const item = knowledge.flatMap((p) => p.items).find((i) => i.doc_id === event.docId);
    if (!item) return;
    item.doc_status = event.status;
    item.doc_status_detail = event.statusDetail ?? null;
    if (activeTab === 'knowledge') render();
  });

  if (wasHidden) {
    releaseFocus?.();
    releaseFocus = trapFocus(root);
  }
}

export function closeOrgAdmin(): void {
  if (overlay) overlay.hidden = true;
  stopKnowledgeFeed?.();
  stopKnowledgeFeed = null;
  releaseFocus?.(); // restores focus to the opener
  releaseFocus = null;
}

// ---- Data loading ---------------------------------------------------------------

async function reloadMembers(): Promise<void> {
  const orgId = adminOrgId;
  membersLoading = members.length === 0;
  render();
  try {
    const rows = await listOrgMembers(orgId);
    if (orgId !== adminOrgId) return; // superseded by a reopen on another org
    members = rows;
  } catch (err) {
    membersError = (err as Error).message;
  } finally {
    membersLoading = false;
  }
  render();
}

async function reloadInvitations(): Promise<void> {
  const orgId = adminOrgId;
  try {
    const rows = await listInvitations(orgId);
    if (orgId !== adminOrgId) return;
    invitations = rows;
  } catch (err) {
    inviteError = (err as Error).message;
  }
  render();
}

async function reloadSettings(): Promise<void> {
  const orgId = adminOrgId;
  settingsLoading = settings === null;
  render();
  try {
    const res = await getOrgSettings(orgId);
    if (orgId !== adminOrgId) return;
    orgRow = res.org;
    settings = res.settings;
  } catch (err) {
    settingsErrors = { _load: (err as Error).message };
  } finally {
    settingsLoading = false;
  }
  render();
}

async function reloadPromotions(): Promise<void> {
  const orgId = adminOrgId;
  promotionsLoading = promotions.length === 0;
  render();
  try {
    const rows = await listPromotions(orgId, 'pending');
    if (orgId !== adminOrgId) return;
    promotions = rows;
  } catch (err) {
    promotionsError = (err as Error).message;
  } finally {
    promotionsLoading = false;
  }
  render();
}

async function reloadKnowledge(): Promise<void> {
  const orgId = adminOrgId;
  knowledgeLoading = knowledge === null;
  render();
  try {
    const packages = await getOrgKnowledge(orgId);
    if (orgId !== adminOrgId) return;
    knowledge = packages;
    knowledgeError = null;
  } catch (err) {
    knowledgeError = (err as Error).message;
  } finally {
    knowledgeLoading = false;
  }
  render();
}

// ---- Shared bits ---------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function roleSelect(current: Role, options: Role[] = ROLE_OPTIONS): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'pb-select';
  for (const role of options) {
    const opt = document.createElement('option');
    opt.value = role;
    opt.textContent = role;
    opt.selected = role === current;
    select.append(opt);
  }
  return select;
}

function inlineError(message: string | null): HTMLElement {
  const el = document.createElement('div');
  el.className = 'admin-inline-error';
  el.setAttribute('role', 'alert');
  if (message) el.textContent = message;
  else el.hidden = true;
  return el;
}

function sectionTitle(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'admin-section-title';
  el.textContent = text;
  return el;
}

function emptyRow(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'admin-empty';
  el.setAttribute('role', 'status');
  el.textContent = text;
  return el;
}

// ---- Members tab ---------------------------------------------------------------

async function changeMemberRole(member: OrgMember, role: Role, select: HTMLSelectElement): Promise<void> {
  select.disabled = true;
  try {
    await updateMemberRole(adminOrgId, member.user_id, role);
    membersError = null;
    toast(`${member.display_name || member.email} is now ${role === 'owner' ? 'an owner' : `a${role === 'editor' ? 'n editor' : ' viewer'}`}`);
  } catch (err) {
    // 409 last_owner (and anything else) lands inline; the select reverts.
    membersError = (err as Error).message;
  }
  await reloadMembers();
}

async function removeMember(member: OrgMember): Promise<void> {
  // Documented exception (story 005-004): native confirm() is accessible by
  // construction; the file manager's delete uses the same pattern.
  const name = member.display_name || member.email;
  if (!window.confirm(`Remove ${name} from ${orgName()}?`)) return;
  try {
    await removeOrgMember(adminOrgId, member.user_id);
    membersError = null;
    toast(`Removed ${name}`);
  } catch (err) {
    membersError = (err as Error).message;
  }
  await reloadMembers();
}

async function sendInvitation(email: string, role: Role): Promise<boolean> {
  try {
    await createInvitation(adminOrgId, email, role);
    inviteError = null;
    toast(`Invitation sent to ${email}`);
  } catch (err) {
    inviteError = (err as Error).message;
    render();
    return false;
  }
  await reloadInvitations();
  return true;
}

async function revokePendingInvitation(inv: Invitation): Promise<void> {
  try {
    await revokeInvitation(adminOrgId, inv.id);
    inviteError = null;
    toast(`Revoked the invitation to ${inv.email}`);
  } catch (err) {
    inviteError = (err as Error).message;
  }
  await reloadInvitations();
}

function membersTable(): HTMLElement {
  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML =
    '<thead><tr><th scope="col">Member</th><th scope="col">Role</th><th></th></tr></thead>';
  const body = document.createElement('tbody');
  for (const member of members) {
    const tr = document.createElement('tr');

    const who = document.createElement('td');
    const name = document.createElement('div');
    name.className = 'admin-member-name';
    name.textContent = member.display_name || member.email;
    who.append(name);
    if (member.display_name) {
      const email = document.createElement('div');
      email.className = 'admin-member-email';
      email.textContent = member.email;
      who.append(email);
    }

    const roleCell = document.createElement('td');
    const select = roleSelect(member.role);
    select.setAttribute('aria-label', `Role of ${member.email}`);
    select.addEventListener('change', () => {
      void changeMemberRole(member, select.value as Role, select);
    });
    roleCell.append(select);

    const actions = document.createElement('td');
    actions.className = 'admin-row-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-quiet btn-sm';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${member.email} from the organization`);
    remove.addEventListener('click', () => void removeMember(member));
    actions.append(remove);

    tr.append(who, roleCell, actions);
    body.append(tr);
  }
  table.append(body);
  return table;
}

function inviteForm(): HTMLElement {
  const form = document.createElement('form');
  form.className = 'admin-form-row';

  const email = document.createElement('input');
  email.type = 'email';
  email.required = true;
  email.placeholder = 'colleague@example.org';
  email.className = 'pb-input';
  email.setAttribute('aria-label', 'Email to invite');

  // Prefilled from the org's default_member_role knob (011-002).
  const role = roleSelect(settings?.default_member_role ?? 'editor');
  role.setAttribute('aria-label', 'Role for the invitation');

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-accent btn-sm';
  submit.textContent = 'Send invitation';

  form.append(email, role, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = email.value.trim();
    if (!value) return;
    submit.disabled = true;
    void sendInvitation(value, role.value as Role).then((ok) => {
      submit.disabled = false;
      if (ok) email.value = '';
    });
  });
  return form;
}

function invitationsTable(): HTMLElement {
  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML =
    '<thead><tr><th scope="col">Invited</th><th scope="col">Role</th>' +
    '<th scope="col">State</th><th scope="col">Expires</th><th></th></tr></thead>';
  const body = document.createElement('tbody');
  for (const inv of invitations) {
    const tr = document.createElement('tr');

    const email = document.createElement('td');
    email.textContent = inv.email;

    const role = document.createElement('td');
    const roleBadge = document.createElement('span');
    roleBadge.className = `role-badge is-${inv.role}`;
    roleBadge.textContent = inv.role;
    role.append(roleBadge);

    const state = document.createElement('td');
    const stateBadge = document.createElement('span');
    stateBadge.className = `status-badge is-${inv.state}`;
    stateBadge.textContent = inv.state;
    state.append(stateBadge);

    const expires = document.createElement('td');
    expires.className = 'admin-member-email';
    expires.textContent = formatDate(inv.expires_at);

    const actions = document.createElement('td');
    actions.className = 'admin-row-actions';
    if (inv.state === 'pending') {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'btn btn-quiet btn-sm';
      revoke.textContent = 'Revoke';
      revoke.setAttribute('aria-label', `Revoke the invitation to ${inv.email}`);
      revoke.addEventListener('click', () => void revokePendingInvitation(inv));
      actions.append(revoke);
    }

    tr.append(email, role, state, expires, actions);
    body.append(tr);
  }
  table.append(body);
  return table;
}

function membersTab(): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (membersError) parts.push(inlineError(membersError));
  if (membersLoading) {
    parts.push(emptyRow('Loading members…'));
  } else if (members.length === 0) {
    parts.push(emptyRow('No members yet.'));
  } else {
    parts.push(membersTable());
  }

  parts.push(sectionTitle('Invite someone'));
  parts.push(inviteForm());
  if (inviteError) parts.push(inlineError(inviteError));

  if (invitations.length > 0) {
    parts.push(sectionTitle('Invitations'));
    parts.push(invitationsTable());
  }
  return parts;
}

// ---- Settings tab ---------------------------------------------------------------

function orgName(): string {
  return orgRow?.name ?? workspace.activeOrg()?.name ?? '';
}

/**
 * Persist one settings key (or the display name). Patching per-knob keeps the
 * backend's field-level 400s naturally attached to the control that caused
 * them; `onDone(true)` means saved.
 */
async function saveSetting(field: string, patch: Parameters<typeof updateOrgSettings>[1]): Promise<boolean> {
  try {
    const res = await updateOrgSettings(adminOrgId, patch);
    orgRow = res.org;
    settings = res.settings;
    delete settingsErrors[field];
    return true;
  } catch (err) {
    settingsErrors[field] = (err as Error).message;
    return false;
  } finally {
    render();
  }
}

function settingRow(
  label: string,
  hint: string,
  field: string,
  control: HTMLElement,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'admin-setting';
  const row = document.createElement('div');
  row.className = 'admin-form-row';
  const labelEl = document.createElement('label');
  labelEl.className = 'admin-setting-label';
  labelEl.textContent = label;
  const id = `admin-setting-${field}`;
  control.id = id;
  labelEl.htmlFor = id;
  row.append(labelEl, control);
  const hintEl = document.createElement('div');
  hintEl.className = 'admin-setting-hint';
  hintEl.textContent = hint;
  wrap.append(row, hintEl);
  const error = settingsErrors[field];
  if (error) wrap.append(inlineError(error));
  return wrap;
}

function settingsTab(): HTMLElement[] {
  if (settingsLoading || !settings) {
    const failed = settingsErrors['_load'];
    return [failed ? inlineError(failed) : emptyRow('Loading settings…')];
  }
  const parts: HTMLElement[] = [];

  // Display name — owners rename their own org here (fork F1); the slug is
  // immutable everywhere.
  const nameRow = document.createElement('form');
  nameRow.className = 'admin-form-row';
  const nameInput = document.createElement('input');
  nameInput.className = 'pb-input';
  nameInput.required = true;
  nameInput.value = orgName();
  nameInput.id = 'admin-setting-name';
  nameInput.setAttribute('aria-label', 'Organization name');
  const nameSave = document.createElement('button');
  nameSave.type = 'submit';
  nameSave.className = 'btn btn-ghost btn-sm';
  nameSave.textContent = 'Rename';
  nameRow.append(nameInput, nameSave);
  nameRow.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name || name === orgName()) return;
    nameSave.disabled = true;
    void saveSetting('name', { name }).then((ok) => {
      if (ok) toast(`Renamed to ${name}`);
    });
  });
  const nameWrap = document.createElement('div');
  nameWrap.className = 'admin-setting';
  const nameLabel = document.createElement('label');
  nameLabel.className = 'admin-setting-label';
  nameLabel.textContent = 'Organization name';
  nameLabel.htmlFor = nameInput.id;
  const slugHint = document.createElement('div');
  slugHint.className = 'admin-setting-hint';
  slugHint.textContent = `Workspace id: ${orgRow?.slug ?? ''} (immutable)`;
  nameWrap.append(nameLabel, nameRow, slugHint);
  const nameError = settingsErrors['name'];
  if (nameError) nameWrap.append(inlineError(nameError));
  parts.push(nameWrap);

  // default_member_role
  const defaultRole = roleSelect(settings.default_member_role, ['viewer', 'editor']);
  defaultRole.className = 'pb-select';
  defaultRole.addEventListener('change', () => {
    void saveSetting('default_member_role', {
      default_member_role: defaultRole.value as OrgSettings['default_member_role'],
    });
  });
  parts.push(settingRow(
    'Default member role',
    'Prefills the invitation form and applies to auto-joined dev identities.',
    'default_member_role',
    defaultRole,
  ));

  // library_seeding
  const seeding = document.createElement('input');
  seeding.type = 'checkbox';
  seeding.checked = settings.library_seeding;
  seeding.addEventListener('change', () => {
    void saveSetting('library_seeding', { library_seeding: seeding.checked });
  });
  parts.push(settingRow(
    'Offer library seeding',
    'Offer the library-seeding step when this organization is set up.',
    'library_seeding',
    seeding,
  ));

  // promotion_policy
  const policy = document.createElement('select');
  policy.className = 'pb-select';
  for (const value of ['approval-required', 'direct'] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value === 'direct' ? 'Direct — editors promote immediately' : 'Approval required — owners review suggestions';
    opt.selected = settings.promotion_policy === value;
    policy.append(opt);
  }
  policy.addEventListener('change', () => {
    void saveSetting('promotion_policy', {
      promotion_policy: policy.value as OrgSettings['promotion_policy'],
    });
  });
  parts.push(settingRow(
    'Library promotions',
    'How an editor’s "promote to org library" is handled. Owners always promote directly.',
    'promotion_policy',
    policy,
  ));

  // Reserved: spend ceilings (story 009-003).
  const reserved = document.createElement('fieldset');
  reserved.className = 'admin-reserved';
  reserved.disabled = true;
  const legend = document.createElement('legend');
  legend.className = 'admin-section-title';
  legend.textContent = 'Spend ceilings';
  const note = document.createElement('div');
  note.className = 'admin-setting-hint';
  note.textContent = 'Coming with story 009-003 — per-org model spend limits.';
  const ceiling = document.createElement('input');
  ceiling.className = 'pb-input';
  ceiling.placeholder = 'Monthly ceiling (USD)';
  ceiling.disabled = true;
  reserved.append(legend, note, ceiling);
  parts.push(reserved);

  return parts;
}

// ---- Promotions tab --------------------------------------------------------------

const MARKDOWN_EXTS = new Set(['md', 'markdown']);
const TEXT_EXTS = new Set(['txt', 'csv', 'json', 'bib', 'tex', 'yaml', 'yml', 'html', 'log']);

function extOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

async function loadPreview(request: PromotionRequest): Promise<void> {
  const ext = extOf(request.path);
  if (!MARKDOWN_EXTS.has(ext) && !TEXT_EXTS.has(ext)) {
    previews.set(request.id, { kind: 'binary' });
    render();
    return;
  }
  try {
    const content = await readTextFile(request.project_id, request.path);
    previews.set(
      request.id,
      content === null
        ? { kind: 'missing' }
        : { kind: MARKDOWN_EXTS.has(ext) ? 'markdown' : 'text', content },
    );
  } catch (err) {
    previews.set(request.id, { kind: 'error', content: (err as Error).message });
  }
  render();
}

function togglePreview(request: PromotionRequest): void {
  if (openPreviewId === request.id) {
    openPreviewId = null;
    render();
    return;
  }
  openPreviewId = request.id;
  if (!previews.has(request.id)) {
    render(); // show the loading state while the fetch runs
    void loadPreview(request);
  } else {
    render();
  }
}

function previewEl(request: PromotionRequest): HTMLElement {
  const box = document.createElement('div');
  box.className = 'admin-preview';
  const state = previews.get(request.id);
  if (!state) {
    box.className += ' admin-empty';
    box.textContent = 'Loading preview…';
    return box;
  }
  switch (state.kind) {
    case 'markdown': {
      const rendered = document.createElement('div');
      rendered.className = 'admin-preview-md';
      rendered.innerHTML = marked.parse(state.content ?? '', { async: false });
      box.append(rendered);
      break;
    }
    case 'text': {
      const pre = document.createElement('pre');
      pre.className = 'admin-preview-text';
      pre.textContent = state.content ?? '';
      box.append(pre);
      break;
    }
    case 'binary': {
      const link = document.createElement('a');
      link.className = 'btn btn-ghost btn-sm';
      link.href = fileBlobUrl(request.project_id, request.path);
      link.download = request.path.split('/').pop() ?? request.path;
      link.textContent = 'Download to preview';
      box.append(link);
      break;
    }
    case 'missing':
      box.append(inlineError('The file no longer exists at that path.'));
      break;
    case 'error':
      box.append(inlineError(`Could not load the file: ${state.content ?? 'unknown error'}`));
      break;
  }
  return box;
}

async function decidePromotion(request: PromotionRequest, decision: 'approve' | 'reject'): Promise<void> {
  // Native prompt, same accessibility rationale as confirm() above. Cancel
  // aborts the decision; an empty note is a decision without one.
  const note = window.prompt(
    decision === 'approve'
      ? 'Optional note for the approval (leave blank for none):'
      : 'Optional note explaining the rejection (leave blank for none):',
    '',
  );
  if (note === null) return;
  try {
    const decide = decision === 'approve' ? approvePromotion : rejectPromotion;
    await decide(adminOrgId, request.id, note.trim() || undefined);
    promotionsError = null;
    toast(
      decision === 'approve'
        ? `Promoted ${request.path.split('/').pop()} to the org library`
        : `Rejected the suggestion for ${request.path.split('/').pop()}`,
    );
  } catch (err) {
    // e.g. 409 "file no longer exists at that path" on approve, or a
    // concurrent owner already decided the row.
    promotionsError = (err as ApiError).message;
  }
  if (openPreviewId === request.id) openPreviewId = null;
  previews.delete(request.id);
  await reloadPromotions();
}

function promotionRow(request: PromotionRequest): HTMLElement {
  const row = document.createElement('div');
  row.className = 'admin-promo-row';

  const head = document.createElement('div');
  head.className = 'admin-promo-head';

  const body = document.createElement('div');
  body.className = 'admin-promo-body';
  const path = document.createElement('div');
  path.className = 'admin-promo-path';
  path.textContent = request.path;
  const meta = document.createElement('div');
  meta.className = 'admin-promo-meta';
  const suggester = request.suggested_by_email ?? 'unknown';
  meta.textContent = `${request.project_name} · suggested by ${suggester} · ${formatDate(request.created_at)}`;
  body.append(path, meta);
  if (request.note) {
    const note = document.createElement('div');
    note.className = 'admin-promo-note';
    note.textContent = `“${request.note}”`;
    body.append(note);
  }

  const actions = document.createElement('div');
  actions.className = 'admin-actions';
  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'btn btn-quiet btn-sm';
  preview.textContent = openPreviewId === request.id ? 'Hide preview' : 'Preview';
  preview.addEventListener('click', () => togglePreview(request));
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'btn btn-accent btn-sm';
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => void decidePromotion(request, 'approve'));
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'btn btn-ghost btn-sm';
  reject.textContent = 'Reject';
  reject.addEventListener('click', () => void decidePromotion(request, 'reject'));
  actions.append(preview, approve, reject);

  head.append(body, actions);
  row.append(head);
  if (openPreviewId === request.id) row.append(previewEl(request));
  return row;
}

function promotionsTab(): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (promotionsError) parts.push(inlineError(promotionsError));
  if (promotionsLoading) {
    parts.push(emptyRow('Loading suggestions…'));
  } else if (promotions.length === 0) {
    parts.push(emptyRow('No pending suggestions. Editors’ "promote to org library" requests land here for review.'));
  } else {
    for (const request of promotions) parts.push(promotionRow(request));
  }
  return parts;
}

// ---- Knowledge tab (issue #65) ----------------------------------------------------

/** Apply a selection change and adopt the merged state the API returns. */
async function applyKnowledgeChanges(changes: { enable?: string[]; disable?: string[] }): Promise<void> {
  knowledgeBusy = true;
  render();
  try {
    knowledge = await putKnowledgeSelections(adminOrgId, changes);
    knowledgeError = null;
    const enabled = changes.enable?.length ?? 0;
    const disabled = changes.disable?.length ?? 0;
    if (enabled > 0) toast(`Enabled ${enabled} knowledge item${enabled === 1 ? '' : 's'} — importing`);
    else if (disabled > 0) toast(`Removed ${disabled} knowledge item${disabled === 1 ? '' : 's'}`);
  } catch (err) {
    knowledgeError = (err as Error).message;
  } finally {
    knowledgeBusy = false;
  }
  void refreshLibraryHint(adminOrgId);
  render();
}

async function reimportItems(itemIds: string[]): Promise<void> {
  knowledgeBusy = true;
  render();
  try {
    knowledge = await reimportKnowledgeItems(adminOrgId, itemIds);
    knowledgeError = null;
    toast(`Re-importing ${itemIds.length} item${itemIds.length === 1 ? '' : 's'}`);
  } catch (err) {
    knowledgeError = (err as Error).message;
  } finally {
    knowledgeBusy = false;
  }
  render();
}

const toggleableItems = (pkg: KnowledgePackage<OrgKnowledgeItem>): OrgKnowledgeItem[] =>
  pkg.items.filter((i) => i.available);

/** Import-status element for an enabled item; mirrors org-library's statusEl. */
function knowledgeStatusEl(item: OrgKnowledgeItem): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `ol-status is-${item.doc_status ?? 'pending'}`;
  wrap.setAttribute('role', 'status');
  if (item.doc_status === 'ready') {
    wrap.innerHTML = `${icon('check', { size: 13, stroke: 2 })}<span>Searchable</span>`;
  } else if (item.doc_status === 'failed') {
    wrap.innerHTML = `${icon('x', { size: 13, stroke: 2 })}<span></span>`;
    (wrap.querySelector('span:last-child') as HTMLElement).textContent =
      `Failed — ${item.doc_status_detail || 'could not process this item'}`;
  } else {
    const spinner = document.createElement('span');
    spinner.className = 'file-spinner';
    const label = document.createElement('span');
    label.textContent = item.doc_status === 'ingesting' ? 'Processing…' : 'Importing…';
    wrap.append(spinner, label);
  }
  return wrap;
}

function knowledgeItemRow(item: OrgKnowledgeItem, owner: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'kn-item';
  row.dataset.itemId = item.id;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'kn-check';
  check.checked = item.enabled;
  check.disabled = !owner || !item.available || knowledgeBusy;
  check.setAttribute('aria-label', `${item.enabled ? 'Disable' : 'Enable'} ${item.title}`);
  check.addEventListener('change', () => {
    void applyKnowledgeChanges(check.checked ? { enable: [item.id] } : { disable: [item.id] });
  });

  const body = document.createElement('div');
  body.className = 'kn-item-body';

  const name = document.createElement('div');
  name.className = 'kn-item-name';
  name.textContent = item.title;
  const kindBadge = document.createElement('span');
  kindBadge.className = `kn-kind is-${item.kind}`;
  kindBadge.textContent = item.kind === 'document' ? 'doc' : 'card';
  kindBadge.title = item.kind === 'document'
    ? 'Full document, vendored in the Kuhn library'
    : 'Kuhn-authored summary card with a link to the canonical source';
  name.append(kindBadge);
  if (item.update_available) {
    const pill = document.createElement('span');
    pill.className = 'kn-update';
    pill.textContent = 'Update available';
    name.append(pill);
  }

  const meta = document.createElement('div');
  meta.className = 'kn-item-meta';
  const metaParts: (HTMLElement | string)[] = [];
  if (item.license) metaParts.push(item.license);
  if (!item.available) metaParts.push('Unavailable in this deployment');
  if (item.source_url) {
    const link = document.createElement('a');
    link.href = item.source_url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.className = 'kn-source';
    link.textContent = 'Source';
    link.setAttribute('aria-label', `Canonical source of ${item.title}`);
    metaParts.push(link);
  }
  metaParts.forEach((part, i) => {
    if (i > 0) meta.append(' · ');
    meta.append(part);
  });

  body.append(name, meta);
  if (item.enabled) body.append(knowledgeStatusEl(item));

  row.append(check, body);

  if (owner && item.enabled && (item.update_available || item.doc_status === 'failed')) {
    const reimport = document.createElement('button');
    reimport.type = 'button';
    reimport.className = 'btn btn-quiet btn-sm kn-reimport';
    reimport.textContent = 'Re-import';
    reimport.disabled = knowledgeBusy;
    reimport.setAttribute('aria-label', `Re-import ${item.title}`);
    reimport.addEventListener('click', () => void reimportItems([item.id]));
    row.append(reimport);
  }
  return row;
}

function knowledgePackageBlock(
  pkg: KnowledgePackage<OrgKnowledgeItem>,
  owner: boolean,
  nested: boolean,
): HTMLElement {
  const block = document.createElement('div');
  block.className = `kn-pkg${nested ? ' kn-pkg-nested' : ''}`;
  block.dataset.packageId = pkg.id;

  const head = document.createElement('div');
  head.className = 'kn-pkg-head';

  // Tri-state package checkbox over its own direct items (sub-packages are
  // independent toggles — spec §10.3).
  const toggleable = toggleableItems(pkg);
  const enabledCount = toggleable.filter((i) => i.enabled).length;
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'kn-check kn-pkg-check';
  check.checked = toggleable.length > 0 && enabledCount === toggleable.length;
  check.indeterminate = enabledCount > 0 && enabledCount < toggleable.length;
  check.disabled = !owner || toggleable.length === 0 || knowledgeBusy;
  check.setAttribute('aria-label', `${check.checked ? 'Disable' : 'Enable'} every item in ${pkg.title}`);
  if (check.indeterminate) check.setAttribute('aria-checked', 'mixed');
  check.addEventListener('change', () => {
    const ids = toggleable.map((i) => i.id);
    void applyKnowledgeChanges(check.checked ? { enable: ids } : { disable: ids });
  });

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'kn-pkg-toggle';
  const expanded = expandedPackages.has(pkg.id);
  expand.setAttribute('aria-expanded', String(expanded));
  const title = document.createElement('span');
  title.className = 'kn-pkg-title';
  title.textContent = pkg.title;
  const count = document.createElement('span');
  count.className = 'kn-pkg-count';
  count.textContent = pkg.items.length === 0
    ? 'no items yet'
    : `${enabledCount}/${toggleable.length} enabled`;
  const chevron = document.createElement('span');
  chevron.className = `kn-pkg-chevron${expanded ? ' is-open' : ''}`;
  chevron.innerHTML = icon('chevron-down', { size: 13, stroke: 2 });
  expand.append(chevron, title, count);
  expand.addEventListener('click', () => {
    if (expandedPackages.has(pkg.id)) expandedPackages.delete(pkg.id);
    else expandedPackages.add(pkg.id);
    render();
  });

  head.append(check, expand);
  block.append(head);

  if (pkg.description) {
    const desc = document.createElement('div');
    desc.className = 'kn-pkg-desc';
    desc.textContent = pkg.description;
    block.append(desc);
  }

  if (expanded) {
    const list = document.createElement('div');
    list.className = 'kn-item-list';
    for (const item of pkg.items) list.append(knowledgeItemRow(item, owner));
    block.append(list);
  }
  return block;
}

function knowledgeTab(): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (knowledgeError) parts.push(inlineError(knowledgeError));
  if (knowledgeLoading || knowledge === null) {
    if (!knowledgeError) parts.push(emptyRow('Loading the knowledge catalog…'));
    return parts;
  }
  if (knowledge.length === 0) {
    parts.push(emptyRow('The Kuhn knowledge catalog is empty in this deployment.'));
    return parts;
  }

  const owner = workspace.isOwner();
  const blurb = document.createElement('p');
  blurb.className = 'ol-blurb';
  blurb.textContent = owner
    ? 'Curated packages of reporting standards, regulatory guidance, and style references. ' +
      'Enabled items are imported into this organization’s library and become searchable by agents.'
    : 'Knowledge packages this organization has enabled. Only owners can change the selection.';
  parts.push(blurb);

  const tree = document.createElement('div');
  tree.className = 'kn-tree';
  const children = new Map<string, KnowledgePackage<OrgKnowledgeItem>[]>();
  for (const pkg of knowledge) {
    if (pkg.parent) {
      if (!children.has(pkg.parent)) children.set(pkg.parent, []);
      children.get(pkg.parent)!.push(pkg);
    }
  }
  for (const pkg of knowledge) {
    if (pkg.parent) continue;
    if (!pkg.available && pkg.items.length === 0) continue; // private/absent content
    tree.append(knowledgePackageBlock(pkg, owner, false));
    for (const child of children.get(pkg.id) ?? []) {
      tree.append(knowledgePackageBlock(child, owner, true));
    }
  }
  parts.push(tree);
  return parts;
}

// ---- Render ----------------------------------------------------------------------

const TAB_LABEL: Record<Tab, string> = {
  members: 'Members',
  settings: 'Settings',
  promotions: 'Promotions',
  knowledge: 'Knowledge',
};

function tabsBar(): HTMLElement {
  const tabs = document.createElement('div');
  tabs.className = 'admin-tabs';
  tabs.setAttribute('role', 'tablist');
  for (const tab of workspace.isOwner() ? OWNER_TABS : MEMBER_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-tab';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(tab === activeTab));
    if (tab === activeTab) btn.classList.add('is-active');
    btn.textContent = TAB_LABEL[tab];
    if (tab === 'promotions' && promotions.length > 0) {
      const count = document.createElement('span');
      count.className = 'admin-tab-count';
      count.textContent = String(promotions.length);
      btn.append(count);
    }
    if (tab === 'knowledge') {
      const updates = knowledge?.flatMap((p) => p.items)
        .filter((i) => i.update_available || i.doc_status === 'failed').length ?? 0;
      if (updates > 0) {
        const count = document.createElement('span');
        count.className = 'admin-tab-count';
        count.textContent = String(updates);
        btn.append(count);
      }
    }
    btn.addEventListener('click', () => {
      if (activeTab === tab) return;
      activeTab = tab;
      render();
    });
    tabs.append(btn);
  }
  return tabs;
}

function render(): void {
  const root = ensureOverlay();
  if (root.hidden) return;

  const panel = document.createElement('div');
  panel.className = 'admin-panel';

  const head = document.createElement('header');
  head.className = 'pb-head';
  const heading = document.createElement('div');
  heading.innerHTML = `<div class="pb-eyebrow">Organization admin</div><h2 class="pb-org"></h2>`;
  (heading.querySelector('.pb-org') as HTMLElement).textContent = orgName();
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pb-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icon('x', { size: 16, stroke: 2 });
  closeBtn.addEventListener('click', () => closeOrgAdmin());
  head.append(heading, closeBtn);

  const body = document.createElement('div');
  body.className = 'admin-body';
  const parts =
    activeTab === 'members' ? membersTab()
    : activeTab === 'settings' ? settingsTab()
    : activeTab === 'promotions' ? promotionsTab()
    : knowledgeTab();
  body.append(...parts);

  panel.append(head, tabsBar(), body);
  root.replaceChildren(panel);
}
