import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

// Real in-memory DB (the chat SQL is the substance — slide-themes.test.js
// pattern); the tenancy guard's access check and the hand-off scan's model
// call are mocked (covered in guards/tenancy-matrix and agents/handoff tests).
process.env.KUHN_SQLITE_PATH = ':memory:';
vi.mock('../db/orgs.js', () => ({ checkOrgAccess: vi.fn() }));
vi.mock('../agents/handoff.js', () => ({
  captureHandoff: vi.fn(async () => ({ handoff: 'Open: pick a journal.' })),
}));

import { checkOrgAccess } from '../db/orgs.js';
import { captureHandoff } from '../agents/handoff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let server; let base; let querySync;
// The stubbed session user; tests switch it to act as another member.
const me = { id: 1, email: 'one@a.test' };

beforeAll(async () => {
  const db = await import('../db.js');
  querySync = db.querySync;
  db.exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));
  const { default: chatsRouter } = await import('./chats.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...me }; next(); });
  app.use(chatsRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(() => new Promise((ok) => server.close(ok)));

beforeEach(() => {
  me.id = 1;
  checkOrgAccess.mockReset();
  checkOrgAccess.mockImplementation(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } }));
  captureHandoff.mockClear();
  querySync('DELETE FROM jobs');
  querySync('DELETE FROM chats');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (10, 'A', 'a')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'one@a.test'), (2, 'two@a.test')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (5, 10, 'Alpha', 'manuscript')");
});

const send = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
  body: body !== undefined ? JSON.stringify(body) : undefined,
});
const create = async (agent = 'pm') => (await (await send('PUT', `/api/projects/5/chats/${agent}`)).json()).chat;

describe('PUT /api/projects/:id/chats/:agent (issue #113)', () => {
  it('creates the caller\'s chat once and returns the same row after', async () => {
    const res = await send('PUT', '/api/projects/5/chats/pm');
    expect(res.status).toBe(200);
    const { chat } = await res.json();
    expect(chat).toMatchObject({ project_id: 5, agent_slug: 'pm', user_id: 1, status: 'idle', pinned_profile: null });
    expect((await create('pm')).id).toBe(chat.id);
    me.id = 2;
    expect((await create('pm')).id).not.toBe(chat.id);
  });

  it('rejects a malformed slug and guards on the project (editor)', async () => {
    expect((await send('PUT', '/api/projects/5/chats/not%20a%20slug')).status).toBe(400);
    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'role', role: 'viewer' });
    const denied = await send('PUT', '/api/projects/5/chats/pm');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'requires editor role' });
    expect(checkOrgAccess).toHaveBeenCalledWith(1, 10, 'editor');
    expect((await send('PUT', '/api/projects/999/chats/pm')).status).toBe(404);
  });
});

describe('GET /api/projects/:id/chats', () => {
  it('lists only the caller\'s chats with their projected status (viewer)', async () => {
    const pm = await create('pm');
    const writer = await create('writer');
    me.id = 2;
    await create('pm');
    me.id = 1;
    querySync("INSERT INTO jobs (id, project_id, user_id, role, status, input, chat_id) VALUES (7, 5, 1, 'writer', 'running', 'go', $1)", [writer.id]);
    querySync('UPDATE chats SET current_job_id = 7, last_message_at = $2 WHERE id = $1', [writer.id, '2026-09-13T00:00:00.000Z']);

    checkOrgAccess.mockResolvedValueOnce({ ok: true, role: 'viewer', org: { id: 10 } });
    const res = await send('GET', '/api/projects/5/chats');
    expect(res.status).toBe(200);
    expect(checkOrgAccess).toHaveBeenCalledWith(1, 10, 'viewer');
    const { chats } = await res.json();
    expect(chats.map((c) => [c.id, c.agent_slug, c.status])).toEqual([
      [writer.id, 'writer', 'running'],
      [pm.id, 'pm', 'idle'],
    ]);
  });
});

