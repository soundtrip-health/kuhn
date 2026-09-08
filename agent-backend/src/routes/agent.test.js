import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
// Tenancy guard dependencies (story 010-003): every project resolves; access
// defaults to full and tests override checkOrgAccess where roles matter.
vi.mock('../db/projects.js', () => ({
  getProject: vi.fn(async (id) => ({ id: Number(id), org_id: 10 })),
}));
vi.mock('../db/orgs.js', () => ({
  checkOrgAccess: vi.fn(),
}));
// STH-55: the scan's model call + tail query are covered in agents/handoff.test.js.
vi.mock('../agents/handoff.js', () => ({
  captureHandoff: vi.fn(async () => ({ handoff: 'note' })),
}));
// Issue #110: the resume route's dispatch is asserted by its arguments; the
// run itself is the runtime's business (agents/runtime.test.js).
vi.mock('../agents/runtime.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runAgentTask: vi.fn(async function* () {
      yield { type: 'done', agent: 'writer', jobId: 91, sessionId: 'fresh-session' };
    }),
  };
});

import { query } from '../db.js';
import { checkOrgAccess } from '../db/orgs.js';
import { captureHandoff } from '../agents/handoff.js';
import { runAgentTask } from '../agents/runtime.js';
import { waitForReply, deliverReply } from '../agents/questions.js';
import { EventChannel } from '../agents/events.js';
import { registerRun, unregisterRun } from '../agents/runs.js';
import agentRouter from './agent.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand in for the session middleware: every request has a current user.
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(agentRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(() => new Promise((ok) => server.close(ok)));

beforeEach(() => {
  checkOrgAccess.mockReset();
  checkOrgAccess.mockImplementation(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } }));
});

/** Make the mocked db serve a jobs row for `id` (getJob) for the duration of fn. */
async function withJob(id, fields, fn) {
  const prior = query.getMockImplementation();
  query.mockImplementation(async (sql, params) => (
    /FROM jobs WHERE id/.test(sql) && Number(params?.[0]) === id
      ? { rows: [{ id, project_id: 5, ...fields }] }
      : { rows: [] }
  ));
  try {
    await fn();
  } finally {
    query.mockImplementation(prior ?? (async () => ({ rows: [] })));
  }
}

const reply = (jobId, body) =>
  fetch(`${base}/api/agent/jobs/${jobId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/agent/jobs/:id/reply', () => {
  it('rejects a missing reply', async () => {
    const res = await reply(7, {});
    expect(res.status).toBe(400);
  });

  it('404s an unknown job', async () => {
    const res = await reply(7777, { reply: 'hi' });
    expect(res.status).toBe(404);
  });

  it('responds 409 when the job has no pending question', async () => {
    await withJob(7, {}, async () => {
      const res = await reply(7, { reply: 'hi' });
      expect(res.status).toBe(409);
    });
  });

  it('delivers the reply to a job waiting on ask_user', async () => {
    await withJob(7, {}, async () => {
      const wait = waitForReply(7, 1000);
      const res = await reply(7, { reply: 'a manuscript' });
      expect(res.status).toBe(200);
      await expect(wait).resolves.toBe('a manuscript');
    });
  });

  it('needs editor in the job\'s project org (010-003)', async () => {
    await withJob(7, {}, async () => {
      checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'role', role: 'viewer' });
      const res = await reply(7, { reply: 'hi' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'requires editor role' });
      expect(checkOrgAccess).toHaveBeenCalledWith(1, 10, 'editor');
    });
  });
});

describe('GET /api/agent/jobs/:id/trace (issue #42)', () => {
  it('404s for an unknown job', async () => {
    const res = await fetch(`${base}/api/agent/jobs/123/trace`);
    expect(res.status).toBe(404);
  });

  it('returns the job with its messages and children', async () => {
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM jobs WHERE id')) return { rows: [{ id: 123, project_id: 5, conversation_id: 9, context: null }] };
      if (sql.includes('parent_job_id')) return { rows: [] };
      if (sql.includes('FROM messages')) return { rows: [{ role: 'tool', content: 'ok', is_error: 0 }] };
      return { rows: [] };
    });
    try {
      const res = await fetch(`${base}/api/agent/jobs/123/trace`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(123);
      expect(body.messages).toEqual([{ role: 'tool', content: 'ok', is_error: 0 }]);
      expect(body.children).toEqual([]);
    } finally {
      query.mockImplementation(async () => ({ rows: [] }));
    }
  });

  it('viewer suffices for the trace; non-members get a non-leaking 404 (010-003)', async () => {
    await withJob(123, { conversation_id: null }, async () => {
      checkOrgAccess.mockResolvedValueOnce({ ok: true, role: 'viewer', org: { id: 10 } });
      expect((await fetch(`${base}/api/agent/jobs/123/trace`)).status).toBe(200);
      expect(checkOrgAccess).toHaveBeenCalledWith(1, 10, 'viewer');

      checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'not-member' });
      const denied = await fetch(`${base}/api/agent/jobs/123/trace`);
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ error: 'project not found' });
    });
  });
});

describe('GET /api/agent/jobs (010-003 scoping)', () => {
  it('requires a projectId — an unscoped listing would cross tenant lines', async () => {
    const res = await fetch(`${base}/api/agent/jobs`);
    expect(res.status).toBe(400);
  });

  it('lists for viewers; 403s a suspended org', async () => {
    checkOrgAccess.mockResolvedValueOnce({ ok: true, role: 'viewer', org: { id: 10 } });
    const res = await fetch(`${base}/api/agent/jobs?projectId=5`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [] });

    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'suspended', role: 'viewer' });
    const suspended = await fetch(`${base}/api/agent/jobs?projectId=5`);
    expect(suspended.status).toBe(403);
    expect(await suspended.json()).toEqual({ error: 'organization suspended' });
  });
});

describe('POST /api/agent/task (010-003 scoping)', () => {
  const task = (body) => fetch(`${base}/api/agent/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('guards before dispatching: viewer 403, non-member 404', async () => {
    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'role', role: 'viewer' });
    const denied = await task({ role: 'pm', projectId: 5, input: 'go' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'requires editor role' });
    expect(checkOrgAccess).toHaveBeenCalledWith(1, 10, 'editor');

    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'not-member' });
    expect((await task({ role: 'pm', projectId: 5, input: 'go' })).status).toBe(404);
  });
});

