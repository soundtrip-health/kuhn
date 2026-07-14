// Backend client: projects, files (story 018 API), and the agent task SSE
// stream (story 011 events + story 013 text_delta).

export const BACKEND_URL: string =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:3002';

export const BACKEND_WS_URL = BACKEND_URL.replace(/^http/, 'ws');

/**
 * Every backend call goes through here (story 007-002): the session cookie
 * rides along (credentials — the webapp dev server is a different origin than
 * the backend), and any 401 raises `kuhn:unauthorized` so login.ts can put up
 * the sign-in screen no matter which call hit the wall.
 */
async function apiFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, { credentials: 'include', ...init });
  if (res.status === 401) window.dispatchEvent(new CustomEvent('kuhn:unauthorized'));
  return res;
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

export interface Org {
  id: number;
  name: string;
  slug: string;
  role: 'owner' | 'member';
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
  type: 'text_delta' | 'text' | 'file_change' | 'citation' | 'question' | 'question_expired' | 'notice' | 'done' | 'error' | 'stage' | 'job';
  agent: string;
  /** Feed envelope timestamp — present on project-feed events (story 005-001). */
  ts?: string;
  content?: string;
  path?: string;
  kind?: 'create' | 'update' | 'delete';
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

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return res;
}

// ---- Auth (story 007-002) ----

export interface Me {
  user: { id: number; email: string; display_name: string | null };
  mode: 'dev' | 'magic-link';
}

/** The signed-in user and auth mode; null when not authenticated. */
export async function fetchMe(): Promise<Me | null> {
  const res = await apiFetch(`${BACKEND_URL}/api/auth/me`);
  if (res.status === 401) return null;
  await expectOk(res);
  return (await res.json()) as Me;
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

/** Create an organization (the current user becomes its owner). */
export async function createOrg(name: string): Promise<Org> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
  return ((await res.json()) as { org: Org }).org;
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

export async function writeTextFile(projectId: number, path: string, content: string): Promise<void> {
  await expectOk(
    await apiFetch(fileUrl(projectId, path), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    }),
  );
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
 * The org is derived server-side from the project.
 */
export async function promoteFileToLibrary(
  projectId: number,
  path: string,
  title?: string,
): Promise<{ document: OrgDocument; deduped: boolean }> {
  const res = await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/files/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...(title ? { title } : {}) }),
    }),
  );
  return (await res.json()) as { document: OrgDocument; deduped: boolean };
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

// ---- File activity & project feed (stories 005-001/002/003) ----

/** One row of the persisted per-project file event log. */
export interface FileActivityEvent {
  id: number;
  path: string;
  kind: 'create' | 'update' | 'delete' | 'rename';
  agent_slug: string | null; // null = user action
  job_id: number | null;
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

/** Move/rename an entry; rejects with the backend's readable error (409 on a
 * destination that already exists). */
export async function moveFile(projectId: number, from: string, to: string): Promise<void> {
  await expectOk(
    await apiFetch(`${BACKEND_URL}/api/projects/${projectId}/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    }),
  );
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
  context?: { selection?: string; cursor?: { line: number }; files?: string[] };
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
