import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/projects.js', () => ({ getProject: vi.fn() }));
vi.mock('../storage.js', () => ({ writeProjectFile: vi.fn(async () => ({ created: true })) }));

import { getProject } from '../db/projects.js';
import { writeProjectFile } from '../storage.js';
import { runSeedPipeline } from './seeding.js';

const CONFIG = {
  title: 'GLP-1 RWE Study',
  project_type: 'rwe-protocol',
  research_question: 'Does GLP-1 use reduce MACE in T2D?',
  deliverables: ['FDA RWE protocol'],
  timeline: 'Draft by 2026-08-01',
};

const doneEvent = (agent) => ({ type: 'done', agent, jobId: 1, sessionId: 's', usage: { inputTokens: 1, outputTokens: 1 } });

/** runTask stub: yields the canned events for the requested role. */
function makeRunTask(eventsByRole = {}) {
  return vi.fn(({ role }) => (async function* () {
    for (const event of eventsByRole[role] ?? [doneEvent(role)]) yield event;
  })());
}

async function collect(pipeline) {
  const events = [];
  for await (const ev of pipeline) events.push(ev);
  return events;
}

const stages = (events) => events.filter((e) => e.type === 'stage').map((e) => `${e.stage}:${e.status}`);

beforeEach(() => {
  vi.clearAllMocks();
  getProject.mockResolvedValue({ id: 1, config: CONFIG });
});

describe('runSeedPipeline', () => {
  it('runs interview → research → skeleton and writes pm/status.md', async () => {
    const runTask = makeRunTask({
      pm: [{ type: 'text', agent: 'pm', content: 'Configured.' }, doneEvent('pm')],
    });
    const events = await collect(runSeedPipeline(1, { runTask }));

    expect(stages(events)).toEqual([
      'interview:start', 'interview:done',
      'research:start', 'research:done',
      'skeleton:start', 'skeleton:done',
      'seeding:done',
    ]);

    // All four agents dispatched, with self-contained config-derived inputs
    const calls = runTask.mock.calls.map(([task]) => task);
    expect(calls.map((t) => t.role)).toEqual(['pm', 'ra', 'advisor', 'writer']);
    for (const task of calls.slice(1)) {
      expect(task.input).toContain(CONFIG.research_question);
      expect(task.projectId).toBe(1);
    }
    expect(calls[0].input).toMatch(/do not dispatch/i);
    // Stage jobs are tagged so transcript restore can exclude them (story 020)
    expect(calls.map((t) => t.context?.seedStage)).toEqual(['interview', 'research', 'research', 'skeleton']);

    // Agent events forwarded between the stage markers
    expect(events.find((e) => e.type === 'text')).toMatchObject({ agent: 'pm', content: 'Configured.' });

    // Deterministic status file with per-stage outcomes
    expect(writeProjectFile).toHaveBeenCalledWith(1, 'pm/status.md', expect.stringContaining('interview: ok'));
    expect(events.find((e) => e.type === 'file_change')).toMatchObject({ path: 'pm/status.md' });
  });

  it('aborts after the interview when no project configuration was saved', async () => {
    getProject.mockResolvedValue({ id: 1, config: {} });
    const runTask = makeRunTask();
    const events = await collect(runSeedPipeline(1, { runTask }));

    expect(stages(events)).toEqual(['interview:start', 'interview:error', 'seeding:error']);
    expect(runTask).toHaveBeenCalledTimes(1);
    // Status file still records the failure
    expect(writeProjectFile).toHaveBeenCalledWith(1, 'pm/status.md', expect.stringContaining('FAILED'));
  });

  it('treats a failed research branch as non-fatal and records it', async () => {
    const runTask = makeRunTask({
      ra: [{ type: 'error', agent: 'ra', jobId: 2, message: 'search exploded' }],
    });
    const events = await collect(runSeedPipeline(1, { runTask }));

    expect(stages(events)).toContain('research:done');
    expect(events.find((e) => e.stage === 'research' && e.status === 'done')?.detail).toMatch(/1 of 2/);
    expect(stages(events)).toContain('skeleton:done');
    const status = writeProjectFile.mock.calls.find(([, path]) => path === 'pm/status.md')[2];
    expect(status).toContain('ra: FAILED — search exploded');
    expect(status).toContain('advisor: ok');
  });

  it('forwards interleaved research events from both branches', async () => {
    const runTask = makeRunTask({
      ra: [{ type: 'text', agent: 'ra', content: 'found papers' }, doneEvent('ra')],
      advisor: [{ type: 'text', agent: 'advisor', content: 'guidance mapped' }, doneEvent('advisor')],
    });
    const events = await collect(runSeedPipeline(1, { runTask }));
    const texts = events.filter((e) => e.type === 'text').map((e) => e.agent);
    expect(texts).toContain('ra');
    expect(texts).toContain('advisor');
  });

  it('stops in-flight stage tasks when the consumer stops early', async () => {
    let pmCleaned = false;
    const runTask = vi.fn(() => (async function* () {
      try {
        yield { type: 'text', agent: 'pm', content: 'one' };
        yield { type: 'text', agent: 'pm', content: 'two' };
        yield doneEvent('pm');
      } finally {
        pmCleaned = true;
      }
    })());

    for await (const event of runSeedPipeline(1, { runTask })) {
      if (event.type === 'text') break; // browser disconnected
    }
    expect(pmCleaned).toBe(true);
  });

  it('stops parallel research tasks when the consumer stops early', async () => {
    const cleaned = { ra: false, advisor: false };
    const research = (role) => (async function* () {
      try {
        yield { type: 'text', agent: role, content: 'working' };
        yield { type: 'text', agent: role, content: 'still working' };
        yield doneEvent(role);
      } finally {
        cleaned[role] = true;
      }
    })();
    const runTask = vi.fn(({ role }) =>
      role === 'pm' ? (async function* () { yield doneEvent('pm'); })() : research(role));

    for await (const event of runSeedPipeline(1, { runTask })) {
      if (event.type === 'text') break; // first research event, then disconnect
    }
    expect(cleaned.ra).toBe(true);
    expect(cleaned.advisor).toBe(true);
  });
});