describe('GET /api/agent/pending (story 027)', () => {
  it('lists parked, unattached runs with their question text, scoped by project', async () => {
    const parked = { jobId: 60, projectId: 77, role: 'pm', channel: new EventChannel(), state: {}, consumerAttached: false };
    const attached = { jobId: 61, projectId: 77, role: 'pm', channel: new EventChannel(), state: {}, consumerAttached: true };
    const otherProject = { jobId: 62, projectId: 88, role: 'pm', channel: new EventChannel(), state: {}, consumerAttached: false };
    registerRun(parked);
    registerRun(attached);
    registerRun(otherProject);
    waitForReply(60, 10000, { question: 'Which journal?', agent: 'pm' });
    waitForReply(61, 10000, { question: 'attached', agent: 'pm' });
    waitForReply(62, 10000, { question: 'other', agent: 'pm' });
    try {
      const res = await fetch(`${base}/api/agent/pending?projectId=77`);
      const { pending } = await res.json();
      // Only the parked, unattached run in project 77 — not the attached one, not project 88
      expect(pending).toEqual([{ jobId: 60, role: 'pm', agent: 'pm', question: 'Which journal?' }]);
    } finally {
      deliverReply(60, 'x'); deliverReply(61, 'x'); deliverReply(62, 'x');
      unregisterRun(60); unregisterRun(61); unregisterRun(62);
    }
  });
});

describe('POST /api/agent/jobs/:id/reconnect (story 027)', () => {
  it('404s when no live run exists for the job', async () => {
    const res = await fetch(`${base}/api/agent/jobs/999/reconnect`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('409s when the run already has a consumer', async () => {
    await withJob(70, {}, async () => {
      const run = { jobId: 70, projectId: 5, role: 'pm', channel: new EventChannel(), state: {}, consumerAttached: true };
      registerRun(run);
      try {
        const res = await fetch(`${base}/api/agent/jobs/70/reconnect`, { method: 'POST' });
        expect(res.status).toBe(409);
      } finally {
        unregisterRun(70);
      }
    });
  });

  it('guards reconnection on the job\'s project (010-003)', async () => {
    await withJob(70, {}, async () => {
      checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'role', role: 'viewer' });
      const res = await fetch(`${base}/api/agent/jobs/70/reconnect`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'requires editor role' });
    });
  });

  it('re-emits the pending question, then streams live events to completion', async () => {
    await withJob(50, {}, async () => {
      const channel = new EventChannel();
      const state = { finished: false, pump: Promise.resolve(), detachable: true, job: { id: 50 } };
      const run = { jobId: 50, projectId: 5, role: 'pm', channel, state, consumerAttached: false };
      state.runHandle = run;
      registerRun(run);
      waitForReply(50, 10000, { question: 'Pick one?', agent: 'pm' });

      const resP = fetch(`${base}/api/agent/jobs/50/reconnect`, { method: 'POST' });
      // Simulate the user answering and the agent finishing on the reattached run
      setTimeout(() => {
        deliverReply(50, 'a');
        channel.push({ type: 'text', agent: 'pm', content: 'ok' });
        state.finished = true;
        channel.push({ type: 'done', agent: 'pm', jobId: 50 });
        channel.end();
      }, 30);

      const res = await resP;
      expect(res.status).toBe(200);
      const frames = (await res.text())
        .split('\n\n').filter(Boolean)
        .map((f) => JSON.parse(f.replace(/^data: /, '')));
      expect(frames[0]).toEqual({ type: 'question', agent: 'pm', jobId: 50, content: 'Pick one?' });
      expect(frames.some((f) => f.type === 'done')).toBe(true);
      unregisterRun(50);
    });
  });
});

