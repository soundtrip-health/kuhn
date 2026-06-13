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
    expect(runSeedPipeline).toHaveBeenCalledWith(3);
  });
});
