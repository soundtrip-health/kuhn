import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../db/conversation.js', () => ({ listProjectConversations: vi.fn(async () => []) }));
vi.mock('../db/projects.js', () => ({ getProject: vi.fn() }));
vi.mock('../agents/seeding.js', () => ({ runSeedPipeline: vi.fn() }));

import { runSeedPipeline } from '../agents/seeding.js';
import { listProjectConversations } from '../db/conversation.js';
import { getProject } from '../db/projects.js';
import projectsRouter from './projects.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(projectsRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(() => new Promise((ok) => server.close(ok)));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/projects/:id/conversations (story 020)', () => {
  it('returns the recent conversations with a default limit', async () => {
    listProjectConversations.mockResolvedValue([{ id: 1, agent_slug: 'pm', messages: [] }]);
    const res = await fetch(`${base}/api/projects/3/conversations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [{ id: 1, agent_slug: 'pm', messages: [] }] });
    expect(listProjectConversations).toHaveBeenCalledWith(3, { limit: 20 });
  });

  it('passes the limit through', async () => {
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
    getProject.mockResolvedValue({ id: 3, config: {} });
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