describe('POST /api/agent/handoff (STH-55)', () => {
  const post = (body) => fetch(`${base}/api/agent/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('rejects a missing role/projectId', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ role: 'pm' })).status).toBe(400);
  });

  it('returns the captured note', async () => {
    const res = await post({ projectId: 5, role: 'pm' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handoff: 'note' });
    expect(captureHandoff).toHaveBeenCalledWith(5, 'pm');
  });

  it('maps a failed scan to a readable 502', async () => {
    captureHandoff.mockRejectedValueOnce(new Error('model down'));
    const res = await post({ projectId: 5, role: 'pm' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/model down/);
  });
});

describe('POST /api/agent/jobs/:id/resume (issue #110)', () => {
  const resume = (id, body = {}) => fetch(`${base}/api/agent/jobs/${id}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const paused = {
    role: 'writer', status: 'error', error: 'token budget exceeded', parent_job_id: null,
    session_id: 'sess-1', continuation: null, handoff: 'In progress: §2. Next: §3.',
    context: JSON.stringify({ activeDocument: 'draft/old.md' }),
  };

  beforeEach(() => runAgentTask.mockClear());

  it('404s an unknown job', async () => {
    expect((await resume(999)).status).toBe(404);
  });

  it('409s a job that is not a paused top-level run', async () => {
    await withJob(80, { ...paused, status: 'done', error: null }, async () => {
      const res = await resume(80);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'job is not paused on a token budget' });
    });
    await withJob(81, { ...paused, error: 'during execution' }, async () => {
      expect((await resume(81)).status).toBe(409);
    });
    await withJob(82, { ...paused, parent_job_id: 3 }, async () => {
      expect((await resume(82)).status).toBe(409);
    });
    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it('guards on the job\'s project (editor): viewer 403, non-member 404', async () => {
    await withJob(83, paused, async () => {
      checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'role', role: 'viewer' });
      expect((await resume(83)).status).toBe(403);
      checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'not-member' });
      expect((await resume(83)).status).toBe(404);
    });
    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it('dispatches a fresh task that resumes the paused session with the hand-off note', async () => {
    await withJob(84, paused, async () => {
      const res = await resume(84, { context: { activeDocument: 'draft/new.md' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const body = await res.text();
      expect(body).toContain('"type":"done"');
      expect(body).toContain('"sessionId":"fresh-session"');
    });
    expect(runAgentTask).toHaveBeenCalledTimes(1);
    const task = runAgentTask.mock.calls[0][0];
    expect(task).toMatchObject({
      role: 'writer', projectId: 5, sessionId: 'sess-1', continuation: null,
      userId: 1, detachable: true,
      // The resume-time editor context, not the paused job's stale one.
      context: { activeDocument: 'draft/new.md' },
    });
    expect(task.input).toMatch(/^\[Resuming after a token-budget pause\]/);
    expect(task.input).toContain('In progress: §2. Next: §3.');
    expect(task.signal).toBeInstanceOf(AbortSignal);
  });
});


describe('POST /api/agent/jobs/:id/cancel (issue #136)', () => {
  it('404s for an unknown job', async () => {
    const res = await fetch(`${base}/api/agent/jobs/999/cancel`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('409s when the job has no live run here (finished, or from before a restart)', async () => {
    await withJob(80, { status: 'interrupted' }, async () => {
      const res = await fetch(`${base}/api/agent/jobs/80/cancel`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'job is not running', status: 'interrupted' });
    });
  });

  it('guards the stop on the job\'s project (editor role)', async () => {
    await withJob(81, { status: 'running' }, async () => {
      checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'role', role: 'viewer' });
      const res = await fetch(`${base}/api/agent/jobs/81/cancel`, { method: 'POST' });
      expect(res.status).toBe(403);
    });
  });

  it('aborts the live run, releases a parked question, and marks the job cancelled', async () => {
    await withJob(82, { status: 'running' }, async () => {
      const controller = new AbortController();
      const state = { controller, job: { id: 82, role: 'pm' }, finished: false, cancelReason: null };
      const run = { jobId: 82, projectId: 5, role: 'pm', channel: new EventChannel(), state, consumerAttached: true };
      registerRun(run);
      const parked = waitForReply(82, 60_000, { question: 'q', agent: 'pm' });
      try {
        const res = await fetch(`${base}/api/agent/jobs/82/cancel`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, jobId: 82, status: 'cancelled' });
        expect(controller.signal.aborted).toBe(true);
        expect(state.cancelReason).toBe('user');
        expect(await parked).toBeNull(); // the ask_user wait was released without an answer
        const marked = query.mock.calls.find(([sql, params]) => /UPDATE jobs SET status/.test(sql) && params?.[0] === 'cancelled');
        expect(marked).toBeDefined();
      } finally {
        unregisterRun(82);
      }
    });
  });
});
