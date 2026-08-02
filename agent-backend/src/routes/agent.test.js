import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';

vi.mock('../db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));

import { query } from '../db.js';
import { waitForReply, deliverReply } from '../agents/questions.js';
import { EventChannel } from '../agents/events.js';
import { registerRun, unregisterRun } from '../agents/runs.js';
import agentRouter from './agent.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(agentRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(() => new Promise((ok) => server.close(ok)));

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

  it('responds 409 when the job has no pending question', async () => {
    const res = await reply(7, { reply: 'hi' });
    expect(res.status).toBe(409);
  });

  it('delivers the reply to a job waiting on ask_user', async () => {
    const wait = waitForReply(7, 1000);
    const res = await reply(7, { reply: 'a manuscript' });
    expect(res.status).toBe(200);
    await expect(wait).resolves.toBe('a manuscript');
  });
});

describe('GET /api/agent/jobs/:id/trace (issue #42)', () => {
  it('404s for an unknown job', async () => {
    const res = await fetch(`${base}/api/agent/jobs/123/trace`);
    expect(res.status).toBe(404);
  });

  it('returns the job with its messages and children', async () => {
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM jobs WHERE id')) return { rows: [{ id: 123, conversation_id: 9, context: null }] };
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
    const run = { jobId: 70, projectId: 1, role: 'pm', channel: new EventChannel(), state: {}, consumerAttached: true };
    registerRun(run);
    try {
      const res = await fetch(`${base}/api/agent/jobs/70/reconnect`, { method: 'POST' });
      expect(res.status).toBe(409);
    } finally {
      unregisterRun(70);
    }
  });

  it('re-emits the pending question, then streams live events to completion', async () => {
    const channel = new EventChannel();
    const state = { finished: false, pump: Promise.resolve(), detachable: true, job: { id: 50 } };
    const run = { jobId: 50, projectId: 99, role: 'pm', channel, state, consumerAttached: false };
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