describe('PATCH /api/chats/:id', () => {
  it('pins and unpins the model, and clears a parked hand-off note', async () => {
    const chat = await create();
    let res = await send('PATCH', `/api/chats/${chat.id}`, { pinned_profile: 'strong' });
    expect(res.status).toBe(200);
    expect((await res.json()).chat.pinned_profile).toBe('strong');
    res = await send('PATCH', `/api/chats/${chat.id}`, { pinned_profile: null });
    expect((await res.json()).chat.pinned_profile).toBeNull();

    querySync("UPDATE chats SET pending_handoff = 'note' WHERE id = $1", [chat.id]);
    res = await send('PATCH', `/api/chats/${chat.id}`, { pending_handoff: null });
    expect((await res.json()).chat.pending_handoff).toBeNull();
  });

  it('validates the body: something to update, slug-or-null pin, note only clearable', async () => {
    const chat = await create();
    expect((await send('PATCH', `/api/chats/${chat.id}`, {})).status).toBe(400);
    expect((await send('PATCH', `/api/chats/${chat.id}`, { pinned_profile: 7 })).status).toBe(400);
    expect((await send('PATCH', `/api/chats/${chat.id}`, { pinned_profile: '' })).status).toBe(400);
    expect((await send('PATCH', `/api/chats/${chat.id}`, { pending_handoff: 'write me' })).status).toBe(400);
  });

  it('404s an unknown chat, guards on the chat\'s project, and refuses another user\'s chat', async () => {
    expect((await send('PATCH', '/api/chats/999', { pinned_profile: null })).status).toBe(404);
    const chat = await create();
    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'not-member' });
    const hidden = await send('PATCH', `/api/chats/${chat.id}`, { pinned_profile: null });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: 'project not found' });
    me.id = 2;
    const theirs = await send('PATCH', `/api/chats/${chat.id}`, { pinned_profile: 'strong' });
    expect(theirs.status).toBe(403);
    expect(await theirs.json()).toEqual({ error: 'not your chat' });
    expect(querySync('SELECT pinned_profile FROM chats WHERE id = $1', [chat.id]).rows[0].pinned_profile).toBeNull();
  });
});

describe('POST /api/chats/:id/reset (fresh start, STH-55 server-side)', () => {
  it('captures the hand-off, forgets the session/continuation/current job, and parks the note', async () => {
    const chat = await create();
    querySync("INSERT INTO jobs (id, project_id, user_id, role, status, input, chat_id) VALUES (8, 5, 1, 'pm', 'done', 'go', $1)", [chat.id]);
    querySync("UPDATE chats SET session_id = 'sess-8', continuation = '{\"version\":1}', current_job_id = 8, pinned_profile = 'cheap' WHERE id = $1", [chat.id]);

    const res = await send('POST', `/api/chats/${chat.id}/reset`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(captureHandoff).toHaveBeenCalledWith(5, 'pm');
    expect(body.handoff).toBe('Open: pick a journal.');
    expect(body.chat).toMatchObject({
      session_id: null, continuation: null, current_job_id: null,
      pending_handoff: 'Open: pick a journal.', pinned_profile: 'cheap', status: 'idle',
    });
  });

  it('skips the scan on { handoff: false }, and still resets when the scan fails', async () => {
    const chat = await create();
    let res = await send('POST', `/api/chats/${chat.id}/reset`, { handoff: false });
    expect(res.status).toBe(200);
    expect(captureHandoff).not.toHaveBeenCalled();
    expect((await res.json()).handoff).toBeNull();

    captureHandoff.mockRejectedValueOnce(new Error('model down'));
    querySync("UPDATE chats SET session_id = 'sess-x' WHERE id = $1", [chat.id]);
    res = await send('POST', `/api/chats/${chat.id}/reset`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handoff).toBeNull();
    expect(body.handoff_error).toBe('model down');
    expect(body.chat.session_id).toBeNull();
  });

  it('409s while the chat\'s run is in progress, and refuses another user\'s chat', async () => {
    const chat = await create();
    querySync("INSERT INTO jobs (id, project_id, user_id, role, status, input, chat_id) VALUES (9, 5, 1, 'pm', 'running', 'go', $1)", [chat.id]);
    querySync("UPDATE chats SET current_job_id = 9, session_id = 'live' WHERE id = $1", [chat.id]);
    const busy = await send('POST', `/api/chats/${chat.id}/reset`);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'chat has a run in progress' });
    expect(querySync('SELECT session_id FROM chats WHERE id = $1', [chat.id]).rows[0].session_id).toBe('live');

    querySync("UPDATE jobs SET status = 'done' WHERE id = 9");
    me.id = 2;
    expect((await send('POST', `/api/chats/${chat.id}/reset`)).status).toBe(403);
    expect(captureHandoff).not.toHaveBeenCalled();
  });
});
