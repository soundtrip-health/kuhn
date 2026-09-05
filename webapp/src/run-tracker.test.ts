// Run tracker (issues #136, #137): which job the status bar should follow.
import { describe, expect, it } from 'vitest';
import { RunTracker } from './run-tracker';

const chip = (agent: string) => ({ agent, label: agent, model: `${agent}-model`, profile: null });
const job = (jobId: number | null, agent: string, depth: number) => ({ jobId, agent, depth, chip: chip(agent) });

describe('RunTracker', () => {
  it('follows the innermost running job and returns to the dispatcher when it ends', () => {
    const t = new RunTracker();
    t.start(job(1, 'pm', 0));
    expect(t.rootJobId).toBe(1);
    expect(t.current?.agent).toBe('pm');
    t.start(job(2, 'ra', 1));
    expect(t.current?.agent).toBe('ra');
    expect(t.end(2)).toBe(true);
    expect(t.current?.agent).toBe('pm');
    t.start(job(3, 'writer', 1));
    expect(t.current?.agent).toBe('writer');
    expect(t.end(1)).toBe(true); // the root ended: everything under it goes too
    expect(t.current).toBeNull();
    expect(t.rootJobId).toBe(1); // still addressable until the next reset
  });

  it('closes a job\'s descendants but keeps parallel siblings', () => {
    const t = new RunTracker();
    t.start(job(10, 'ra', 0));
    t.start(job(11, 'advisor', 0)); // seeding runs research stages in parallel
    t.start(job(12, 'ra', 1)); // dispatched by the advisor
    expect(t.end(11)).toBe(true);
    expect(t.size).toBe(1);
    expect(t.current?.jobId).toBe(10);
  });

  it('falls back to agent + depth when the marker has no job id, and reports misses', () => {
    const t = new RunTracker();
    t.start(job(1, 'pm', 0));
    t.start(job(null, 'ra', 1)); // refused before a job existed
    expect(t.end(null, { agent: 'ra', depth: 1 })).toBe(true);
    expect(t.current?.agent).toBe('pm');
    expect(t.end(99)).toBe(false);
    expect(t.end(null)).toBe(false);
  });

  it('reset clears the stack and can seed the root for a reconnected run', () => {
    const t = new RunTracker();
    t.start(job(1, 'pm', 0));
    t.reset(7);
    expect(t.current).toBeNull();
    expect(t.rootJobId).toBe(7);
    t.start(job(8, 'pm', 0)); // a later depth-0 job does not displace the seeded root
    expect(t.rootJobId).toBe(7);
    t.reset();
    expect(t.rootJobId).toBeNull();
  });
});
