// Backend client: projects, files (story 018 API), and the agent task SSE
// stream (story 011 events + story 013 text_delta).

// Backend origin. An explicit VITE_BACKEND_URL always wins (empty string
// means same-origin). Otherwise production builds default to same-origin —
// the backend serves the built webapp on one port — and dev builds default
// to the local backend.
const configuredBackend = import.meta.env.VITE_BACKEND_URL as string | undefined;

export const BACKEND_URL: string = (
  configuredBackend ?? (import.meta.env.PROD ? '' : 'http://localhost:3002')
).replace(/\/+$/, '');

export const BACKEND_WS_URL: string = (
  BACKEND_URL || (typeof location !== 'undefined' ? location.origin : '')
).replace(/^http/, 'ws');

/**
 * Every backend call goes through here (story 007-002): the session cookie
 * rides along (credentials — the webapp dev server is a different origin than
 * the backend), and any 401 raises `kuhn:unauthorized` so login.ts can put up
 * the sign-in screen no matter which call hit the wall.
 */
async function apiFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, { credentials: 'include', ...init });
  if (res.status === 401) window.dispatchEvent(new CustomEvent('kuhn:unauthorized'));
  if (res.status === 403) void detectStaleRole(res.clone());
  return res;
}

// The backend guard helpers' 403 bodies (routes/guards.js): a role threshold,
// a suspended org, or a missing super-admin flag. Any of them arriving means
// the client's cached role/status is stale — raise `kuhn:role-refresh` so
// workspace.ts re-fetches /api/orgs and role-aware chrome re-renders.
const GUARD_403_RE = /^(requires .+ role|organization suspended|super-admin required)$/;

async function detectStaleRole(res: Response): Promise<void> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === 'string' && GUARD_403_RE.test(body.error)) {
      window.dispatchEvent(new CustomEvent('kuhn:role-refresh'));
    }
  } catch {
    // Non-JSON 403 — not a guard refusal.
  }
}

export interface WizardAnswers {
  title: string;
  projectType: string;
  researchQuestion: string;
  deliverables: string[];
  timeline: string;
  sourceMaterials: string[];
  notes?: string;
}

export interface Project {
  id: number;
  name: string;
  project_type: string;
  owner_id: string;
  org_id: number;
  /** Project config blob. `activeDocument` records the last-open file (story 006);
   *  `setup` holds the wizard's draft/complete state (setup wizard). */
  config?: {
    activeDocument?: string;
    title?: string;
    project_type?: string;
    research_question?: string;
    setup?: { status: 'draft' | 'complete'; answers: Partial<WizardAnswers> };
    [key: string]: unknown;
  };
}

/** Membership role within an organization (010-003). Rank: viewer < editor < owner. */
export type Role = 'owner' | 'editor' | 'viewer';

export interface Org {
  id: number;
  name: string;
  slug: string;
  role: Role;
  status: 'active' | 'suspended';
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  /** Last-modified time (ISO), files only (story 005-002). */
  mtime?: string;
  /** True when the file changed since this user last opened it (story 005-002). */
  unseen?: boolean;
  children?: TreeNode[];
}

