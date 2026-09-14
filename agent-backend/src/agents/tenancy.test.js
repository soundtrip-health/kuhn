import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/jobs.js', () => ({ cancelJobsWhere: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { cancelJobsWhere } from '../db/jobs.js';
import { registerRun, unregisterRun } from './runs.js';
import { cancelTenantJobs } from './tenancy.js';

beforeEach(() => vi.clearAllMocks());

describe('cancelTenantJobs (issue #118 stage 1, T-28)', () => {
  it('flags the rows, then aborts each live root run once', async () => {
    cancelJobsWhere.mockResolvedValue([
      { id: 31, root_job_id: 31, project_id: 10 },
      { id: 32, root_job_id: 31, project_id: 10 },
      { id: 40, root_job_id: 40, project_id: 11 },
    ]);
    const cancel = vi.fn(async () => true);
    registerRun({ jobId: 31, projectId: 10, role: 'pm', channel: null, state: {}, consumerAttached: true, cancel });
    try {
      expect(await cancelTenantJobs({ orgId: 1 }, 'suspended')).toEqual({ flagged: 3, aborted: 1 });
    } finally {
      unregisterRun(31);
    }
    expect(cancelJobsWhere).toHaveBeenCalledWith({ orgId: 1 }, 'suspended');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('suspended');
  });

  it('is quiet when nothing is open', async () => {
    cancelJobsWhere.mockResolvedValue([]);
    expect(await cancelTenantJobs({ orgId: 1, userId: 4 }, 'removed')).toEqual({ flagged: 0, aborted: 0 });
  });
});
