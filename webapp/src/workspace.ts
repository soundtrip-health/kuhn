// Active workspace state (stories 006 + 007): the single source of truth for
// which organization, project, and document are active. The org/project
// switcher, the projects dashboard, the breadcrumb, and main.ts's editor
// orchestration all read and mutate this one store rather than each tracking
// their own copy. Consumers subscribe() and re-render on the change kinds they
// care about; main.ts owns the side effects (wiring chat/files/preview and
// opening the document) in response to 'project'/'document' changes.

import {
  createOrg as apiCreateOrg,
  createProject as apiCreateProject,
  listOrgProjects,
  listOrgs,
  renameProject as apiRenameProject,
  setActiveDocument as apiSetActiveDocument,
  type Org,
  type Project,
  type Role,
} from './api';

/** What changed, so subscribers can re-render the minimum. */
export type WorkspaceChange = 'init' | 'orgs' | 'projects' | 'project' | 'document';

interface State {
  orgs: Org[];
  activeOrgId: number | null;
  projects: Project[]; // projects in the active org
  activeProjectId: number | null;
  activeDocPath: string; // the open document, '' when none
  projectsLoading: boolean; // a project-list fetch is in flight (story 005-004)
  projectsError: string | null; // last project-list fetch failure, if any
  bootstrapped: boolean; // initWorkspace completed its first org load (epic 011)
}

const state: State = {
  orgs: [],
  activeOrgId: null,
  projects: [],
  activeProjectId: null,
  activeDocPath: '',
  projectsLoading: false,
  projectsError: null,
  bootstrapped: false,
};

type Listener = (change: WorkspaceChange) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(change: WorkspaceChange): void {
  syncSuspendedBanner();
  for (const fn of [...listeners]) fn(change);
}

// ---- Getters ----------------------------------------------------------------

export const orgs = (): Org[] => state.orgs;
export const activeOrg = (): Org | null =>
  state.orgs.find((o) => o.id === state.activeOrgId) ?? null;
export const projects = (): Project[] => state.projects;
export const activeProject = (): Project | null =>
  state.projects.find((p) => p.id === state.activeProjectId) ?? null;
export const activeDocPath = (): string => state.activeDocPath;
export const projectsLoading = (): boolean => state.projectsLoading;
export const projectsError = (): string | null => state.projectsError;

// ---- Roles & org status (010-003 + epic 011) ---------------------------------

/** The current user's role in the active org; null when no org is active. */
export const activeOrgRole = (): Role | null => activeOrg()?.role ?? null;

/** True when the user may mutate content in the active org (editor or owner). */
export const canEdit = (): boolean => {
  const role = activeOrgRole();
  return role === 'editor' || role === 'owner';
};

/** True when the user administers the active org. */
export const isOwner = (): boolean => activeOrgRole() === 'owner';

/** True once bootstrap finished with zero orgs — the "ask your admin for an
 *  invitation" empty state (invitation-only front door, epic 011). */
export const hasNoOrgs = (): boolean => state.bootstrapped && state.orgs.length === 0;

/** True when the active org is suspended: fetches into it would 403, so the
 *  UI shows the suspended banner instead of firing them. */
export const activeOrgSuspended = (): boolean => activeOrg()?.status === 'suspended';

const SUSPENDED_BANNER_ID = 'suspended-org-banner';

/** Keep a single suspended-org banner in sync with the active org's status. */
function syncSuspendedBanner(): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById(SUSPENDED_BANNER_ID);
  if (!activeOrgSuspended()) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = SUSPENDED_BANNER_ID;
  banner.setAttribute('role', 'alert');
  banner.textContent =
    'This organization is suspended. Its projects and library are unavailable until a platform administrator reactivates it.';
  banner.style.cssText =
    'padding:8px 16px;text-align:center;font-size:13px;' +
    'background:var(--color-warning-bg, #7a2e2e);color:var(--color-warning-fg, #fff);';
  document.body.prepend(banner);
}

// Stale-role mitigation (epic 011): api.ts raises `kuhn:role-refresh` whenever
// a 403 carries a guard-shaped body (role change, suspension, super-admin).
// Re-fetch the org list so role-aware chrome re-renders against fresh state.
let roleRefreshInFlight = false;
if (typeof window !== 'undefined') {
  window.addEventListener('kuhn:role-refresh', () => {
    if (roleRefreshInFlight || !state.bootstrapped) return;
    roleRefreshInFlight = true;
    void listOrgs()
      .then((orgs) => {
        state.orgs = orgs;
        emit('orgs');
      })
      .catch(() => {
        /* transient — the next guard refusal retries */
      })
      .finally(() => {
        roleRefreshInFlight = false;
      });
  });
}

// ---- Loading / switching ----------------------------------------------------