export interface AgentEvent {
  type: 'text_delta' | 'text' | 'file_change' | 'citation' | 'comment' | 'question' | 'question_expired' | 'notice' | 'done' | 'error' | 'stage' | 'job' | 'review_link';
  agent: string;
  /** Feed envelope timestamp — present on project-feed events (story 005-001). */
  ts?: string;
  content?: string;
  path?: string;
  // 'proposed' = the pending-suggestion set for a path changed without a real
  // write (story 008-001) — re-fetch pending edits, no bytes moved.
  // 'moved' = an identity-preserving move/rename (story 012-002); `path` is the
  // NEW canonical path and `meta.from` the old one. A folder move emits exactly
  // one event for the folder itself — descendants are implied by prefix.
  kind?: 'create' | 'update' | 'delete' | 'proposed' | 'moved';
  // Event sidecar; carries `from` on kind 'moved' (story 012-002).
  meta?: { from?: string };
  // Citation upsert by an agent (story 016)
  key?: string;
  bibtex?: string | null;
  jobId?: number;
  sessionId?: string;
  usage?: { inputTokens: number; outputTokens: number };
  // Per-task token budget snapshot (weighted tokens), carried on done/error.
  budget?: { used: number; limit: number };
  // Machine-readable cause, e.g. 'budget_exceeded' (drives the resume UI) or
  // 'provider_overloaded' on a transient-error notice/terminal error (story 029).
  reason?: string;
  // Transient-error retry progress (story 029): emitted on a 'notice' while the
  // runtime backs off before retrying.
  attempt?: number;
  maxAttempts?: number;
  nextRetryMs?: number;
  message?: string;
  // Margin-comment mutation (story 008-004) — re-fetch comments for `path`;
  // 'mint' | 'claim' | 'revoke' | 'edit' are review-link lifecycle actions on
  // `type: 'review_link'` feed events (epic 013 §2.6).
  action?: 'create' | 'reply' | 'resolve' | 'reopen' | 'delete' | 'mint' | 'claim' | 'revoke' | 'edit';
  // Review-link feed event payload (epic 013): the link id, its mode, and the
  // claimed reviewer name (absent while unclaimed).
  linkId?: number;
  mode?: ReviewLinkMode;
  name?: string;
  // Seeding pipeline stage markers (story 015); 'started' is the project
  // feed's job-start marker (story 005-001).
  stage?: string;
  status?: 'start' | 'done' | 'error' | 'started';
  detail?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface Conversation {
  id: number;
  agent_slug: string;
  created_at: string;
  messages: ConversationMessage[];
}

export interface Job {
  id: number;
  role: string;
  status: string;
  session_id: string | null;
  created_at: string;
}

/**
 * What every failing backend call rejects with (story 012-001). Strictly
 * additive: it extends Error and `.message` is still the backend's readable
 * `error` string, so the ~30 existing `catch (err) { (err as Error).message }`
 * sites are unchanged. What it adds is the rest of the JSON body — `status`,
 * the storage `code` and the `paths` array — which callers previously could
 * not see at all. The move UI needs it to tell the route's two 409s apart:
 * a destination that already exists on disk (`code:'conflict'`, no paths) vs.
 * an agent's pending edit already waiting there (`code:'conflict'` + `paths`,
 * which lives only in the DB and so cannot be detected from the tree).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly paths?: string[];

  constructor(status: number, message: string, code?: string, paths?: string[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.paths = paths;
  }
}

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string; code?: string; paths?: unknown;
    };
    throw new ApiError(
      res.status,
      body.error ?? `${res.status} ${res.statusText}`,
      body.code,
      Array.isArray(body.paths) ? (body.paths as string[]) : undefined,
    );
  }
  return res;
}

// ---- Auth (story 007-002) ----

export interface Me {
  user: { id: number; email: string; display_name: string | null; is_superadmin: boolean };
  mode: 'dev' | 'magic-link';
}

/**
 * The signed-in user and auth mode; null when not authenticated.
 *
 * `is_superadmin` is NORMALIZED to a real boolean here: it comes off SQLite as
 * 0/1, and a caller writing the natural `=== true` check silently disagrees
 * with a caller writing a truthy check — which is exactly how the platform
 * console came to be listed in the org menu but refuse to open.
 */
export async function fetchMe(): Promise<Me | null> {
  const res = await apiFetch(`${BACKEND_URL}/api/auth/me`);
  if (res.status === 401) return null;
  await expectOk(res);
  const me = (await res.json()) as Me;
  if (me?.user) me.user.is_superadmin = !!me.user.is_superadmin;
  return me;
}

/** Ask the backend to email a magic sign-in link (dev: logged to its console). */
export async function requestLoginLink(email: string): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/auth/request-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
  );
}

/** Revoke the session server-side and clear the cookie. */
export async function logout(): Promise<void> {
  await expectOk(await apiFetch(`${BACKEND_URL}/api/auth/logout`, { method: 'POST' }));
}

// ---- Organizations (story 005) ----

/** The current user's organizations. */
export async function listOrgs(): Promise<Org[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/orgs`));
  return ((await res.json()) as { orgs: Org[] }).orgs;
}

/**
 * Create an organization (super-admin only since epic 011). `ownerEmail`
 * names the first admin: an existing user (including the caller) becomes
 * owner directly; otherwise an owner-role invitation is issued.
 */
export async function createOrg(name: string, ownerEmail?: string): Promise<Org> {
  return (await adminCreateOrg({ name, ...(ownerEmail ? { ownerEmail } : {}) })).org;
}

// ---- Org administration & platform admin (010-003 + epic 011) ----

export interface OrgMember {
  user_id: number;
  email: string;
  display_name: string | null;
  role: Role;
  created_at: string;
}

export interface Invitation {
  id: number;
  email: string;
  role: Role;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  created_at: string;
}

export interface OrgSettings {
  default_member_role: 'viewer' | 'editor';
  library_seeding: boolean;
  promotion_policy: 'approval-required' | 'direct';
}

export interface PromotionRequest {
  id: number;
  project_id: number;
  project_name: string;
  path: string;
  title: string | null;
  note: string | null;
  suggested_by_email: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decision_note: string | null;
  created_at: string;
}

export interface AdminOrg {
  id: number;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  member_count: number;
  created_at: string;
}

/** The org's members, owners first (owner-only endpoint). */
export async function listOrgMembers(orgId: number): Promise<OrgMember[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/members`));
  return ((await res.json()) as { members: OrgMember[] }).members;
}

/** Change a member's role; rejects 409 `code:'last_owner'` when it would leave zero owners. */
export async function updateMemberRole(orgId: number, userId: number, role: Role): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/members/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    }),
  );
}

/** Remove a member; rejects 409 `code:'last_owner'` when it would leave zero owners. */
export async function removeOrgMember(orgId: number, userId: number): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
  );
}

/** The org's invitations, newest first, with derived state (owner-only). */
export async function listInvitations(orgId: number): Promise<Invitation[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/invitations`));
  return ((await res.json()) as { invitations: Invitation[] }).invitations;
}

/** Invite an email into the org; rejects 409 when it is already a member. */
export async function createInvitation(orgId: number, email: string, role: Role): Promise<Invitation> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    }),
  );
  return ((await res.json()) as { invitation: Invitation }).invitation;
}

/** Revoke a pending invitation. */
export async function revokeInvitation(orgId: number, invitationId: number): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/invitations/${invitationId}`, {
      method: 'DELETE',
    }),
  );
}

