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

import {
  ApiError,
  approvePromotion,
  approveScriptPromotion,
  createInvitation,
  fileBlobUrl,
  getOrgAgentPrompts,
  getOrgKnowledge,
  getOrgScript,
  getOrgScripts,
  getOrgSlideThemes,
  getOrgSettings,
  getScriptPromotion,
  importCatalogScripts,
  listInvitations,
  listOrgMembers,
  listPromotions,
  listScriptPromotions,
  putKnowledgeSelections,
  putOrgAgentPrompt,
  readTextFile,
  reimportCatalogScripts,
  reimportKnowledgeItems,
  rejectPromotion,
  rejectScriptPromotion,
  removeOrgMember,
  revokeInvitation,
  setOrgScriptStatus,
  setOrgSlideThemeStatus,
  uploadOrgSlideTheme,
  updateMemberRole,
  updateOrgSettings,
  type Invitation,
  type KnowledgePackage,
  type OrgAgentPrompt,
  type OrgKnowledgeItem,
  type OrgMember,
  type OrgScriptsPayload,
  type OrgSlideThemesPayload,
  type OrgSettings,
  type PromotionRequest,
  type ScriptPromotion,
  type ScriptVersionInfo,
  type Role,
  listOrgSecrets,
  putOrgSecret,
  deleteOrgSecret,
  type OrgSecret,
} from './api';
import { trapFocus } from './a11y';
import { agentIdentity } from './agents';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { addOrgFeedListener, refreshLibraryHint } from './org-library';
import { toast } from './toast';
import * as workspace from './workspace';

type Tab = 'members' | 'settings' | 'promotions' | 'knowledge' | 'scripts' | 'secrets' | 'themes' | 'agents';

/** Owner-only tabs; non-owner members get the read-only Knowledge/Scripts/Agents tabs. */
const OWNER_TABS: Tab[] = ['members', 'settings', 'promotions', 'knowledge', 'scripts', 'secrets', 'themes', 'agents'];
const MEMBER_TABS: Tab[] = ['knowledge', 'scripts', 'secrets', 'themes', 'agents'];

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

// Scripts tab (issue #68): the shared-script library + owner review queue.
let scriptsData: OrgScriptsPayload | null = null;
let scriptsLoading = false;
let scriptsError: string | null = null;
/** A library write (import/status/reimport/decision) is in flight. */
let scriptsBusy = false;
let scriptPromotions: ScriptPromotion[] = [];
/** Expanded org script → its loaded content/versions. */
let openScriptId: number | null = null;
const scriptContents = new Map<number, { content: string; versions: ScriptVersionInfo[] }>();
/** Expanded promotion request → its loaded review payload. */
let openScriptReviewId: number | null = null;
type ScriptReview = Awaited<ReturnType<typeof getScriptPromotion>>;
const scriptReviews = new Map<number, ScriptReview>();

// Themes tab (STH-58): the Marp theme catalog + this org's uploaded themes.
let themesData: OrgSlideThemesPayload | null = null;
let themesLoading = false;
let themesError: string | null = null;
let themesBusy = false;

// Secrets tab (org secrets store): metadata only — values are write-only.
let secretsRows: OrgSecret[] | null = null;
let secretsLoading = false;
let secretsError: string | null = null;
let secretsBusy = false;

// Agents tab (issue #67): base prompts + this org's additions.
let agentPrompts: OrgAgentPrompt[] | null = null;
let agentPromptsMax = 4000;
let agentPromptsLoading = false;
let agentPromptsError: string | null = null;
/** Agent slug → its rejected-save message. */
let agentPromptErrors: Partial<Record<string, string>> = {};
/** Agent slug → a save is in flight. */
const agentPromptBusy = new Set<string>();
/** Agent slugs whose base prompt is expanded. */
const expandedBasePrompts = new Set<string>();

