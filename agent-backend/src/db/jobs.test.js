import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import { createJob, updateJob, listJobs, getJobTrace, markOrphanedJobsInterrupted } from './jobs.js';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
});

describe('createJob', () => {
  it('inserts role, project, input, context, parent, and user attribution', async () => {
    await createJob({ role: 'ra', projectId: 3, input: 'find papers', context: { files: ['a.md'] }, parentJobId: 9, userId: 4 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO jobs');
    expect(params).toEqual(['ra', 3, 'find papers', JSON.stringify({ files: ['a.md'] }), 9, 4]);
  });

  it('defaults user_id to NULL when no user is supplied (story 007-001)', async () => {
    await createJob({ role: 'ra', projectId: 3, input: 'find papers' });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(['ra', 3, 'find papers', null, null, null]);
  });
});

describe('updateJob', () => {
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
  it('marks pending and running jobs and returns the count', async () => {
    query.mockResolvedValue({ rowCount: 3 });
    const count = await markOrphanedJobsInterrupted();
    expect(count).toBe(3);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("status IN ('pending', 'running')");
    expect(sql).toContain("status = 'interrupted'");
  });
});