/** The org's settings merged over defaults, plus its display row (owner-only). */
export async function getOrgSettings(
  orgId: number,
): Promise<{ org: { id: number; name: string; slug: string; status: 'active' | 'suspended' }; settings: OrgSettings }> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/settings`));
  return (await res.json()) as {
    org: { id: number; name: string; slug: string; status: 'active' | 'suspended' };
    settings: OrgSettings;
  };
}

/**
 * Patch org settings (flat body: `name` renames the org, the rest are settings
 * knobs). Unknown keys / bad values reject 400 with the offending `field`;
 * `slug` is immutable everywhere.
 */
export async function updateOrgSettings(
  orgId: number,
  patch: Partial<OrgSettings> & { name?: string },
): Promise<{ org: { id: number; name: string; slug: string; status: 'active' | 'suspended' }; settings: OrgSettings }> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
  return (await res.json()) as {
    org: { id: number; name: string; slug: string; status: 'active' | 'suspended' };
    settings: OrgSettings;
  };
}

/** All organizations on the platform (super-admin only). */
export async function adminListOrgs(): Promise<AdminOrg[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/admin/orgs`));
  return ((await res.json()) as { orgs: AdminOrg[] }).orgs;
}

/**
 * Create an organization (super-admin only). `member` reports whether the
 * caller ended up a member (ownerEmail matched their own existing account);
 * otherwise an owner invitation went out and the caller has NO access.
 */
export async function adminCreateOrg(params: {
  name: string;
  slug?: string;
  ownerEmail?: string;
}): Promise<{ org: Org; member: boolean }> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  );
  return (await res.json()) as { org: Org; member: boolean };
}

/** Rename or suspend/unsuspend an organization (super-admin only). */
export async function adminUpdateOrg(
  orgId: number,
  patch: { name?: string; status?: 'active' | 'suspended' },
): Promise<AdminOrg> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/admin/orgs/${orgId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
  return ((await res.json()) as { org: AdminOrg }).org;
}

/** The org's promotion requests, optionally filtered by status (owner-only). */
export async function listPromotions(
  orgId: number,
  status?: PromotionRequest['status'],
): Promise<PromotionRequest[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/promotions${query}`));
  return ((await res.json()) as { requests: PromotionRequest[] }).requests;
}

/** Approve a pending promotion request (copy-on-approve happens server-side). */
export async function approvePromotion(
  orgId: number,
  id: number,
  note?: string,
): Promise<PromotionRequest> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/promotions/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note ? { note } : {}),
    }),
  );
  return ((await res.json()) as { request: PromotionRequest }).request;
}

/** Reject a pending promotion request, recording who and why. */
export async function rejectPromotion(
  orgId: number,
  id: number,
  note?: string,
): Promise<PromotionRequest> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/promotions/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note ? { note } : {}),
    }),
  );
  return ((await res.json()) as { request: PromotionRequest }).request;
}

// ---- Projects (story 013; org-scoped in story 005) ----

/** All projects across the current user's orgs. */
export async function listProjects(): Promise<Project[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/projects`));
  return ((await res.json()) as { projects: Project[] }).projects;
}

/** Projects belonging to a single organization. */
export async function listOrgProjects(orgId: number): Promise<Project[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/projects`));
  return ((await res.json()) as { projects: Project[] }).projects;
}

export async function createProject(
  name: string,
  projectType = 'manuscript',
  orgId?: number,
): Promise<Project> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, projectType, orgId }),
    }),
  );
  return ((await res.json()) as { project: Project }).project;
}

/** Rename a project (the workspace dir is keyed by id, so files are untouched). */
export async function renameProject(projectId: number, name: string): Promise<Project> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
  return ((await res.json()) as { project: Project }).project;
}

/**
 * Save project setup from the wizard (token-free intake). draft=true persists a
 * resumable draft; draft=false is the final save (writes project.json, marks
 * setup complete). Returns the updated project.
 */
export async function saveProjectConfig(
  projectId: number,
  answers: WizardAnswers,
  draft: boolean,
): Promise<Project> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, draft }),
    }),
  );
  return ((await res.json()) as { project: Project }).project;
}

/** Persist which document is open in a project, so reopening restores it. */
export async function setActiveDocument(projectId: number, path: string): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/active-document`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
}

