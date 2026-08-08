import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../db/conversation.js', () => ({ listProjectConversations: vi.fn(async () => []) }));
vi.mock('../db/projects.js', () => ({
  getProject: vi.fn(),
  listProjectsForUser: vi.fn(async () => []),
  createProject: vi.fn(),
  setActiveDocument: vi.fn(async () => ({})),
  updateProjectConfig: vi.fn(async (id, fields) => ({ id, ...fields })),
}));
vi.mock('../agents/project-config.js', () => ({
  applyProjectConfig: vi.fn(async (id) => ({ project: { id, config: { setup: { status: 'complete' } } }, created: true })),
}));
vi.mock('../db/orgs.js', () => ({
  checkOrgAccess: vi.fn(),
  listUserOrgs: vi.fn(async () => []),
  primaryOrgId: vi.fn(async () => 7),
}));
vi.mock('../agents/seeding.js', () => ({ runSeedPipeline: vi.fn() }));
// Promote policy branch (story 011-004): settings, request store, library
// store, and file reads are all seams here — the real wiring runs in
// routes/promotions.test.js against real SQLite and a temp storage root.
vi.mock('../db/org-settings.js', () => ({ getOrgSettings: vi.fn() }));
vi.mock('../db/promotions.js', () => ({ createPromotionRequest: vi.fn() }));
vi.mock('./org-library.js', () => ({ storeOrgDocument: vi.fn() }));
vi.mock('../storage.js', () => {
  class StorageError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  return {
    StorageError,
    readProjectFile: vi.fn(),
    // history.js (loaded via the real project-events hub) also imports these.
    resolveProjectDir: vi.fn(),
    resolveSafe: vi.fn(),
  };
});
// Covers both this router's imports and the real project-events hub's
// persistence hook; the SQL itself is tested in db/file-activity.test.js.
vi.mock('../db/file-activity.js', () => ({
  recordFileEvent: vi.fn(),
  markSeen: vi.fn(),
  listFileActivity: vi.fn(() => []),
  unseenPaths: vi.fn(() => new Set()),
  migrateSeenPaths: vi.fn(),
}));

import { runSeedPipeline } from '../agents/seeding.js';
import { listProjectConversations } from '../db/conversation.js';
import { checkOrgAccess, listUserOrgs, primaryOrgId } from '../db/orgs.js';
import {
  getProject,
  listProjectsForUser,
  createProject,
  setActiveDocument,
  updateProjectConfig,
} from '../db/projects.js';
import { applyProjectConfig } from '../agents/project-config.js';
import { getOrgSettings } from '../db/org-settings.js';
import { createPromotionRequest } from '../db/promotions.js';
import { storeOrgDocument } from './org-library.js';
import { readProjectFile } from '../storage.js';
import projectsRouter from './projects.js';
import { config } from '../config.js';
import { markSeen, listFileActivity } from '../db/file-activity.js';
import { publishProjectEvent, projectSubscriberCount } from '../project-events.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand in for the session middleware: every request has a current user.
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(projectsRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(() => new Promise((ok) => server.close(ok)));

const RANK = { viewer: 1, editor: 2, owner: 3 };
/** Emulate the chokepoint's rank check for a granted role (010-003). */
const grantRole = (role) => checkOrgAccess.mockImplementation(
  async (_userId, orgId, minRole = 'viewer') => (
    RANK[role] >= RANK[minRole]
      ? { ok: true, role, org: { id: Number(orgId), status: 'active', settings: {} } }
      : { ok: false, reason: 'role', role }
  ),
);
const denyAccess = (reason) => checkOrgAccess.mockImplementation(
  async () => ({ ok: false, reason }),
);

beforeEach(() => {
  vi.clearAllMocks();
  grantRole('owner');
  listUserOrgs.mockResolvedValue([]);
  primaryOrgId.mockResolvedValue(7);
});

describe('GET /api/projects (story 005 — org scoped)', () => {
  it('returns only the session user\'s projects', async () => {
    listProjectsForUser.mockResolvedValue([{ id: 1, name: 'A', org_id: 7 }]);
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [{ id: 1, name: 'A', org_id: 7 }] });
    expect(listProjectsForUser).toHaveBeenCalledWith(1);
  });

  it('excludes projects of suspended orgs (story 011-001)', async () => {
    listProjectsForUser.mockResolvedValue([
      { id: 1, name: 'Alive', org_id: 7 },
      { id: 2, name: 'Frozen', org_id: 8 },
    ]);
    listUserOrgs.mockResolvedValue([
      { id: 7, status: 'active' },
      { id: 8, status: 'suspended' },
    ]);
    const res = await fetch(`${base}/api/projects`);
    expect(await res.json()).toEqual({ projects: [{ id: 1, name: 'Alive', org_id: 7 }] });
  });
});

