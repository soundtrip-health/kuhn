import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import {
  createJob, updateJob, listJobs, getJobTrace, markOrphanedJobsInterrupted,
  requestJobCancel, cancelJobsWhere, getCancelRequest, OPEN_JOB_STATUSES,
} from './jobs.js';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
});

describe('createJob', () => {
  it('inserts role, project, input, context, parent, and user attribution', async () => {
    await createJob({ role: 'ra', projectId: 3, input: 'find papers', context: { files: ['a.md'] }, parentJobId: 9, userId: 4 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO jobs');
    expect(params).toEqual(['ra', 3, 'find papers', JSON.stringify({ files: ['a.md'] }), 9, 4, null, null, null, null, null, null]);
  });

  it('stamps the chat a top-level run belongs to (issue #113)', async () => {
    await createJob({ role: 'pm', projectId: 3, input: 'hi', userId: 4, chatId: 12 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('chat_id');
    expect(params[9]).toBe(12);
  });

  it('defaults user_id to NULL when no user is supplied (story 007-001)', async () => {
    await createJob({ role: 'ra', projectId: 3, input: 'find papers' });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(['ra', 3, 'find papers', null, null, null, null, null, null, null, null, null]);
  });
});

describe('updateJob', () => {
  it('stamps the routing decision: difficulty and route source (issue #107)', async () => {
    await updateJob(5, { difficulty: 0.3, routeSource: 'org' });
    const [sql, params] = query.mock.calls.at(-1);
    expect(sql).toMatch(/difficulty = \$1, route_source = \$2/);
    expect(params).toEqual([0.3, 'org', 5]);
  });

  it('updates only the provided fields', async () => {
    await updateJob(5, { status: 'done', outputTokens: 123 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('status = $1');
    expect(sql).toContain('output_tokens = $2');
    expect(sql).not.toContain('session_id');
    expect(params).toEqual(['done', 123, 5]);
  });

  it('falls back to a select when no fields are provided', async () => {
    await updateJob(5, {});
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('SELECT * FROM jobs');
    expect(params).toEqual([5]);
  });
});

describe('listJobs', () => {
  it('passes nullable filters through', async () => {
    await listJobs({ projectId: 2, status: 'interrupted', limit: 10 });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([2, 'interrupted', 10]);
  });

  it('defaults to no filters and limit 50', async () => {
    await listJobs();
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([null, null, 50]);
  });
});

describe('getJobTrace (issue #42)', () => {
  it('assembles the job, its messages, and sub-job traces recursively', async () => {
    const jobs = {
      1: { id: 1, conversation_id: 10, parent_job_id: null, context: null },
      2: { id: 2, conversation_id: 11, parent_job_id: 1, context: null },
    };
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM jobs WHERE id')) return { rows: [jobs[params[0]]] };
      if (sql.includes('parent_job_id = $1')) return { rows: params[0] === 1 ? [jobs[2]] : [] };
      if (sql.includes('FROM messages')) {
        return { rows: [{ conversation_id: params[0], role: 'tool', content: 'ok', is_error: 0 }] };
      }
      return { rows: [] };
    });
    const trace = await getJobTrace(1);
    expect(trace.id).toBe(1);
    expect(trace.messages).toHaveLength(1);
    expect(trace.children).toHaveLength(1);
    expect(trace.children[0].id).toBe(2);
    expect(trace.children[0].messages).toHaveLength(1);
    expect(trace.children[0].children).toEqual([]);
  });

  it('returns undefined for an unknown job', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getJobTrace(99)).toBeUndefined();
  });
});

describe('markOrphanedJobsInterrupted', () => {
  it('marks every open job (queued, running, waiting, retry wait) and returns the count', async () => {
    query.mockResolvedValue({ rowCount: 3 });
    const count = await markOrphanedJobsInterrupted();
    expect(count).toBe(3);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("status IN ('queued', 'running', 'waiting_for_user', 'retry_wait')");
    expect(sql).toContain("status = 'interrupted'");
  });
});

// --- Issue #118 stage 1: tree identity and persisted cancellation -----------

describe('createJob root identity (issue #118)', () => {
  it('a top-level job becomes its own root in a second statement', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7, root_job_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 7, root_job_id: 7 }] });
    const job = await createJob({ role: 'pm', projectId: 3, input: 'go', deadlineAt: '2026-09-14T05:00:00.000Z' });
    expect(job.root_job_id).toBe(7);
    const [insertSql, insertParams] = query.mock.calls[0];
    expect(insertSql).toContain('root_job_id, deadline_at');
    expect(insertParams.slice(-2)).toEqual([null, '2026-09-14T05:00:00.000Z']);
    expect(query.mock.calls[1][0]).toMatch(/UPDATE jobs SET root_job_id = id WHERE id = \$1/);
    expect(query.mock.calls[1][1]).toEqual([7]);
  });

  it('a sub-job carries the root it was given and needs no second statement', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 8, root_job_id: 7 }] });
    const job = await createJob({ role: 'ra', projectId: 3, input: 'find', parentJobId: 7, rootJobId: 7, deadlineAt: 'x' });
    expect(job.root_job_id).toBe(7);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1].slice(-2)).toEqual([7, 'x']);
  });
});

describe('updateJob lifecycle columns (issue #118)', () => {
  it('maps the stage-1 fields to their columns', async () => {
    await updateJob(7, { cancelReason: 'suspended', workerId: 'h:1:t', attempt: 1, budgetUsed: 120, deadlineAt: 'd' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/cancel_reason = \$1, worker_id = \$2, attempt = \$3, budget_used = \$4, deadline_at = \$5/);
    expect(params).toEqual(['suspended', 'h:1:t', 1, 120, 'd', 7]);
  });
});

describe('persisted cancellation (issue #118 §5)', () => {
  it('requestJobCancel flags every open row of the tree once, first reason wins', async () => {
    query.mockResolvedValue({ rowCount: 2 });
    expect(await requestJobCancel(7, 'user')).toBe(2);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SET cancel_requested_at = strftime/);
    expect(sql).toContain('cancel_reason = COALESCE(cancel_reason, $2)');
    expect(sql).toContain('(root_job_id = $1 OR id = $1)');
    expect(sql).toContain(`status IN (${OPEN_JOB_STATUSES.map((s) => `'${s}'`).join(', ')})`);
    expect(sql).toContain('cancel_requested_at IS NULL');
    expect(params).toEqual([7, 'user']);
  });

  it("cancelJobsWhere scopes to the org's projects and optionally one member, returning the rows", async () => {
    query.mockResolvedValue({ rows: [{ id: 9, root_job_id: 7, project_id: 3 }] });
    const rows = await cancelJobsWhere({ orgId: 1, userId: 4 }, 'removed');
    expect(rows).toEqual([{ id: 9, root_job_id: 7, project_id: 3 }]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('project_id IN (SELECT id FROM projects WHERE org_id = $2');
    expect(sql).toContain('($3 IS NULL OR user_id = $3)');
    expect(sql).toContain('RETURNING id, root_job_id, project_id');
    expect(params).toEqual(['removed', 1, 4, null]);
  });

  it('getCancelRequest reads the flag, null when not raised', async () => {
    query.mockResolvedValueOnce({ rows: [{ cancel_requested_at: null, cancel_reason: null }] });
    expect(await getCancelRequest(7)).toBeNull();
    query.mockResolvedValueOnce({ rows: [{ cancel_requested_at: 't', cancel_reason: 'deadline' }] });
    expect(await getCancelRequest(7)).toEqual({ requestedAt: 't', reason: 'deadline' });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getCancelRequest(99)).toBeNull();
  });
});