/**
 * Bootstrap the workspace: load the user's orgs, pick the first as active, load
 * its projects, and pick the first project. Fires 'init'. Throws if the backend
 * is unreachable (the caller shows the connection error).
 */
export async function initWorkspace(): Promise<void> {
  state.orgs = await listOrgs();
  state.activeOrgId = state.orgs[0]?.id ?? null;
  state.bootstrapped = true;
  await loadProjects();
  // Boot keeps its throw-on-unreachable contract (main shows the banner).
  if (state.projectsError) throw new Error(state.projectsError);
  emit('init');
}

/** Fetch the active org's projects; failures land in projectsError instead of
 * rejecting, so UI callers can render a retryable state (story 005-004). */
async function loadProjects(): Promise<void> {
  state.projectsLoading = true;
  state.projectsError = null;
  try {
    // A suspended org 403s every content fetch — skip it and let the
    // suspended banner explain, instead of surfacing a generic error.
    state.projects =
      state.activeOrgId != null && !activeOrgSuspended()
        ? await listOrgProjects(state.activeOrgId)
        : [];
  } catch (err) {
    state.projects = [];
    state.projectsError = (err as Error).message;
  } finally {
    state.projectsLoading = false;
  }
  const next = activeProject();
  if (!next || next.org_id !== state.activeOrgId) {
    state.activeProjectId = state.projects[0]?.id ?? null;
    state.activeDocPath = activeProject()?.config?.activeDocument ?? '';
  }
}

/** Re-fetch the project list (retry affordance in the project browser). */
export async function reloadProjects(): Promise<void> {
  await loadProjects();
  emit('projects');
  emit('project');
}

/** Switch the active org, reloading its projects and selecting the first. */
export async function setActiveOrg(orgId: number): Promise<void> {
  if (orgId === state.activeOrgId) return;
  state.activeOrgId = orgId;
  state.activeProjectId = null;
  state.projects = [];
  state.projectsLoading = true;
  state.projectsError = null;
  emit('projects'); // let open views show the loading state during the switch
  await loadProjects();
  emit('projects');
  emit('project'); // active project changed as a side effect of the org switch
}

/** Switch the active project. Fires 'project'; main reacts by opening its doc. */
export function setActiveProject(projectId: number): void {
  if (projectId === state.activeProjectId) return;
  state.activeProjectId = projectId;
  state.activeDocPath = activeProject()?.config?.activeDocument ?? '';
  emit('project');
}

/**
 * Record the open document. Fires 'document' (so the breadcrumb tracks it) and
 * best-effort persists it to the project so reopening restores it. main calls
 * this once it has actually opened a file.
 */
export function setActiveDocument(path: string): void {
  if (path === state.activeDocPath) return;
  state.activeDocPath = path;
  emit('document');
  const projectId = state.activeProjectId;
  if (projectId != null && path) {
    void apiSetActiveDocument(projectId, path).catch(() => {
      /* persistence is best-effort — a failed write just won't be restored */
    });
  }
}

// ---- Creation ---------------------------------------------------------------

/** Create a project in the active org and switch to it. */
export async function createNewProject(name: string, projectType: string): Promise<Project> {
  const project = await apiCreateProject(name, projectType, state.activeOrgId ?? undefined);
  state.projects = [...state.projects, project];
  emit('projects');
  // Force a switch even if the id somehow matched: open the fresh project.
  state.activeProjectId = project.id;
  state.activeDocPath = project.config?.activeDocument ?? '';
  emit('project');
  return project;
}

/** Rename a project and update the store (fires 'projects', and 'project' when active). */
export async function renameProject(projectId: number, name: string): Promise<Project> {
  const updated = await apiRenameProject(projectId, name);
  state.projects = state.projects.map((p) => (p.id === projectId ? { ...p, name: updated.name } : p));
  emit('projects');
  if (projectId === state.activeProjectId) emit('project'); // breadcrumb tracks the name
  return updated;
}

/** Merge an updated project row into the store (fires 'projects', and 'project' when active). */
export function applyProjectUpdate(project: Project): void {
  state.projects = state.projects.map((p) => (p.id === project.id ? { ...p, ...project } : p));
  emit('projects');
  if (project.id === state.activeProjectId) emit('project');
}

/** Create an organization and switch to it (super-admin only since epic 011;
 *  `ownerEmail` names the first admin — pass your own email to keep access). */
export async function createNewOrg(name: string, ownerEmail?: string): Promise<Org> {
  const org = await apiCreateOrg(name, ownerEmail);
  state.orgs = [...state.orgs, org];
  emit('orgs');
  state.activeOrgId = org.id;
  state.activeProjectId = null;
  await loadProjects();
  emit('projects');
  emit('project');
  return org;
}