// Close (or refresh) the overlay when roles change under us: api.ts raises
// `kuhn:role-refresh` on guard-shaped 403s and workspace re-emits 'orgs'.
workspace.subscribe((change) => {
  if (!overlay || overlay.hidden) return;
  if (workspace.activeOrgRole() == null || workspace.activeOrg()?.id !== adminOrgId) {
    closeOrgAdmin();
    return;
  }
  // Demoted from owner while open → only the member tabs remain legal.
  if (!workspace.isOwner() && !MEMBER_TABS.includes(activeTab)) {
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
  agentPrompts = null;
  agentPromptsError = null;
  agentPromptErrors = {};
  agentPromptBusy.clear();
  expandedBasePrompts.clear();
  scriptsData = null;
  scriptsError = null;
  scriptsBusy = false;
  scriptPromotions = [];
  openScriptId = null;
  scriptContents.clear();
  openScriptReviewId = null;
  scriptReviews.clear();
  themesData = null;
  themesError = null;
  themesBusy = false;
  secretsRows = null;
  secretsError = null;
  secretsBusy = false;

  render();
  if (owner) {
    void reloadMembers();
    void reloadInvitations();
    void reloadSettings();
    void reloadPromotions(); // eager: the tab badge counts pending requests
  }
  void reloadKnowledge();
  void reloadAgentPrompts();
  void reloadScripts();
    void reloadThemes();
  void reloadSecrets();

  // Live import status for the Knowledge tab: doc_status events land on the
  // shared org feed; a poll tick (feed down) refetches the merged state.
  stopKnowledgeFeed?.();
  // The feed also carries ordinary library documents (uploads, promotions),
  // which never appear in the knowledge payload. Refetch at most once per
  // unknown docId: ids the refreshed payload still doesn't claim are foreign
  // — remember them so a colleague's bulk upload doesn't trigger a refetch
  // for every subsequent status transition.
  const foreignDocIds = new Set<number>();
  stopKnowledgeFeed = addOrgFeedListener(org.id, (event) => {
    if (!knowledge) return;
    if (event.type === 'poll') {
      void reloadKnowledge();
      return;
    }
    const item = knowledge.flatMap((p) => p.items).find((i) => i.doc_id === event.docId);
    if (!item) {
      if (foreignDocIds.has(event.docId)) return;
      foreignDocIds.add(event.docId); // also debounces while the refetch is in flight
      // A status event for a document this snapshot doesn't know yet — a fast
      // ingest can finish before the enable's refreshed payload is applied.
      // Refetch rather than drop what may be the terminal transition; if the
      // refreshed payload claims the doc it was ours after all, so forget it
      // and let later events apply normally.
      void reloadKnowledge().then(() => {
        if (knowledge?.some((p) => p.items.some((i) => i.doc_id === event.docId))) {
          foreignDocIds.delete(event.docId);
        }
      });
      return;
    }
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

async function reloadScripts(): Promise<void> {
  const orgId = adminOrgId;
  scriptsLoading = scriptsData === null;
  render();
  try {
    const [payload, pending] = await Promise.all([
      getOrgScripts(orgId),
      workspace.isOwner() ? listScriptPromotions(orgId, 'pending') : Promise.resolve([]),
    ]);
    if (orgId !== adminOrgId) return;
    scriptsData = payload;
    scriptPromotions = pending;
    scriptsError = null;
  } catch (err) {
    scriptsError = (err as Error).message;
  } finally {
    scriptsLoading = false;
  }
  render();
}

async function reloadThemes(): Promise<void> {
  const orgId = adminOrgId;
  themesLoading = themesData === null;
  render();
  try {
    const payload = await getOrgSlideThemes(orgId);
    if (orgId !== adminOrgId) return;
    themesData = payload;
    themesError = null;
  } catch (err) {
    themesError = (err as Error).message;
  } finally {
    themesLoading = false;
  }
  render();
}

async function reloadSecrets(): Promise<void> {
  const orgId = adminOrgId;
  secretsLoading = secretsRows === null;
  render();
  try {
    const rows = await listOrgSecrets(orgId);
    if (orgId !== adminOrgId) return;
    secretsRows = rows;
    secretsError = null;
  } catch (err) {
    secretsError = (err as Error).message;
  } finally {
    secretsLoading = false;
  }
  render();
}

async function reloadAgentPrompts(): Promise<void> {
  const orgId = adminOrgId;
  agentPromptsLoading = agentPrompts === null;
  render();
  try {
    const res = await getOrgAgentPrompts(orgId);
    if (orgId !== adminOrgId) return;
    agentPrompts = res.agents;
    agentPromptsMax = res.max_addition_chars;
    agentPromptsError = null;
  } catch (err) {
    agentPromptsError = (err as Error).message;
  } finally {
    agentPromptsLoading = false;
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
      rendered.innerHTML = renderMarkdown(state.content ?? '');
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
    // A failed batch stops at the first failing item, so earlier items may
    // have applied — re-sync with the server so checkboxes reflect reality.
    try { knowledge = await getOrgKnowledge(adminOrgId); } catch { /* keep stale */ }
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
    // Same partial-batch re-sync as applyKnowledgeChanges.
    try { knowledge = await getOrgKnowledge(adminOrgId); } catch { /* keep stale */ }
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

// ---- Scripts tab (issue #68) -----------------------------------------------------

/**
 * Minimal LCS line diff for the promotion review pane — dependency-light by
 * design (the webapp ships no diff library). Fine for the script sizes the
 * backend caps at 256 KB; O(n·m) on line counts.
 */
function lineDiff(before: string, after: string): { type: 'ctx' | 'del' | 'add'; text: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: { type: 'ctx' | 'del' | 'add'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      out.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}

function diffPane(before: string, after: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'ap-prompt sc-diff';
  for (const line of lineDiff(before, after)) {
    const el = document.createElement('div');
    el.className = `sc-diff-${line.type}`;
    el.textContent = `${line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '} ${line.text}`;
    pre.append(el);
  }
  return pre;
}

/** Run a library write; failures toast, success reloads the merged state. */
async function scriptAction(fn: () => Promise<unknown>, done?: string): Promise<void> {
  scriptsBusy = true;
  render();
  try {
    await fn();
    if (done) toast(done);
  } catch (err) {
    toast((err as Error).message);
  } finally {
    scriptsBusy = false;
  }
  await reloadScripts();
}

const LANGUAGE_LABEL: Record<string, string> = { r: 'R', python: 'Python' };

function scriptMetaChip(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'sc-chip';
  el.textContent = text;
  return el;
}

function scriptReviewBlock(request: ScriptPromotion): HTMLElement {
  const block = document.createElement('div');
  block.className = 'ap-card';

  const head = document.createElement('div');
  head.className = 'ap-head';
  const name = document.createElement('span');
  name.className = 'ap-name';
  name.textContent = request.title ?? request.path.split('/').pop() ?? request.path;
  head.append(name, scriptMetaChip(LANGUAGE_LABEL[request.language] ?? request.language));
  if (request.target_script_slug) {
    head.append(scriptMetaChip(`update of ${request.target_script_slug}`));
  }
  block.append(head);

  const meta = document.createElement('div');
  meta.className = 'admin-setting-hint';
  const by = request.suggested_by_email ? ` by ${request.suggested_by_email}` : '';
  meta.textContent = `${request.project_name} · ${request.path} — suggested ${formatDate(request.created_at)}${by}`;
  block.append(meta);
  if (request.note) {
    const note = document.createElement('div');
    note.className = 'admin-setting-hint';
    note.textContent = `Note: ${request.note}`;
    block.append(note);
  }

  const expanded = openScriptReviewId === request.id;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-ghost btn-sm ap-toggle';
  toggle.textContent = expanded ? 'Hide code' : 'Review code';
  toggle.addEventListener('click', () => {
    openScriptReviewId = expanded ? null : request.id;
    if (!expanded && !scriptReviews.has(request.id)) {
      void getScriptPromotion(adminOrgId, request.id)
        .then((review) => { scriptReviews.set(request.id, review); render(); })
        .catch((err) => { toast((err as Error).message); });
    }
    render();
  });
  block.append(toggle);

  if (expanded) {
    const review = scriptReviews.get(request.id);
    if (!review) {
      block.append(emptyRow('Loading code…'));
    } else if (review.content_error || review.content == null) {
      block.append(inlineError(review.content_error ?? 'The file could not be read.'));
    } else {
      if (review.target_content != null) {
        // Update proposal: show what would change against the current version.
        block.append(diffPane(review.target_content, review.content));
      } else {
        const pre = document.createElement('pre');
        pre.className = 'ap-prompt';
        pre.textContent = review.content;
        block.append(pre);
      }

      const controls = document.createElement('div');
      controls.className = 'ap-controls';
      let slugInput: HTMLInputElement | null = null;
      if (!request.target_script_id) {
        slugInput = document.createElement('input');
        slugInput.className = 'pb-input sc-slug';
        slugInput.setAttribute('aria-label', 'Script slug');
        const stem = (request.path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
        slugInput.value = stem.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
        controls.append(slugInput);
      }
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'btn btn-ghost btn-sm';
      approve.textContent = 'Approve';
      approve.disabled = scriptsBusy;
      approve.addEventListener('click', () => {
        // The sha the owner just reviewed rides along; the backend 409s if
        // the file changed since (and this row reverts to pending).
        void scriptAction(
          () => approveScriptPromotion(adminOrgId, request.id, review.sha256!, {
            slug: slugInput?.value.trim() || undefined,
          }),
          'Script added to the library',
        );
      });
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'btn btn-ghost btn-sm';
      reject.textContent = 'Reject';
      reject.disabled = scriptsBusy;
      reject.addEventListener('click', () => {
        void scriptAction(() => rejectScriptPromotion(adminOrgId, request.id), 'Suggestion rejected');
      });
      controls.append(approve, reject);
      block.append(controls);
    }
  }
  return block;
}

function orgScriptBlock(script: OrgScriptsPayload['scripts'][number], owner: boolean): HTMLElement {
  const block = document.createElement('div');
  block.className = 'ap-card';

  const head = document.createElement('div');
  head.className = 'ap-head';
  const name = document.createElement('span');
  name.className = 'ap-name';
  name.textContent = script.title;
  head.append(name,
    scriptMetaChip(script.slug),
    scriptMetaChip(LANGUAGE_LABEL[script.language] ?? script.language),
    scriptMetaChip(`v${script.current_version}`));
  if (script.status === 'disabled') head.append(scriptMetaChip('disabled'));
  if (script.update_available) {
    const chip = scriptMetaChip('update available');
    chip.classList.add('sc-chip-update');
    head.append(chip);
  }
  block.append(head);

  if (script.description) {
    const desc = document.createElement('div');
    desc.className = 'admin-setting-hint';
    desc.textContent = script.description;
    block.append(desc);
  }

  const controls = document.createElement('div');
  controls.className = 'ap-controls';
  const expanded = openScriptId === script.id;
  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'btn btn-ghost btn-sm';
  view.textContent = expanded ? 'Hide code' : 'View code';
  view.addEventListener('click', () => {
    openScriptId = expanded ? null : script.id;
    if (!expanded && !scriptContents.has(script.id)) {
      void getOrgScript(adminOrgId, script.id)
        .then((detail) => {
          scriptContents.set(script.id, { content: detail.content, versions: detail.versions });
          render();
        })
        .catch((err) => { toast((err as Error).message); });
    }
    render();
  });
  controls.append(view);
  if (owner) {
    if (script.update_available && script.catalog_script_id) {
      const update = document.createElement('button');
      update.type = 'button';
      update.className = 'btn btn-ghost btn-sm';
      update.textContent = 'Update from catalog';
      update.disabled = scriptsBusy;
      update.addEventListener('click', () => {
        scriptContents.delete(script.id);
        void scriptAction(
          () => reimportCatalogScripts(adminOrgId, [script.catalog_script_id!]),
          `${script.title} updated`,
        );
      });
      controls.append(update);
    }
    const toggleStatus = document.createElement('button');
    toggleStatus.type = 'button';
    toggleStatus.className = 'btn btn-ghost btn-sm';
    toggleStatus.textContent = script.status === 'active' ? 'Disable' : 'Enable';
    toggleStatus.disabled = scriptsBusy;
    toggleStatus.addEventListener('click', () => {
      void scriptAction(
        () => setOrgScriptStatus(adminOrgId, script.id, script.status === 'active' ? 'disabled' : 'active'),
      );
    });
    controls.append(toggleStatus);
  }
  block.append(controls);

  if (expanded) {
    const detail = scriptContents.get(script.id);
    if (!detail) {
      block.append(emptyRow('Loading code…'));
    } else {
      const pre = document.createElement('pre');
      pre.className = 'ap-prompt';
      pre.textContent = detail.content;
      block.append(pre);
      if (detail.versions.length > 1) {
        const history = document.createElement('div');
        history.className = 'admin-setting-hint';
        history.textContent = 'History: ' + detail.versions
          .map((v: ScriptVersionInfo) => `v${v.version} (${formatDate(v.created_at)}${v.created_by_email ? `, ${v.created_by_email}` : ''}${v.change_note ? ` — ${v.change_note}` : ''})`)
          .join(' · ');
        block.append(history);
      }
    }
  }
  return block;
}

function scriptsTab(): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (scriptsError) parts.push(inlineError(scriptsError));
  if (scriptsLoading || scriptsData === null) {
    if (!scriptsError) parts.push(emptyRow('Loading the script library…'));
    return parts;
  }
  const owner = workspace.isOwner();

  const blurb = document.createElement('p');
  blurb.className = 'ol-blurb';
  blurb.textContent = owner
    ? 'Shared, versioned scripts — the deterministic path. Import known-good Kuhn scripts, '
      + 'review scripts promoted from projects, and keep one canonical copy per task.'
    : 'The scripts this organization shares across projects. Only owners can change the library.';
  parts.push(blurb);

  if (owner && scriptPromotions.length > 0) {
    parts.push(sectionTitle(`Pending script promotions (${scriptPromotions.length})`));
    for (const request of scriptPromotions) parts.push(scriptReviewBlock(request));
  }

  parts.push(sectionTitle('Library'));
  if (scriptsData.scripts.length === 0) {
    parts.push(emptyRow('No scripts in the library yet.'));
  } else {
    for (const script of scriptsData.scripts) parts.push(orgScriptBlock(script, owner));
  }

  const importable = scriptsData.catalog.filter((c) => c.available && !c.org_script_id);
  if (importable.length > 0) {
    parts.push(sectionTitle('Kuhn catalog'));
    for (const entry of importable) {
      const row = document.createElement('div');
      row.className = 'ap-card';
      const head = document.createElement('div');
      head.className = 'ap-head';
      const name = document.createElement('span');
      name.className = 'ap-name';
      name.textContent = entry.title;
      head.append(name,
        scriptMetaChip(entry.id),
        scriptMetaChip(LANGUAGE_LABEL[entry.language] ?? entry.language));
      if (owner) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn btn-ghost btn-sm';
        add.style.marginLeft = 'auto';
        add.textContent = 'Add to library';
        add.disabled = scriptsBusy;
        add.addEventListener('click', () => {
          void scriptAction(() => importCatalogScripts(adminOrgId, [entry.id]), `${entry.title} imported`);
        });
        head.append(add);
      }
      row.append(head);
      if (entry.description) {
        const desc = document.createElement('div');
        desc.className = 'admin-setting-hint';
        desc.textContent = entry.description;
        row.append(desc);
      }
      parts.push(row);
    }
  }
  return parts;
}

// ---- Agents tab (issue #67) ------------------------------------------------------

async function saveAddition(slug: string, text: string): Promise<void> {
  agentPromptBusy.add(slug);
  render();
  try {
    const addition = await putOrgAgentPrompt(adminOrgId, slug, text);
    const agent = agentPrompts?.find((a) => a.slug === slug);
    if (agent) agent.addition = addition;
    delete agentPromptErrors[slug];
    toast(addition ? `Saved ${agentIdentity(slug).label} addition` : `Cleared ${agentIdentity(slug).label} addition`);
  } catch (err) {
    agentPromptErrors[slug] = (err as Error).message;
  } finally {
    agentPromptBusy.delete(slug);
    render();
  }
}

function agentPromptCard(agent: OrgAgentPrompt, owner: boolean): HTMLElement {
  const identity = agentIdentity(agent.slug);
  const card = document.createElement('div');
  card.className = 'ap-card';

  const head = document.createElement('div');
  head.className = 'ap-head';
  // Neutral avatar on purpose — role color is reserved for the active agent
  // (the color-discipline rule in agents.ts).
  const avatar = document.createElement('span');
  avatar.className = 'ap-avatar';
  avatar.textContent = identity.initials;
  const name = document.createElement('span');
  name.className = 'ap-name';
  name.textContent = agent.name;
  head.append(avatar, name);
  if (agent.model) {
    const model = document.createElement('span');
    model.className = 'ap-model';
    model.textContent = agent.model;
    head.append(model);
  }
  card.append(head);

  if (agent.description) {
    const desc = document.createElement('div');
    desc.className = 'admin-setting-hint';
    desc.textContent = agent.description;
    card.append(desc);
  }

  // Collapsible read-only base prompt (seed-owned; edited in the codebase).
  const expanded = expandedBasePrompts.has(agent.slug);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-ghost btn-sm ap-toggle';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.textContent = expanded ? 'Hide base prompt' : 'View base prompt';
  toggle.addEventListener('click', () => {
    if (!expandedBasePrompts.delete(agent.slug)) expandedBasePrompts.add(agent.slug);
    render();
  });
  card.append(toggle);
  if (expanded) {
    const pre = document.createElement('pre');
    pre.className = 'ap-prompt';
    pre.textContent = agent.system_prompt;
    card.append(pre);
  }

  const additionTitle = document.createElement('div');
  additionTitle.className = 'admin-section-title';
  additionTitle.textContent = 'Organization addition';
  card.append(additionTitle);

  if (owner) {
    // Owners edit in place: textarea + counter, Save / Clear.
    const editor = document.createElement('textarea');
    editor.className = 'pb-input ap-editor';
    editor.rows = 4;
    editor.maxLength = agentPromptsMax;
    editor.placeholder = 'Org-wide instructions appended to this agent’s prompt — e.g. data-access guardrails.';
    editor.value = agent.addition?.text ?? '';
    editor.setAttribute('aria-label', `${agent.name} organization addition`);
    const counter = document.createElement('span');
    counter.className = 'ap-counter';
    const updateCounter = () => { counter.textContent = `${editor.value.length}/${agentPromptsMax}`; };
    updateCounter();
    editor.addEventListener('input', updateCounter);

    const busy = agentPromptBusy.has(agent.slug);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-ghost btn-sm';
    save.textContent = busy ? 'Saving…' : 'Save';
    save.disabled = busy;
    save.addEventListener('click', () => { void saveAddition(agent.slug, editor.value); });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-ghost btn-sm';
    clear.textContent = 'Clear';
    clear.disabled = busy || !agent.addition;
    clear.addEventListener('click', () => { void saveAddition(agent.slug, ''); });

    const controls = document.createElement('div');
    controls.className = 'ap-controls';
    controls.append(counter, save, clear);
    card.append(editor, controls);
  } else if (agent.addition) {
    const pre = document.createElement('pre');
    pre.className = 'ap-prompt';
    pre.textContent = agent.addition.text;
    card.append(pre);
  } else {
    card.append(emptyRow('No organization addition.'));
  }

  if (agent.addition) {
    const meta = document.createElement('div');
    meta.className = 'admin-setting-hint';
    const by = agent.addition.updated_by_email ? ` by ${agent.addition.updated_by_email}` : '';
    meta.textContent = `Updated ${formatDate(agent.addition.updated_at)}${by}`;
    card.append(meta);
  }
  const error = agentPromptErrors[agent.slug];
  if (error) card.append(inlineError(error));
  return card;
}

function agentsTab(): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (agentPromptsError) parts.push(inlineError(agentPromptsError));
  if (agentPromptsLoading || agentPrompts === null) {
    if (!agentPromptsError) parts.push(emptyRow('Loading agent prompts…'));
    return parts;
  }
  const owner = workspace.isOwner();
  const blurb = document.createElement('p');
  blurb.className = 'ol-blurb';
  blurb.textContent = owner
    ? 'Each agent’s built-in instructions, plus an org-wide addition appended to them — ' +
      'use it for guardrails like data-access rules. Additions apply to every project in this organization.'
    : 'Each agent’s built-in instructions and this organization’s additions. Only owners can edit additions.';
  parts.push(blurb);
  for (const agent of agentPrompts) parts.push(agentPromptCard(agent, owner));
  return parts;
}

// ---- Themes tab (STH-58) ---------------------------------------------------------

async function themeAction(fn: () => Promise<unknown>): Promise<void> {
  themesBusy = true;
  render();
  try {
    await fn();
    themesError = null;
  } catch (err) {
    themesError = (err as Error).message;
  } finally {
    themesBusy = false;
  }
  await reloadThemes();
}

function themeRow(name: string, title: string, meta: string, control: HTMLElement | null): HTMLElement {
  const row = document.createElement('div');
  row.className = 'theme-row';
  const label = document.createElement('div');
  label.innerHTML = '<strong></strong> <code class="theme-name"></code><div class="theme-meta"></div>';
  (label.querySelector('strong') as HTMLElement).textContent = title;
  (label.querySelector('.theme-name') as HTMLElement).textContent = name;
  (label.querySelector('.theme-meta') as HTMLElement).textContent = meta;
  row.append(label);
  if (control) row.append(control);
  return row;
}

function themesTab(): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (themesError) parts.push(inlineError(themesError));
  if (themesLoading || themesData === null) {
    if (!themesError) parts.push(emptyRow('Loading slide themes…'));
    return parts;
  }
  const owner = workspace.isOwner();
  const blurb = document.createElement('p');
  blurb.className = 'ol-blurb';
  blurb.textContent = owner
    ? 'Marp slide themes. A deck picks one with `theme: <name>` front matter; an active org theme shadows a Kuhn theme of the same name.'
    : 'Slide themes available to this organization’s decks. Only owners can upload or disable themes.';
  parts.push(blurb);

  parts.push(sectionTitle('Kuhn themes'));
  if (themesData.catalog.length === 0) parts.push(emptyRow('No seeded themes in this deployment.'));
  for (const t of themesData.catalog) {
    const meta = [
      t.description ?? '',
      t.available ? '' : 'unavailable in this deploy',
      t.shadowed ? 'shadowed by an org theme of the same name' : '',
    ].filter(Boolean).join(' — ');
    parts.push(themeRow(t.name, t.title, meta, null));
  }

  parts.push(sectionTitle('Organization themes'));
  if (themesData.themes.length === 0) parts.push(emptyRow('No uploaded themes yet.'));
  for (const t of themesData.themes) {
    let control: HTMLElement | null = null;
    if (owner) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-quiet btn-sm';
      btn.textContent = t.status === 'active' ? 'Disable' : 'Enable';
      btn.disabled = themesBusy;
      btn.addEventListener('click', () => void themeAction(
        () => setOrgSlideThemeStatus(adminOrgId, t.name, t.status === 'active' ? 'disabled' : 'active'),
      ));
      control = btn;
    }
    const meta = `${t.status} · ${(t.css_bytes / 1024).toFixed(1)} KB · updated ${formatDate(t.updated_at)}`;
    parts.push(themeRow(t.name, t.title, meta, control));
  }

  if (owner) {
    parts.push(sectionTitle('Upload a theme'));
    const form = document.createElement('form');
    form.className = 'theme-upload';
    const hint = document.createElement('p');
    hint.className = 'ol-blurb';
    hint.textContent = 'Pick a Marp theme CSS file. Its /* @theme <name> */ header names the theme; re-uploading a name replaces it.';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.css,text/css';
    const title = document.createElement('input');
    title.type = 'text';
    title.placeholder = 'Display title (optional)';
    title.className = 'invite-input';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-solid btn-sm';
    submit.textContent = 'Upload theme';
    submit.disabled = themesBusy;
    form.append(hint, file, title, submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const picked = file.files?.[0];
      if (!picked) {
        themesError = 'Choose a CSS file to upload.';
        render();
        return;
      }
      void themeAction(async () => {
        const css = await picked.text();
        await uploadOrgSlideTheme(adminOrgId, css, title.value.trim() || undefined);
      });
    });
    parts.push(form);
  }
  return parts;
}

// ---- Render ----------------------------------------------------------------------

// ---- Secrets tab (org secrets store) ---------------------------------------------
// Values are write-only: create/replace/delete only; the list is metadata.
// Editors and up manage; viewers get a read-only list.

function secretsTab(): HTMLElement[] {
  const parts: HTMLElement[] = [];
  parts.push(sectionTitle('Org secrets'));
  const intro = document.createElement('p');
  intro.className = 'admin-setting-hint';
  intro.textContent =
    'Credentials agents use server-side — e.g. a database DSN the analyst\u2019s '
    + 'sandboxed scripts connect with (run_script secrets), or an ncbi-api-key for '
    + 'PubMed rate limits. Values are write-only: they can be replaced or deleted, '
    + 'never viewed, and they are never shown to agents or models.';
  parts.push(intro);

  if (secretsError) parts.push(inlineError(secretsError));
  if (secretsLoading || secretsRows === null) {
    parts.push(emptyRow('Loading secrets…'));
    return parts;
  }

  const canEdit = workspace.canEdit();

  if (secretsRows.length === 0) {
    parts.push(emptyRow('No secrets yet.'));
  }
  for (const secret of secretsRows) {
    const row = document.createElement('div');
    row.className = 'admin-form-row';
    const label = document.createElement('div');
    label.innerHTML = `<code></code><span class="admin-setting-hint"></span>`;
    (label.querySelector('code') as HTMLElement).textContent = secret.name;
    (label.querySelector('span') as HTMLElement).textContent =
      ` ${secret.description ?? ''} · updated ${formatDate(secret.updated_at)}`;
    row.append(label);
    if (canEdit) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-ghost btn-sm';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', `Delete secret ${secret.name}`);
      del.disabled = secretsBusy;
      del.addEventListener('click', () => {
        if (!confirm(`Delete secret "${secret.name}"? Agent runs that reference it will fail.`)) return;
        secretsBusy = true;
        render();
        void deleteOrgSecret(adminOrgId, secret.name)
          .then(() => toast(`Deleted ${secret.name}`))
          .catch((err) => { secretsError = (err as Error).message; })
          .finally(() => { secretsBusy = false; void reloadSecrets(); });
      });
      row.append(del);
    }
    parts.push(row);
  }

  if (canEdit) {
    parts.push(sectionTitle('Add or replace a secret'));
    const form = document.createElement('form');
    form.className = 'admin-form';
    const name = document.createElement('input');
    name.className = 'pb-input';
    name.placeholder = 'name (e.g. nsduh-db)';
    name.pattern = '[a-z][a-z0-9-]{0,63}';
    name.required = true;
    name.setAttribute('aria-label', 'Secret name');
    const value = document.createElement('input');
    value.className = 'pb-input';
    value.type = 'password';
    value.placeholder = 'value (stored write-only)';
    value.required = true;
    value.setAttribute('aria-label', 'Secret value');
    const desc = document.createElement('input');
    desc.className = 'pb-input';
    desc.placeholder = 'description (optional)';
    desc.setAttribute('aria-label', 'Secret description');
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn btn-ghost btn-sm';
    save.textContent = 'Save';
    save.disabled = secretsBusy;
    form.append(name, value, desc, save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const existing = secretsRows?.some((r) => r.name === name.value.trim());
      if (existing && !confirm(`Replace the value of "${name.value.trim()}"?`)) return;
      secretsBusy = true;
      render();
      void putOrgSecret(adminOrgId, name.value.trim(), value.value, desc.value.trim() || undefined)
        .then((row) => toast(`Saved ${row.name}`))
        .catch((err) => { secretsError = (err as Error).message; })
        .finally(() => { secretsBusy = false; void reloadSecrets(); });
    });
    parts.push(form);
    const hint = document.createElement('p');
    hint.className = 'admin-setting-hint';
    hint.textContent =
      'Agents reference a secret by name (analyst: run_script secrets → env '
      + 'KUHN_SECRET_<NAME>). To rotate, save the same name with a new value.';
    parts.push(hint);
  }
  return parts;
}

const TAB_LABEL: Record<Tab, string> = {
  members: 'Members',
  settings: 'Settings',
  promotions: 'Promotions',
  knowledge: 'Knowledge',
  scripts: 'Scripts',
  secrets: 'Secrets',
  themes: 'Themes',
  agents: 'Agents',
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
    if (tab === 'scripts') {
      const attention = scriptPromotions.length
        + (scriptsData?.scripts.filter((s) => s.update_available).length ?? 0);
      if (attention > 0) {
        const count = document.createElement('span');
        count.className = 'admin-tab-count';
        count.textContent = String(attention);
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
    : activeTab === 'agents' ? agentsTab()
    : activeTab === 'scripts' ? scriptsTab()
    : activeTab === 'secrets' ? secretsTab()
    : activeTab === 'themes' ? themesTab()
    : knowledgeTab();
  body.append(...parts);

  panel.append(head, tabsBar(), body);
  root.replaceChildren(panel);
}