export async function getTree(projectId: number): Promise<TreeNode[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/files`));
  return ((await res.json()) as { tree: TreeNode[] }).tree;
}

const fileUrl = (projectId: number, path: string) =>
  `${BACKEND_URL}/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`;

/** Read a text file; returns null if it does not exist. */
export async function readTextFile(projectId: number, path: string): Promise<string | null> {
  const res = await apiFetch(fileUrl(projectId, path));
  if (res.status === 404) return null;
  await expectOk(res);
  return res.text();
}

export async function writeTextFile(
  projectId: number,
  path: string,
  content: string,
  opts: { checkpoint?: boolean } = {},
): Promise<void> {
  // checkpoint=1 marks an explicit user save: the backend commits a history
  // version immediately instead of coalescing it (story 008-002).
  const url = fileUrl(projectId, path) + (opts.checkpoint ? '&checkpoint=1' : '');
  await expectOk(
    await apiFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    }),
  );
}

// ---- Version history (story 008-002) ----

export interface HistoryEntry {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  date: string;
  label: string;
  /** Agent slug when the version was agent-authored, else null. */
  agent: string | null;
  /** True when the version was authored by an external reviewer (epic 013):
   *  the backend parses `link-<id>@reviewers.kuhn.local` author emails. */
  external?: boolean;
  /** The authoring review link's id when `external`. */
  reviewerLinkId?: number | null;
}

export async function getHistory(projectId: number, path: string): Promise<HistoryEntry[]> {
  const res = await expectOk(await apiFetch(
    `${BACKEND_URL}/api/projects/${projectId}/history?path=${encodeURIComponent(path)}`,
  ));
  return ((await res.json()) as { history: HistoryEntry[] }).history;
}

/** A file's content at a specific version. */
export async function getHistoryFile(projectId: number, path: string, ref: string): Promise<string> {
  const res = await expectOk(await apiFetch(
    `${BACKEND_URL}/api/projects/${projectId}/history/file?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`,
  ));
  return res.text();
}

/** Restore a file to an old version (append-only — commits a new version). */
export async function restoreVersion(projectId: number, path: string, ref: string): Promise<void> {
  await expectOk(await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/history/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, ref }),
  }));
}

// ---- Pending edits — suggestion mode (story 008-001) ----

/** One server-computed diff hunk of a pending edit (jsdiff structuredPatch). */
export interface PendingHunk {
  index: number;
  /** sha256 hex of the hunk's joined lines — echoed on accept/reject so the
   *  server can 409 if the hunk at that index no longer matches. */
  hash: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Unified-diff lines: ' ' context, '-' removal, '+' insertion prefixes. */
  lines: string[];
}

/** A pending agent suggestion for one path (accepted/rejected server-side). */
export interface PendingEdit {
  id: number;
  path: string;
  /** Proposing agent slug, or null. */
  agent: string | null;
  jobId: number | null;
  /** Server re-anchor failed — review side-by-side, never inline. */
  stale: boolean;
  /** The file did not exist when first proposed (accept = create). */
  baseMissing: boolean;
  createdAt: string;
  updatedAt: string;
  hunks: PendingHunk[];
  /** Inline on stale rows (side-by-side review); optional on fresh rows. */
  baseContent?: string;
  proposedContent?: string;
}

/** Accept/reject response: hunks left on the row (0 = row deleted). */
export interface PendingEditMutation {
  remaining: number;
  /** Refreshed edit when remaining > 0. */
  edit?: PendingEdit;
}

/** The project's pending edits (staleness refreshed server-side on every GET). */
export async function getPendingEdits(projectId: number, path?: string): Promise<PendingEdit[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/pending-edits${query}`),
  );
  return ((await res.json()) as { edits: PendingEdit[] }).edits;
}

/** Create/update a pending edit — the token-free check scripts' entry point
 *  (agents propose through the runtime tool path). */
export async function createPendingEdit(
  projectId: number,
  params: { path: string; proposedContent: string; agent?: string; jobId?: number },
): Promise<PendingEdit> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/pending-edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  );
  const body = (await res.json()) as PendingEdit | { edit: PendingEdit };
  return 'edit' in body ? body.edit : body;
}

/**
 * Accept a pending edit server-side: whole row (no opts), a single hunk
 * (`hunk`), or a stale row wholesale (`force`). The server writes the file and
 * publishes the real file_change — never apply hunks client-side.
 */
export async function acceptPendingEdit(
  projectId: number,
  id: number,
  opts: { hunk?: { index: number; hash: string }; force?: boolean } = {},
): Promise<PendingEditMutation> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/pending-edits/${id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }),
  );
  return (await res.json()) as PendingEditMutation;
}

/** Reject a pending edit (whole row, or one hunk). No file write happens. */
export async function rejectPendingEdit(
  projectId: number,
  id: number,
  hunk?: { index: number; hash: string },
): Promise<PendingEditMutation> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/pending-edits/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hunk ? { hunk } : {}),
    }),
  );
  return (await res.json()) as PendingEditMutation;
}

// ---- Margin comments (story 008-004) ----

export interface CommentAnchor {
  /** Exact quoted target text; null = unanchored (whole-document) comment. */
  quote: string | null;
  /** Character-offset hints into the stored markdown. */
  start: number | null;
  end: number | null;
}

export interface Comment {
  id: number;
  path: string;
  parentId: number | null;
  userId: number | null;
  userName: string | null;
  /** Agent slug for agent-filed comments; null = human-authored. */
  agent: string | null;
  /** Minting review link id for externally-authored comments (epic 013);
   *  null/absent = member- or agent-authored. */
  reviewLinkId?: number | null;
  /** The external reviewer's claimed display name, joined at read time from
   *  review_links (epic 013) — the analogue of userName. */
  reviewerName?: string | null;
  body: string;
  /** Root rows only; null on replies. */
  anchor: CommentAnchor | null;
  orphaned: boolean;
  resolvedAt: string | null;
  resolvedByName: string | null;
  createdAt: string;
}

export interface CommentThread extends Comment {
  replies: Comment[];
}

