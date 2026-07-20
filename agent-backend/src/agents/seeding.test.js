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
  it('runs research → skeleton and writes pm/status.md', async () => {
    const runTask = makeRunTask();
    const events = await collect(runSeedPipeline(1, { runTask }));

    expect(stages(events)).toEqual([
      'research:start', 'research:done',
      'skeleton:start', 'skeleton:done',
      'seeding:done',
    ]);

    const calls = runTask.mock.calls.map(([task]) => task);
    expect(calls.map((t) => t.role)).toEqual(['ra', 'advisor', 'writer']);
    for (const task of calls) {
      expect(task.input).toContain(CONFIG.research_question);
      expect(task.projectId).toBe(1);
      // Every stage bypasses suggestion mode (story 008-001): the pipeline
      // writes the first draft directly — there is nothing to protect yet.
      expect(task.seeding).toBe(true);
    }
    expect(calls.map((t) => t.context?.seedStage)).toEqual(['research', 'research', 'skeleton']);

    expect(writeProjectFile).toHaveBeenCalledWith(1, 'pm/status.md', expect.stringContaining('skeleton: ok'));
    expect(events.find((e) => e.type === 'file_change')).toMatchObject({ path: 'pm/status.md' });
  });

  it('aborts with a clear error when the project is not configured', async () => {
    getProject.mockResolvedValue({ id: 1, config: {} });
    const runTask = makeRunTask();
    const events = await collect(runSeedPipeline(1, { runTask }));
    expect(stages(events)).toEqual(['seeding:error']);
    expect(runTask).not.toHaveBeenCalled();
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
    let writerCleaned = false;
    const runTask = vi.fn(({ role }) => {
      if (role !== 'writer') return (async function* () { yield doneEvent(role); })();
      return (async function* () {
        try {
          yield { type: 'text', agent: 'writer', content: 'one' };
          yield { type: 'text', agent: 'writer', content: 'two' };
          yield doneEvent('writer');
        } finally {
          writerCleaned = true;
        }
      })();
    });

    for await (const event of runSeedPipeline(1, { runTask })) {
      if (event.type === 'text') break; // browser disconnected
    }
    expect(writerCleaned).toBe(true);
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
    const runTask = vi.fn(({ role }) => research(role));

    for await (const event of runSeedPipeline(1, { runTask })) {
      if (event.type === 'text') break; // first research event, then disconnect
    }
    expect(cleaned.ra).toBe(true);
    expect(cleaned.advisor).toBe(true);
  });
});
