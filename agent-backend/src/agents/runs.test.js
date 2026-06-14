import { describe, it, expect, beforeEach } from 'vitest';
import { registerRun, getRun, unregisterRun, listLiveRuns } from './runs.js';

const handle = (jobId, projectId) => ({
  jobId,
  projectId,
  role: 'pm',
  channel: {},
  state: {},
  consumerAttached: true,
});

describe('run registry (story 027)', () => {
  beforeEach(() => {
    // Clear any handles a prior test left behind
    for (const r of listLiveRuns(null)) unregisterRun(r.jobId);
  });

  it('registers, looks up, and unregisters by jobId', () => {
    registerRun(handle(1, 10));
    expect(getRun(1)?.jobId).toBe(1);
    unregisterRun(1);
    expect(getRun(1)).toBeUndefined();
  });

  it('unregisterRun(null) is a no-op', () => {
    registerRun(handle(2, 10));
    unregisterRun(null);
    expect(getRun(2)?.jobId).toBe(2);
  });

  it('lists live runs filtered by project (string/number agnostic)', () => {
    registerRun(handle(3, 10));
    registerRun(handle(4, 10));
    registerRun(handle(5, 20));
    expect(listLiveRuns(10).map((r) => r.jobId).sort()).toEqual([3, 4]);
    expect(listLiveRuns('10').map((r) => r.jobId).sort()).toEqual([3, 4]);
    expect(listLiveRuns(null).map((r) => r.jobId).sort()).toEqual([3, 4, 5]);
  });
});
