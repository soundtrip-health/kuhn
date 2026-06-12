// Backend client: projects, files (story 018 API), and the agent task SSE
// stream (story 011 events + story 013 text_delta).

export const BACKEND_URL: string =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:3002';

export const BACKEND_WS_URL = BACKEND_URL.replace(/^http/, 'ws');

export interface Project {
  id: number;
  name: string;
  project_type: string;
  owner_id: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeNode[];
}

export interface AgentEvent {
  type: 'text_delta' | 'text' | 'file_change' | 'citation' | 'question' | 'question_expired' | 'done' | 'error' | 'stage';
  agent: string;
  content?: string;
  path?: string;
  kind?: 'create' | 'update' | 'delete';
  // Citation upsert by an agent (story 016)
  key?: string;
  bibtex?: string | null;
  jobId?: number;
  sessionId?: string;
  usage?: { inputTokens: number; outputTokens: number };
  message?: string;
  // Seeding pipeline stage markers (story 015)
  stage?: string;
  status?: 'start' | 'done' | 'error';
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

export async function listProjects(): Promise<Project[]> {
  const res = await expectOk(await fetch(`${BACKEND_URL}/api/projects`));
  return ((await res.json()) as { projects: Project[] }).projects;
}

export async function createProject(name: string, projectType = 'manuscript'): Promise<Project> {
  const res = await expectOk(
    await fetch(`${BACKEND_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, projectType }),
    }),
  );
  return ((await res.json()) as { project: Project }).project;
}

export async function getTree(projectId: number): Promise<TreeNode[]> {
  const res = await expectOk(await fetch(`${BACKEND_URL}/api/projects/${projectId}/files`));
  return ((await res.json()) as { tree: TreeNode[] }).tree;
}

const fileUrl = (projectId: number, path: string) =>
  `${BACKEND_URL}/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`;

/** Read a text file; returns null if it does not exist. */
export async function readTextFile(projectId: number, path: string): Promise<string | null> {
  const res = await fetch(fileUrl(projectId, path));
  if (res.status === 404) return null;
  await expectOk(res);
  return res.text();
}

export async function writeTextFile(projectId: number, path: string, content: string): Promise<void> {
  await expectOk(
    await fetch(fileUrl(projectId, path), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    }),
  );
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
    await fetch(
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
    await fetch(`${BACKEND_URL}/api/projects/${projectId}/citations`, {
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
    await fetch(`${BACKEND_URL}/api/projects/${projectId}/conversations?limit=${limit}`),
  );
  return ((await res.json()) as { conversations: Conversation[] }).conversations;
}

/** List agent jobs for a project, newest first. */
export async function listJobs(projectId: number): Promise<Job[]> {
  const res = await expectOk(await fetch(`${BACKEND_URL}/api/agent/jobs?projectId=${projectId}`));
  return ((await res.json()) as { jobs: Job[] }).jobs;
}

/** Answer a running job's pending ask_user question (story 012). */
export async function replyToAgent(jobId: number, reply: string): Promise<void> {
  await expectOk(
    await fetch(`${BACKEND_URL}/api/agent/jobs/${jobId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply }),
    }),
  );
}

export interface AgentTaskParams {
  role: string;
  projectId: number;
  input: string;
  sessionId?: string;
  context?: { selection?: string; cursor?: { line: number }; files?: string[] };
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
    await fetch(`${BACKEND_URL}/api/agent/task`, {
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
    await fetch(`${BACKEND_URL}/api/projects/${projectId}/seed`, { method: 'POST', signal }),
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
