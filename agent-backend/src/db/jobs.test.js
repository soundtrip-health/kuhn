import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import { createJob, updateJob, listJobs, markOrphanedJobsInterrupted } from './jobs.js';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
});

describe('createJob', () => {
  it('inserts role, project, input, context, and parent', async () => {
    await createJob({ role: 'ra', projectId: 3, input: 'find papers', context: { files: ['a.md'] }, parentJobId: 9 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO jobs');
    expect(params).toEqual(['ra', 3, 'find papers', JSON.stringify({ files: ['a.md'] }), 9]);
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
