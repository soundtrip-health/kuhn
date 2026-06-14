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
} from './api';

/** What changed, so subscribers can re-render the minimum. */
export type WorkspaceChange = 'init' | 'orgs' | 'projects' | 'project' | 'document';

interface State {
  orgs: Org[];
  activeOrgId: number | null;
  projects: Project[]; // projects in the active org
  activeProjectId: number | null;
  activeDocPath: string; // the open document, '' when none
}

const state: State = {
  orgs: [],
  activeOrgId: null,
  projects: [],
  activeProjectId: null,
  activeDocPath: '',
};

type Listener = (change: WorkspaceChange) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(change: WorkspaceChange): void {
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

// ---- Loading / switching ----------------------------------------------------

/**
 * Bootstrap the workspace: load the user's orgs, pick the first as active, load
 * its projects, and pick the first project. Fires 'init'. Throws if the backend
 * is unreachable (the caller shows the connection error).
 */
export async function initWorkspace(): Promise<void> {
  state.orgs = await listOrgs();
  state.activeOrgId = state.orgs[0]?.id ?? null;
  await loadProjects();
  emit('init');
}

async function loadProjects(): Promise<void> {
  state.projects = state.activeOrgId != null ? await listOrgProjects(state.activeOrgId) : [];
  const next = activeProject();
  if (!next || next.org_id !== state.activeOrgId) {
    state.activeProjectId = state.projects[0]?.id ?? null;
    state.activeDocPath = activeProject()?.config?.activeDocument ?? '';
  }
}

/** Switch the active org, reloading its projects and selecting the first. */
export async function setActiveOrg(orgId: number): Promise<void> {
  if (orgId === state.activeOrgId) return;
  state.activeOrgId = orgId;
  state.activeProjectId = null;
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

/** Create an organization and switch to it. */
export async function createNewOrg(name: string): Promise<Org> {
  const org = await apiCreateOrg(name);
  state.orgs = [...state.orgs, org];
  emit('orgs');
  state.activeOrgId = org.id;
  state.activeProjectId = null;
  await loadProjects();
  emit('projects');
  emit('project');
  return org;
}