describe('POST /api/projects (story 005)', () => {
  it('400s without a name', async () => {
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('creates in the user\'s primary org when no orgId is given', async () => {
    createProject.mockResolvedValue({ id: 9, name: 'New', org_id: 7 });
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    });
    expect(res.status).toBe(201);
    expect(primaryOrgId).toHaveBeenCalledWith(1);
    expect(createProject).toHaveBeenCalledWith({ name: 'New', projectType: 'manuscript', orgId: 7 });
  });

  it('honors an orgId the user holds editor in', async () => {
    createProject.mockResolvedValue({ id: 10, org_id: 3 });
    await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', orgId: 3 }),
    });
    expect(checkOrgAccess).toHaveBeenCalledWith(1, 3, 'editor');
    expect(createProject).toHaveBeenCalledWith({ name: 'X', projectType: 'manuscript', orgId: 3 });
  });

  it('404s (non-leaking) for an org the user does not belong to', async () => {
    denyAccess('not-member');
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', orgId: 999 }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'organization not found' });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('403s a viewer — creating projects needs editor (010-003)', async () => {
    grantRole('viewer');
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'requires editor role' });
    expect(createProject).not.toHaveBeenCalled();
  });
});

describe('PUT /api/projects/:id/active-document (story 006)', () => {
  it('persists the open document path', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    setActiveDocument.mockResolvedValue({ activeDocument: 'draft/main.md' });
    const res = await fetch(`${base}/api/projects/3/active-document`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'draft/main.md' }),
    });
    expect(res.status).toBe(200);
    expect(setActiveDocument).toHaveBeenCalledWith(3, 'draft/main.md');
  });

  it('404s for a project in another org', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    denyAccess('not-member');
    const res = await fetch(`${base}/api/projects/3/active-document`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'draft/main.md' }),
    });
    expect(res.status).toBe(404);
    expect(setActiveDocument).not.toHaveBeenCalled();
  });
});

describe('GET /api/projects/:id/conversations (story 020)', () => {
  it('returns the recent conversations with a default limit', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    listProjectConversations.mockResolvedValue([{ id: 1, agent_slug: 'pm', messages: [] }]);
    const res = await fetch(`${base}/api/projects/3/conversations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [{ id: 1, agent_slug: 'pm', messages: [] }] });
    expect(listProjectConversations).toHaveBeenCalledWith(3, { limit: 20 });
  });

  it('passes the limit through', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    await fetch(`${base}/api/projects/3/conversations?limit=2`);
    expect(listProjectConversations).toHaveBeenCalledWith(3, { limit: 2 });
  });
});

describe('POST /api/projects/:id/seed (story 015)', () => {
  it('404s for an unknown project', async () => {
    getProject.mockResolvedValue(undefined);
    const res = await fetch(`${base}/api/projects/99/seed`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(runSeedPipeline).not.toHaveBeenCalled();
  });

  it('streams the pipeline events as SSE', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7, config: {} });
    runSeedPipeline.mockReturnValue((async function* () {
      yield { type: 'stage', stage: 'research', status: 'start' };
      yield { type: 'text', agent: 'pm', content: 'hi' };
    })());

    const res = await fetch(`${base}/api/projects/3/seed`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = (await res.text()).trim().split('\n\n').map((f) => JSON.parse(f.replace(/^data: /, '')));
    expect(frames).toEqual([
      { type: 'stage', stage: 'research', status: 'start' },
      { type: 'text', agent: 'pm', content: 'hi' },
    ]);
    // The seeding user is stamped on every stage's records (story 007-001).
    expect(runSeedPipeline).toHaveBeenCalledWith(3, { userId: 1 });
  });
});

describe('file seen & activity endpoints (story 005-002)', () => {
  it('marks a file seen for the session user', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    const res = await fetch(`${base}/api/projects/3/files/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'draft/main.md' }),
    });
    expect(res.status).toBe(200);
    expect(markSeen).toHaveBeenCalledWith(1, 3, 'draft/main.md');
  });

  it('400s without a path and 404s for non-members', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    const noPath = await fetch(`${base}/api/projects/3/files/seen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(noPath.status).toBe(400);
    expect(markSeen).not.toHaveBeenCalled();

    denyAccess('not-member');
    const forbidden = await fetch(`${base}/api/projects/3/files/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'x.md' }),
    });
    expect(forbidden.status).toBe(404);
  });

  it('lists recent activity, passing since/limit through', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    listFileActivity.mockReturnValue([{ path: 'a.md', kind: 'create' }]);
    const res = await fetch(`${base}/api/projects/3/files/activity?since=2026-07-01&limit=5`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [{ path: 'a.md', kind: 'create' }] });
    expect(listFileActivity).toHaveBeenCalledWith(3, { since: '2026-07-01', limit: '5' });
  });
});

