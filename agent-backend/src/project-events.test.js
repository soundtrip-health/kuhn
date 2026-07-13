import { describe, it, expect, vi, afterEach } from 'vitest';

// Keep this a pure hub test: persistence (005-002) is covered against real
// SQLite in db/file-activity.test.js.
vi.mock('./db/file-activity.js', () => ({ recordFileEvent: vi.fn() }));

import { config } from './config.js';
import {
  subscribeProjectEvents,
  publishProjectEvent,
  teeProjectEvents,
  projectSubscriberCount,
} from './project-events.js';
import { EventChannel } from './agents/events.js';

const unsubs = [];
const sub = (projectId, fn) => {
  const u = subscribeProjectEvents(projectId, fn);
  if (u) unsubs.push(u);
  return u;
};

afterEach(() => {
  for (const u of unsubs.splice(0)) u();
});

describe('project event hub (story 005-001)', () => {
  it('fans an event out to every subscriber with a ts/jobId envelope', () => {
    const a = vi.fn();
    const b = vi.fn();
    sub(1, a);
    sub(1, b);
    publishProjectEvent(1, { type: 'file_change', path: 'x.md', kind: 'create' }, { jobId: 42 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toMatchObject({ type: 'file_change', path: 'x.md', jobId: 42 });
    expect(typeof a.mock.calls[0][0].ts).toBe('string');
  });

  it('does not overwrite an event\'s own jobId and scopes by project', () => {
    const a = vi.fn();
    const other = vi.fn();
    sub(1, a);
    sub(2, other);
    publishProjectEvent(1, { type: 'done', jobId: 7 }, { jobId: 99 });
    expect(a.mock.calls[0][0].jobId).toBe(7);
    expect(other).not.toHaveBeenCalled();
  });

  it('publishes each event object at most once (forwarding paths overlap)', () => {
    const a = vi.fn();
    sub(1, a);
    const event = { type: 'file_change', path: 'y.md', kind: 'update' };
    publishProjectEvent(1, event);
    publishProjectEvent(1, event); // e.g. dispatch_agent forwarded it again
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not break delivery to the others', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    sub(1, bad);
    sub(1, good);
    publishProjectEvent(1, { type: 'notice' });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('enforces the per-project subscriber cap and cleans up on unsubscribe', () => {
    const saved = config.projectEvents.maxSubscribers;
    config.projectEvents.maxSubscribers = 2;
    try {
      const u1 = sub(5, vi.fn());
      sub(5, vi.fn());
      expect(subscribeProjectEvents(5, vi.fn())).toBeNull();
      expect(projectSubscriberCount(5)).toBe(2);
      u1();
      expect(projectSubscriberCount(5)).toBe(1);
      expect(sub(5, vi.fn())).not.toBeNull();
    } finally {
      config.projectEvents.maxSubscribers = saved;
    }
  });

  it('teeProjectEvents passes events through and publishes the un-published ones', async () => {
    const a = vi.fn();
    sub(1, a);
    const alreadyPublished = { type: 'text', content: 'hi' };
    publishProjectEvent(1, alreadyPublished);
    async function* pipeline() {
      yield { type: 'stage', stage: 'research', status: 'start' };
      yield alreadyPublished; // forwarded sub-run event: already on the hub
    }
    const out = [];
    for await (const e of teeProjectEvents(1, pipeline())) out.push(e);
    expect(out).toHaveLength(2); // pass-through is unconditional
    const types = a.mock.calls.map(([e]) => e.type);
    expect(types).toEqual(['text', 'stage']); // no duplicate 'text'
  });

  it('EventChannel tee reaches the hub even with no consumer attached', () => {
    const a = vi.fn();
    sub(3, a);
    const channel = new EventChannel({
      onEvent: (event) => publishProjectEvent(3, event, { jobId: 8 }),
    });
    // Nobody is consuming the channel — the detached-run case.
    channel.push({ type: 'file_change', path: 'bg.md', kind: 'create' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toMatchObject({ path: 'bg.md', jobId: 8 });
    // The event is still buffered for a future (re)consumer.
    expect(channel.buffer).toHaveLength(1);
  });

  it('a throwing tee does not break the channel pump', async () => {
    const channel = new EventChannel({ onEvent: () => { throw new Error('tee boom'); } });
    channel.push({ type: 'text', content: 'still delivered' });
    channel.end();
    const events = [];
    for await (const e of channel) events.push(e);
    expect(events).toEqual([{ type: 'text', content: 'still delivered' }]);
  });
});