/** Threads (roots with nested replies) for a project, optionally one path. */
export async function getComments(projectId: number, path?: string): Promise<CommentThread[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/comments${query}`),
  );
  return ((await res.json()) as { threads: CommentThread[] }).threads;
}

/** Unresolved-thread count per path — the file-tree badge query. */
export async function getCommentCounts(projectId: number): Promise<Record<string, number>> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/comments/counts`),
  );
  return ((await res.json()) as { counts: Record<string, number> }).counts;
}

export async function createComment(
  projectId: number,
  params: { path: string; body: string; anchor?: { quote: string; start?: number; end?: number } },
): Promise<CommentThread> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  );
  return (await res.json()) as CommentThread;
}

export async function replyToComment(projectId: number, rootId: number, body: string): Promise<Comment> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/comments/${rootId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
  );
  return (await res.json()) as Comment;
}

export async function setCommentResolved(
  projectId: number,
  rootId: number,
  resolved: boolean,
): Promise<CommentThread> {
  const res = await expectOk(
    await apiFetch(
      `${BACKEND_URL}/api/projects/${projectId}/comments/${rootId}/${resolved ? 'resolve' : 'reopen'}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    ),
  );
  return (await res.json()) as CommentThread;
}

/** Anchor maintenance from the live editor: drifted quote/offsets, orphaning. */
export async function updateCommentAnchor(
  projectId: number,
  rootId: number,
  anchor: { quote?: string; start?: number; end?: number; orphaned?: boolean },
): Promise<CommentThread> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/comments/${rootId}/anchor`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(anchor),
    }),
  );
  return (await res.json()) as CommentThread;
}

export async function deleteComment(projectId: number, id: number): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/comments/${id}`, { method: 'DELETE' }),
  );
}

// ---- External review links — member management (epic 013, story 003) --------
// The member-facing half of external review: mint/list/revoke magic links
// scoped to ONE document. These shapes are the frozen client contract for
// agent-backend/src/routes/review-links.js (plan §2.3): camelCase JSON, list
// wrapped as `{ links }`, mint as `{ url, link }`, revoke as `{ link }`.
// The raw link URL appears ONLY in the mint response — show it once.

export type ReviewLinkMode = 'view' | 'comment' | 'edit';

export interface ReviewLink {
  id: number;
  projectId: number;
  /** Workspace-relative document path; rekeyed server-side on moves. */
  path: string;
  mode: ReviewLinkMode;
  createdBy: number;
  /** Minting member's display name (or email), for the active-links panel. */
  createdByName: string | null;
  /** Claimed display name; null until the link is claimed. */
  reviewerName: string | null;
  /** Null = unclaimed (single-claim discipline). */
  claimedAt: string | null;
  revokedAt: string | null;
  expiresAt: string;
  lastActiveAt: string | null;
  createdAt: string;
}

/** Mint a review link for one document. The response's `url` is the only time
 *  the raw token is visible; `ttlMs` is clamped server-side (default 7d). */
export async function mintReviewLink(
  projectId: number,
  params: { path: string; mode: ReviewLinkMode; ttlMs?: number },
): Promise<{ url: string; link: ReviewLink }> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/review-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  );
  return (await res.json()) as { url: string; link: ReviewLink };
}

/** Review links for a project (optionally one path; revoked rows on demand). */
export async function listReviewLinks(
  projectId: number,
  opts: { path?: string; includeRevoked?: boolean } = {},
): Promise<ReviewLink[]> {
  const params = new URLSearchParams();
  if (opts.path) params.set('path', opts.path);
  if (opts.includeRevoked) params.set('includeRevoked', '1');
  const query = params.toString();
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/review-links${query ? `?${query}` : ''}`),
  );
  return ((await res.json()) as { links: ReviewLink[] }).links;
}

/** Revoke a link: its sessions die and its sockets close within one cycle. */
export async function revokeReviewLink(projectId: number, linkId: number): Promise<ReviewLink> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/review-links/${linkId}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  return ((await res.json()) as { link: ReviewLink }).link;
}

// ---- File manager (story 014) ----

/**
 * Max upload size, mirroring the backend's STORAGE_MAX_FILE_BYTES default
 * (20 MB). We pre-check client-side so an oversize file shows a readable error
 * and is excluded from the batch — the upload endpoint's batch semantics are
 * all-or-nothing (one oversize file aborts the request as a 413, story 026),
 * so the pre-check is the intentional UX fast-path that lets the valid files
 * in a mixed drop still land. If the pre-check drifts from the backend limit
 * (STORAGE_MAX_FILE_BYTES overridden), the backend now returns a readable
 * `413 { error, code: 'too_large' }` that uploadFiles surfaces per file.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface UploadOutcome {
  uploaded: { path: string; size: number; created: boolean }[];
  /** Files rejected (oversize, or a batch error) with a readable reason. */
  failed: { name: string; error: string }[];
}

/**
 * Upload files into a project directory in one multipart request (the endpoint
 * accepts up to 20). Oversize files are reported in `failed` and excluded from
 * the request so the rest still land; a batch-level error marks every sent file
 * failed with the backend's readable message. The endpoint overwrites existing
 * files, so uploads do not conflict (409 is a rename concern — see moveFile).
 */