describe('GET /api/projects/:id/events (story 005-001)', () => {
  /** Read SSE frames until a `data:` line arrives, then return its payload. */
  async function nextDataFrame(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (let i = 0; i < 20; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const match = buf.match(/^data: (.*)$/m);
      if (match) {
        reader.releaseLock();
        return JSON.parse(match[1]);
      }
    }
    throw new Error(`no data frame in: ${buf}`);
  }

  it('404s for non-members without leaking existence', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    denyAccess('not-member');
    const res = await fetch(`${base}/api/projects/3/events`);
    expect(res.status).toBe(404);
  });

  it('delivers published events to every open feed', async () => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    const ac = new AbortController();
    try {
      const [res1, res2] = await Promise.all([
        fetch(`${base}/api/projects/3/events`, { signal: ac.signal }),
        fetch(`${base}/api/projects/3/events`, { signal: ac.signal }),
      ]);
      expect(res1.status).toBe(200);
      expect(res1.headers.get('content-type')).toContain('text/event-stream');

      // Headers received ⇒ the subscription is registered server-side.
      publishProjectEvent(3, { type: 'file_change', agent: 'writer', path: 'draft/main.md', kind: 'update' });

      const [e1, e2] = await Promise.all([nextDataFrame(res1.body), nextDataFrame(res2.body)]);
      for (const e of [e1, e2]) {
        expect(e).toMatchObject({ type: 'file_change', path: 'draft/main.md', kind: 'update' });
        expect(typeof e.ts).toBe('string');
      }
    } finally {
      ac.abort();
    }
    // Disconnect cleans up the subscriptions.
    await vi.waitFor(() => expect(projectSubscriberCount(3)).toBe(0));
  });

  it('503s beyond the per-project subscriber cap', async () => {
    getProject.mockResolvedValue({ id: 4, org_id: 7 });
    const saved = config.projectEvents.maxSubscribers;
    config.projectEvents.maxSubscribers = 1;
    const ac = new AbortController();
    try {
      const first = await fetch(`${base}/api/projects/4/events`, { signal: ac.signal });
      expect(first.status).toBe(200);
      const second = await fetch(`${base}/api/projects/4/events`);
      expect(second.status).toBe(503);
    } finally {
      config.projectEvents.maxSubscribers = saved;
      ac.abort();
    }
    await vi.waitFor(() => expect(projectSubscriberCount(4)).toBe(0));
  });
});

describe('PUT /api/projects/:id/config', () => {
  const answers = {
    title: 'GLP-1 RWE Study',
    projectType: 'rwe-protocol',
    researchQuestion: 'Does GLP-1 use reduce MACE in T2D?',
    deliverables: ['FDA RWE protocol'],
    timeline: 'Draft by 2026-08-01',
    sourceMaterials: [],
  };

  beforeEach(() => getProject.mockResolvedValue({ id: 5, org_id: 7, config: {} }));

  it('saves a draft without writing project.json or validating', async () => {
    const res = await fetch(`${base}/api/projects/5/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: { title: '' }, draft: true }),
    });
    expect(res.status).toBe(200);
    expect(applyProjectConfig).not.toHaveBeenCalled();
    expect(updateProjectConfig).toHaveBeenCalledWith(5, {
      config: { setup: { status: 'draft', answers: expect.objectContaining({ title: '' }) } },
    });
  });

  it('final save writes canonical config + project.json and marks complete', async () => {
    const res = await fetch(`${base}/api/projects/5/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    expect(res.status).toBe(200);
    expect(applyProjectConfig).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        title: 'GLP-1 RWE Study',
        project_type: 'rwe-protocol',
        research_question: 'Does GLP-1 use reduce MACE in T2D?',
      }),
      { extraConfig: { setup: { status: 'complete', answers: expect.any(Object) } } },
    );
  });

  it('rejects a final save missing required fields', async () => {
    const res = await fetch(`${base}/api/projects/5/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: { ...answers, title: '', projectType: 'nope' } }),
    });
    expect(res.status).toBe(400);
    expect(applyProjectConfig).not.toHaveBeenCalled();
  });

  it('404s for a project the user cannot access', async () => {
    denyAccess('not-member');
    const res = await fetch(`${base}/api/projects/5/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    expect(res.status).toBe(404);
  });
});

