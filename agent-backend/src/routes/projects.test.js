import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../db/conversation.js', () => ({ listProjectConversations: vi.fn(async () => []) }));
vi.mock('../db/projects.js', () => ({
  getProject: vi.fn(),
  listProjectsForUser: vi.fn(async () => []),
  createProject: vi.fn(),
  setActiveDocument: vi.fn(async () => ({})),
}));
vi.mock('../db/orgs.js', () => ({
  isMember: vi.fn(async () => true),
  primaryOrgId: vi.fn(async () => 7),
}));
vi.mock('../agents/seeding.js', () => ({ runSeedPipeline: vi.fn() }));
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
import { isMember, primaryOrgId } from '../db/orgs.js';
import {
  getProject,
  listProjectsForUser,
  createProject,
  setActiveDocument,
} from '../db/projects.js';
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

beforeEach(() => {
  vi.clearAllMocks();
  isMember.mockResolvedValue(true);
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

  it('honors an orgId the user belongs to', async () => {
    createProject.mockResolvedValue({ id: 10, org_id: 3 });
    await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', orgId: 3 }),
    });
    expect(isMember).toHaveBeenCalledWith(1, 3);
    expect(createProject).toHaveBeenCalledWith({ name: 'X', projectType: 'manuscript', orgId: 3 });
  });

  it('403s for an org the user does not belong to', async () => {
    isMember.mockResolvedValue(false);
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', orgId: 999 }),
    });
    expect(res.status).toBe(403);
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
    isMember.mockResolvedValue(false);
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
      yield { type: 'stage', stage: 'interview', status: 'start' };
      yield { type: 'text', agent: 'pm', content: 'hi' };
    })());

    const res = await fetch(`${base}/api/projects/3/seed`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = (await res.text()).trim().split('\n\n').map((f) => JSON.parse(f.replace(/^data: /, '')));
    expect(frames).toEqual([
      { type: 'stage', stage: 'interview', status: 'start' },
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

    isMember.mockResolvedValue(false);
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
    isMember.mockResolvedValue(false);
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