export async function uploadFiles(
  projectId: number,
  files: File[],
  dir?: string,
): Promise<UploadOutcome> {
  const failed: { name: string; error: string }[] = [];
  const sendable: File[] = [];
  const limitMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      failed.push({ name: file.name, error: `File exceeds the ${limitMb} MB limit` });
    } else {
      sendable.push(file);
    }
  }
  if (sendable.length === 0) return { uploaded: [], failed };

  const form = new FormData();
  if (dir) form.append('path', dir);
  for (const file of sendable) form.append('files', file, file.name);

  const res = await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/files/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const error = body.error ?? `${res.status} ${res.statusText}`;
    for (const file of sendable) failed.push({ name: file.name, error });
    return { uploaded: [], failed };
  }
  const { files: written } = (await res.json()) as { files: UploadOutcome['uploaded'] };
  return { uploaded: written, failed };
}

// ---- Org knowledge library (story 006-004; backend from 006-001/002) ----

export interface OrgDocument {
  id: number;
  org_id: number;
  filename: string;
  title: string | null;
  mime: string | null;
  size_bytes: number;
  /** Ingestion lifecycle (story 006-002). */
  status: 'pending' | 'ingesting' | 'ready' | 'failed';
  /** Human-readable failure reason when status is 'failed'. */
  status_detail: string | null;
  source: 'upload' | 'project-promotion' | 'guidance-import';
  source_project_id: number | null;
  /** Kuhn knowledge catalog link (issue #65); null for uploads/promotions. */
  catalog_item_id: string | null;
  catalog_item_version: number | null;
  created_at: string;
  updated_at: string;
}

/** The org's library documents, newest first. */
export async function listOrgLibrary(orgId: number): Promise<OrgDocument[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/library`));
  return ((await res.json()) as { documents: OrgDocument[] }).documents;
}

/** One library document's current metadata (poll fallback for ingest status). */
export async function getOrgDocument(orgId: number, docId: number): Promise<OrgDocument> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/library/${docId}`));
  return ((await res.json()) as { document: OrgDocument }).document;
}

/**
 * Upload files into the org library (multipart, up to 20). Same oversize
 * pre-check pattern as project uploadFiles: too-big files are reported in
 * `failed` and excluded so the rest still land.
 */
export async function uploadOrgDocuments(
  orgId: number,
  files: File[],
): Promise<{ uploaded: OrgDocument[]; failed: { name: string; error: string }[] }> {
  const failed: { name: string; error: string }[] = [];
  const sendable: File[] = [];
  const limitMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      failed.push({ name: file.name, error: `File exceeds the ${limitMb} MB limit` });
    } else {
      sendable.push(file);
    }
  }
  if (sendable.length === 0) return { uploaded: [], failed };

  const form = new FormData();
  for (const file of sendable) form.append('files', file, file.name);
  const res = await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/library/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const error = body.error ?? `${res.status} ${res.statusText}`;
    for (const file of sendable) failed.push({ name: file.name, error });
    return { uploaded: [], failed };
  }
  const { documents } = (await res.json()) as { documents: OrgDocument[] };
  return { uploaded: documents, failed };
}

/** Remove a library document (record and bytes). */
export async function deleteOrgDocument(orgId: number, docId: number): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/library/${docId}`, { method: 'DELETE' }),
  );
}

/**
 * Copy a project file into the owning org's library (story 006-001 promote).
 * The org is derived server-side from the project. Under 011-004's
 * approval-required policy an editor's call returns 202 with `request`
 * (a pending suggestion — nothing copied yet) instead of `document`.
 */
export async function promoteFileToLibrary(
  projectId: number,
  path: string,
  title?: string,
): Promise<{ document?: OrgDocument; deduped?: boolean; request?: PromotionRequest }> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/files/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...(title ? { title } : {}) }),
    }),
  );
  return (await res.json()) as { document?: OrgDocument; deduped?: boolean; request?: PromotionRequest };
}

/** Ingestion lifecycle event on the org feed (story 006-002). */
export interface OrgDocStatusEvent {
  type: 'doc_status';
  docId: number;
  filename: string;
  status: OrgDocument['status'];
  statusDetail?: string;
}

export interface OrgFeedHandlers {
  onEvent: (event: OrgDocStatusEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}

/**
 * Subscribe to the org event feed (`doc_status` ingestion transitions) via
 * EventSource, which reconnects automatically. Returns an unsubscribe function.
 */
export function subscribeOrgEvents(orgId: number, handlers: OrgFeedHandlers): () => void {
  const source = new EventSource(`${BACKEND_URL}/api/orgs/${orgId}/events`, { withCredentials: true });
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.();
  source.onmessage = (msg) => {
    try {
      handlers.onEvent(JSON.parse(msg.data) as OrgDocStatusEvent);
    } catch {
      // Malformed frame — skip; the stream itself is still healthy.
    }
  };
  return () => source.close();
}

// ---- Kuhn knowledge catalog (issue #65) ----

/** One catalog item as any authenticated user sees it (no org state). */
export interface KnowledgeItem {
  id: string;
  title: string;
  kind: 'document' | 'knowledge-card';
  version: number;
  source_url: string | null;
  license: string | null;
  tags: string[];
  /** False when this deploy lacks the item's content file. */
  available: boolean;
}

/** A catalog item merged with one org's selection/import state. */
export interface OrgKnowledgeItem extends KnowledgeItem {
  enabled: boolean;
  doc_id: number | null;
  doc_status: OrgDocument['status'] | null;
  doc_status_detail: string | null;
  imported_version: number | null;
  /** The catalog moved past the imported copy — offer re-import. */
  update_available: boolean;
}

/** A package node; `parent` links one level of nesting (null at top level). */
export interface KnowledgePackage<TItem extends KnowledgeItem = KnowledgeItem> {
  id: string;
  parent: string | null;
  title: string;
  description: string | null;
  available: boolean;
  items: TItem[];
}

/** The Kuhn-curated catalog tree. Any authenticated user. */
export async function getKnowledgeCatalog(): Promise<KnowledgePackage[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/knowledge/catalog`));
  return ((await res.json()) as { packages: KnowledgePackage[] }).packages;
}