describe('promote policy branch (story 011-004)', () => {
  const json = { 'Content-Type': 'application/json' };
  const promote = (body) => fetch(`${base}/api/projects/3/files/promote`, {
    method: 'POST', headers: json, body: JSON.stringify(body),
  });

  beforeEach(() => {
    getProject.mockResolvedValue({ id: 3, org_id: 7 });
    getOrgSettings.mockReturnValue({ promotion_policy: 'approval-required' });
    createPromotionRequest.mockReturnValue({
      request: { id: 44, project_id: 3, path: 'x.md', status: 'pending' },
      existing: false,
    });
  });

  it('202s an editor suggestion under approval-required — no file read, no library write', async () => {
    grantRole('editor');
    const res = await promote({ path: 'x.md', title: '  Title  ', note: '  why  ' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      request: { id: 44, project_id: 3, path: 'x.md', status: 'pending' },
    });
    expect(createPromotionRequest).toHaveBeenCalledWith({
      orgId: 7, projectId: 3, path: 'x.md', title: 'Title', note: 'why', suggestedBy: 1,
    });
    expect(readProjectFile).not.toHaveBeenCalled();
    expect(storeOrgDocument).not.toHaveBeenCalled();
  });

  it('200s a duplicate suggestion with the existing pending request', async () => {
    grantRole('editor');
    createPromotionRequest.mockReturnValue({
      request: { id: 44, path: 'x.md', status: 'pending' },
      existing: true,
    });
    const res = await promote({ path: 'x.md' });
    expect(res.status).toBe(200);
    expect((await res.json()).request.id).toBe(44);
  });

  it('keeps owners on the direct path regardless of policy', async () => {
    grantRole('owner');
    readProjectFile.mockResolvedValue(Buffer.from('# doc'));
    storeOrgDocument.mockResolvedValue({ document: { id: 9, org_id: 7 }, deduped: false });
    const res = await promote({ path: 'sop.md', title: 'SOP' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ document: { id: 9, org_id: 7 }, deduped: false });
    expect(createPromotionRequest).not.toHaveBeenCalled();
    expect(storeOrgDocument).toHaveBeenCalledWith(7, Buffer.from('# doc'), {
      filename: 'sop.md', title: 'SOP', source: 'project-promotion',
      sourceProjectId: 3, createdBy: 1,
    });
  });

  it("sends editors down the direct path when the org opted into policy 'direct' (AC5)", async () => {
    grantRole('editor');
    getOrgSettings.mockReturnValue({ promotion_policy: 'direct' });
    readProjectFile.mockResolvedValue(Buffer.from('bytes'));
    storeOrgDocument.mockResolvedValue({ document: { id: 5 }, deduped: false });
    const res = await promote({ path: 'a.md' });
    expect(res.status).toBe(201);
    expect(createPromotionRequest).not.toHaveBeenCalled();
    expect(storeOrgDocument).toHaveBeenCalled();
  });
});

describe('role tightening (story 010-003)', () => {
  beforeEach(() => {
    getProject.mockResolvedValue({ id: 3, org_id: 7, config: {} });
  });

  it('viewers keep their reads: activity, conversations, seen', async () => {
    grantRole('viewer');
    expect((await fetch(`${base}/api/projects/3/files/activity`)).status).toBe(200);
    expect((await fetch(`${base}/api/projects/3/conversations`)).status).toBe(200);
    const seen = await fetch(`${base}/api/projects/3/files/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'draft/main.md' }),
    });
    expect(seen.status).toBe(200);
  });

  it('viewers cannot rename, save config, seed, promote, or set the active document', async () => {
    grantRole('viewer');
    const json = { 'Content-Type': 'application/json' };
    const denied = [
      fetch(`${base}/api/projects/3`, { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'N' }) }),
      fetch(`${base}/api/projects/3/config`, { method: 'PUT', headers: json, body: JSON.stringify({ answers: {} }) }),
      fetch(`${base}/api/projects/3/active-document`, { method: 'PUT', headers: json, body: JSON.stringify({ path: 'x.md' }) }),
      fetch(`${base}/api/projects/3/seed`, { method: 'POST' }),
      fetch(`${base}/api/projects/3/files/promote`, { method: 'POST', headers: json, body: JSON.stringify({ path: 'x.md' }) }),
    ];
    for (const go of denied) {
      const res = await go;
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'requires editor role' });
    }
    expect(runSeedPipeline).not.toHaveBeenCalled();
    expect(updateProjectConfig).not.toHaveBeenCalled();
  });

  it('403s reads and writes alike once the org is suspended', async () => {
    denyAccess('suspended');
    for (const go of [
      fetch(`${base}/api/projects/3/files/activity`),
      fetch(`${base}/api/projects/3/conversations`),
      fetch(`${base}/api/projects/3`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'N' }),
      }),
    ]) {
      const res = await go;
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'organization suspended' });
    }
  });
});
