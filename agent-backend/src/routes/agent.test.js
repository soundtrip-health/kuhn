import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';

vi.mock('../db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));

import { waitForReply } from '../agents/questions.js';
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