/** The catalog merged with this org's per-item state. Org members. */
export async function getOrgKnowledge(orgId: number): Promise<KnowledgePackage<OrgKnowledgeItem>[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/knowledge`));
  return ((await res.json()) as { packages: KnowledgePackage<OrgKnowledgeItem>[] }).packages;
}

/**
 * Enable/disable catalog items for the org (owner-only). Enabling imports the
 * items into the org library; disabling removes the imported copies. Returns
 * the refreshed merged state.
 */
export async function putKnowledgeSelections(
  orgId: number,
  changes: { enable?: string[]; disable?: string[] },
): Promise<KnowledgePackage<OrgKnowledgeItem>[]> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/knowledge/selections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    }),
  );
  return ((await res.json()) as { packages: KnowledgePackage<OrgKnowledgeItem>[] }).packages;
}

/** Re-import enabled items (failed ingests, catalog version bumps). Owner-only. */
export async function reimportKnowledgeItems(
  orgId: number,
  items: string[],
): Promise<KnowledgePackage<OrgKnowledgeItem>[]> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs/${orgId}/knowledge/reimport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    }),
  );
  return ((await res.json()) as { packages: KnowledgePackage<OrgKnowledgeItem>[] }).packages;
}

// ---- File activity & project feed (stories 005-001/002/003) ----

/** One row of the persisted per-project file event log. */
export interface FileActivityEvent {
  id: number;
  path: string;
  // 'moved' (story 012-002): `path` is the new path, `meta.from` the old one.
  // 'rename' is dormant — kept so historical rows stay typed.
  kind: 'create' | 'update' | 'delete' | 'rename' | 'moved';
  /** Parsed JSON sidecar; `{ from }` on a 'moved' row (story 012-002). */
  meta?: { from?: string } | null;
  agent_slug: string | null; // null = user action
  job_id: number | null;
  /** Review link id when the event was an external reviewer's edit (epic 013);
   *  drives the "external reviewer" origin badge. */
  review_link_id?: number | null;
  /** That link's claimed reviewer name, joined at read time. */
  reviewer_name?: string | null;
  created_at: string;
}

/** Recent file events, newest first (hydrates badge origin on load). */
export async function getFileActivity(projectId: number, limit = 200): Promise<FileActivityEvent[]> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/files/activity?limit=${limit}`),
  );
  return ((await res.json()) as { events: FileActivityEvent[] }).events;
}

/** Mark a file seen by the current user — clears its new/changed badge. */
export async function markFileSeen(projectId: number, path: string): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/files/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
}

export interface ProjectFeedHandlers {
  onEvent: (event: AgentEvent) => void;
  /** Feed (re)connected — job-stream fallbacks can stand down. */
  onOpen?: () => void;
  /** Feed dropped; EventSource retries automatically with backoff. */
  onError?: () => void;
}

/**
 * Subscribe to the always-on project event feed (story 005-001) via
 * EventSource, which reconnects automatically after drops (the story-028
 * resilience pattern for free). Returns an unsubscribe function.
 */
export function subscribeProjectEvents(
  projectId: number,
  handlers: ProjectFeedHandlers,
): () => void {
  const source = new EventSource(`${BACKEND_URL}/api/projects/${projectId}/events`, { withCredentials: true });
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.();
  source.onmessage = (msg) => {
    try {
      handlers.onEvent(JSON.parse(msg.data) as AgentEvent);
    } catch {
      // Malformed frame — skip; the stream itself is still healthy.
    }
  };
  return () => source.close();
}

/** Delete a project file or directory. */
export async function deleteFile(projectId: number, path: string): Promise<void> {
  await expectOk(await apiFetch(fileUrl(projectId, path), { method: 'DELETE' }));
}

/**
 * Move/rename an entry; rejects with an ApiError carrying the backend's
 * readable message (409 on a destination that already exists or that holds a
 * pending edit, 400 when the destination is inside the source).
 * Resolves with the CANONICAL paths storage actually operated on — `'a//b'`
 * and `'dir/'` rename fine on disk but are not what the tree is keyed by.
 */
export async function moveFile(
  projectId: number,
  from: string,
  to: string,
): Promise<{ from: string; to: string }> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    }),
  );
  return (await res.json()) as { from: string; to: string };
}

