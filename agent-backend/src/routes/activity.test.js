import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../db/orgs.js', () => ({ checkOrgAccess: vi.fn() }));
vi.mock('../agents/activity.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, chatActivitySnapshot: vi.fn(async () => []) };
});

import { checkOrgAccess } from '../db/orgs.js';
import { chatActivitySnapshot, publishChatActivity } from '../agents/activity.js';
import activityRouter from './activity.js';

let server;
let base;
const user = { id: 1 };

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(activityRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});
afterAll(() => new Promise((ok) => server.close(ok)));

beforeEach(() => {
  checkOrgAccess.mockReset();
  chatActivitySnapshot.mockReset();
  chatActivitySnapshot.mockResolvedValue([]);
});

/** Open the feed, collect `n` data frames, then close it. */
async function frames(orgId, n, act) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/orgs/${orgId}/activity`, { signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out = [];
  let buffer = '';
  const pump = (async () => {
    while (out.length < n) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (frame.startsWith('data: ')) out.push(JSON.parse(frame.slice(6)));
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 30));
  await act?.();
  await Promise.race([pump, new Promise((r) => setTimeout(r, 1500))]);
  ac.abort();
  return out;
}

describe('GET /api/orgs/:id/activity (issue #113 item 3)', () => {
  it('opens with a snapshot of the caller\'s chats, then streams their transitions', async () => {
    checkOrgAccess.mockResolvedValue({ ok: true, role: 'editor', org: { id: 3 } });
    chatActivitySnapshot.mockResolvedValue([{ type: 'chat', chatId: 1, projectId: 5, userId: 1, agent: 'pm', status: 'running', jobId: 30, question: null }]);
    const seen = await frames(3, 3, async () => {
      publishChatActivity(3, { chatId: 1, projectId: 5, userId: 1, agent: 'pm', status: 'waiting_for_user', jobId: 30, question: 'Which?' });
      publishChatActivity(3, { chatId: 2, projectId: 5, userId: 2, agent: 'pm', status: 'running', jobId: 31 }); // someone else's: withheld
      publishChatActivity(4, { chatId: 3, projectId: 9, userId: 1, agent: 'pm', status: 'running', jobId: 32 }); // another org
      publishChatActivity(3, { chatId: 1, projectId: 5, userId: 1, agent: 'pm', status: 'idle', jobId: 30 });
    });
    expect(chatActivitySnapshot).toHaveBeenCalledWith(3, { userId: 1, everyone: false });
    expect(seen).toEqual([
      { type: 'snapshot', chats: [{ type: 'chat', chatId: 1, projectId: 5, userId: 1, agent: 'pm', status: 'running', jobId: 30, question: null }] },
      { type: 'chat', chatId: 1, projectId: 5, userId: 1, agent: 'pm', status: 'waiting_for_user', jobId: 30, question: 'Which?', ts: expect.any(String) },
      { type: 'chat', chatId: 1, projectId: 5, userId: 1, agent: 'pm', status: 'idle', jobId: 30, question: null, ts: expect.any(String) },
    ]);
  });

  it('shows an owner every member\'s chats, without their question text', async () => {
    checkOrgAccess.mockResolvedValue({ ok: true, role: 'owner', org: { id: 3 } });
    const seen = await frames(3, 2, async () => {
      publishChatActivity(3, { chatId: 2, projectId: 5, userId: 2, agent: 'writer', status: 'waiting_for_user', jobId: 31, question: 'Private?' });
    });
    expect(chatActivitySnapshot).toHaveBeenCalledWith(3, { userId: 1, everyone: true });
    expect(seen[1]).toEqual({ type: 'chat', chatId: 2, projectId: 5, userId: 2, agent: 'writer', status: 'waiting_for_user', jobId: 31, question: null, ts: expect.any(String) });
  });

  it('refuses non-members with the non-leaking 404', async () => {
    checkOrgAccess.mockResolvedValue({ ok: false, reason: 'not-member' });
    const res = await fetch(`${base}/api/orgs/3/activity`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'organization not found' });
  });
});