/**
 * Create an empty folder (story 012-001). Resolves with the canonical path and
 * whether it had to be created — an existing folder is a 200 `created:false`,
 * not an error, so a double-submit is harmless. A FILE already holding the
 * path rejects with an ApiError whose `code` is 'conflict'.
 * Publishes no project event: other tabs see it on their next tree refresh.
 */
export async function createFolder(
  projectId: number,
  path: string,
): Promise<{ path: string; created: boolean }> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/files/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
  return (await res.json()) as { path: string; created: boolean };
}

/** Fetch raw file bytes (correct Content-Type) for previewing. */
export async function fetchFileBlob(projectId: number, path: string): Promise<Blob> {
  const res = await expectOk(await apiFetch(fileUrl(projectId, path)));
  return res.blob();
}

/** Direct URL of a stored file (e.g. an `<a download>` target for unknown types). */
export const fileBlobUrl = (projectId: number, path: string): string => fileUrl(projectId, path);

// ---- Render & export (story 019) ----

/** Render a markdown document to PDF; rejects with the backend's readable error. */
export async function renderPdf(projectId: number, path: string): Promise<Blob> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
  return res.blob();
}

/** URL of the Pandoc export endpoint (served with Content-Disposition: attachment). */
export function exportUrl(projectId: number, path: string, format: 'docx' | 'tex'): string {
  return `${BACKEND_URL}/api/projects/${projectId}/export?path=${encodeURIComponent(path)}&format=${format}`;
}

// ---- Citations (story 016) ----

export interface CitationCandidate {
  pmid: string;
  title: string;
  authors: string[];
  journal: string;
  year: string | null;
  doi: string | null;
}

/** Search PubMed for citation candidates (story 016). */
export async function searchCitations(
  projectId: number,
  query: string,
  max = 8,
  signal?: AbortSignal,
): Promise<CitationCandidate[]> {
  const res = await expectOk(
    await apiFetch(
      `${BACKEND_URL}/api/projects/${projectId}/citations/search?q=${encodeURIComponent(query)}&max=${max}`,
      { signal },
    ),
  );
  return ((await res.json()) as { candidates: CitationCandidate[] }).candidates;
}

/** Upsert a PubMed work into the project bibliography; returns its BibTeX key. */
export async function addCitation(
  projectId: number,
  pmid: string,
): Promise<{ key: string; created: boolean; path: string }> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/citations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pmid }),
    }),
  );
  return (await res.json()) as { key: string; created: boolean; path: string };
}

/** Recent top-level conversations with messages, newest first (story 020). */
export async function getConversations(projectId: number, limit = 20): Promise<Conversation[]> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/conversations?limit=${limit}`),
  );
  return ((await res.json()) as { conversations: Conversation[] }).conversations;
}

/** List agent jobs for a project, newest first. */
export async function listJobs(projectId: number): Promise<Job[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/agent/jobs?projectId=${projectId}`));
  return ((await res.json()) as { jobs: Job[] }).jobs;
}

/** Answer a running job's pending ask_user question (story 012). */
export async function replyToAgent(jobId: number, reply: string): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/agent/jobs/${jobId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply }),
    }),
  );
}

export interface PendingQuestion {
  jobId: number;
  role: string;
  agent: string;
  question: string;
}

/**
 * Runs that are alive and parked on an ask_user question with no attached
 * stream — i.e. ones to reconnect to after a page reload (story 027).
 */
export async function getPendingQuestions(projectId: number): Promise<PendingQuestion[]> {
  const res = await expectOk(await apiFetch(`${BACKEND_URL}/api/agent/pending?projectId=${projectId}`));
  return ((await res.json()) as { pending: PendingQuestion[] }).pending;
}

/**
 * Re-attach to a still-alive run after a reload (story 027). The server
 * re-emits the pending `question` event, then streams subsequent live events.
 */
export async function reconnectAgent(
  jobId: number,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/agent/jobs/${jobId}/reconnect`, { method: 'POST', signal }),
  );
  await readEventStream(res, onEvent);
}

export interface AgentTaskParams {
  role: string;
  projectId: number;
  input: string;
  sessionId?: string;
  /** `dir` (story 012-001) is the folder the user has selected in the file
   *  panel, sent ONLY when it is inside draft/ — see chat.ts for why. */
  context?: { selection?: string; cursor?: { line: number }; files?: string[]; dir?: string };
  /** Compose mode (story 017): writer returns text only, no file writes. */
  compose?: boolean;
}

/**
 * Run an agent task, invoking onEvent for each streamed AgentEvent.
 * Resolves when the stream ends; abort via the signal.
 */
export async function runAgentTask(
  params: AgentTaskParams,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/agent/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    }),
  );
  await readEventStream(res, onEvent);
}

/**
 * Run the project seeding pipeline (story 015), invoking onEvent for each
 * stage marker and agent event. Resolves when the pipeline ends.
 */
export async function seedProject(
  projectId: number,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/seed`, { method: 'POST', signal }),
  );
  await readEventStream(res, onEvent);
}

async function readEventStream(res: Response, onEvent: (event: AgentEvent) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; each frame is "data: <json>"
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) {
          onEvent(JSON.parse(line.slice(6)) as AgentEvent);
        }
      }
    }
  }
}
