import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Keep this a pure hub test: persistence (005-002) is covered against real
// SQLite in db/file-activity.test.js, git mechanics (008-002) in
// history.test.js — here we only assert the wiring.
vi.mock('./db/file-activity.js', () => ({ recordFileEvent: vi.fn() }));
vi.mock('./db/move-paths.js', () => ({ applyMove: vi.fn() }));
vi.mock('./db/review-links.js', () => ({ revokeLinksUnder: vi.fn(() => []) }));
vi.mock('./history.js', () => ({ scheduleCommit: vi.fn(), commitNow: vi.fn() }));
vi.mock('./yjs-websocket.js', () => ({
  evictRoom: vi.fn(),
  evictRoomsUnder: vi.fn(),
  closeReviewerConnections: vi.fn(),
  closeReviewerOnlyRoom: vi.fn(),
  CLOSE_ROOM_EVICTED: 4001,
  CLOSE_ROOM_MOVED: 4002,
  CLOSE_LINK_REVOKED: 4003,
  CLOSE_LINK_EXPIRED: 4004,
  CLOSE_DOC_REFRESH: 4005,
}));

import { recordFileEvent } from './db/file-activity.js';
import { applyMove } from './db/move-paths.js';
import { revokeLinksUnder } from './db/review-links.js';
import { commitNow, scheduleCommit } from './history.js';
import {
  closeReviewerConnections, closeReviewerOnlyRoom, evictRoom, evictRoomsUnder,
} from './yjs-websocket.js';

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

  it('wires version history: file_change schedules, job boundaries commit (008-002)', () => {
    vi.mocked(scheduleCommit).mockClear();
    vi.mocked(commitNow).mockClear();

    publishProjectEvent(1, { type: 'file_change', path: 'draft/a.md', kind: 'update', agent: 'writer' }, { userId: 7 });
    expect(scheduleCommit).toHaveBeenCalledWith(1, { agent: 'writer', userId: 7 });

    publishProjectEvent(1, { type: 'done', agent: 'writer', jobId: 42 });
    expect(commitNow).toHaveBeenCalledWith(1, { agent: 'writer', label: 'writer finished (job 42)' });

    // Sub-agent completions have no jobId at this hub; nothing to commit.
    vi.mocked(commitNow).mockClear();
    publishProjectEvent(1, { type: 'done', agent: 'ra' });
    expect(commitNow).not.toHaveBeenCalled();
  });

  it("kind 'proposed' fans out to SSE only — no activity row, eviction, or commit (008-001)", () => {
    vi.mocked(recordFileEvent).mockClear();
    vi.mocked(scheduleCommit).mockClear();
    vi.mocked(evictRoom).mockClear();
    const a = vi.fn();
    sub(1, a);

    publishProjectEvent(1, { type: 'file_change', path: 'draft/main.md', kind: 'proposed', agent: 'writer' }, { userId: 7 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toMatchObject({ kind: 'proposed', path: 'draft/main.md' });
    expect(recordFileEvent).not.toHaveBeenCalled();
    expect(evictRoom).not.toHaveBeenCalled();
    expect(scheduleCommit).not.toHaveBeenCalled();

    // A real write still gets all three side effects.
    publishProjectEvent(1, { type: 'file_change', path: 'draft/main.md', kind: 'update', agent: 'writer' }, { userId: 7 });
    expect(recordFileEvent).toHaveBeenCalledTimes(1);
    expect(evictRoom).toHaveBeenCalledTimes(1);
    expect(scheduleCommit).toHaveBeenCalledTimes(1);
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

describe("kind 'moved' (story 012-002)", () => {
  const moved = (over = {}) => ({
    type: 'file_change',
    kind: 'moved',
    path: 'archive/main.md',
    meta: { from: 'draft/main.md' },
    ...over,
  });

  beforeEach(() => {
    for (const mock of [recordFileEvent, applyMove, evictRoom, evictRoomsUnder, scheduleCommit]) {
      vi.mocked(mock).mockReset();
    }
  });

  it('re-keys through applyMove with the event attribution, never recordFileEvent', () => {
    publishProjectEvent(1, moved({ agent: 'writer' }), { jobId: 42, userId: 9 });

    expect(applyMove).toHaveBeenCalledTimes(1);
    expect(applyMove).toHaveBeenCalledWith(1, 'draft/main.md', 'archive/main.md', {
      agentSlug: 'writer', jobId: 42, userId: 9,
    });
    // applyMove owns the file_events row too — a second writer here would
    // announce a move whose rewrite could still roll back.
    expect(recordFileEvent).not.toHaveBeenCalled();
    expect(scheduleCommit).toHaveBeenCalledTimes(1);
  });

  it('evicts the old subtree AND the destination with 4002 + the new path', () => {
    publishProjectEvent(1, moved({ path: 'archive/dir', meta: { from: 'dir' } }));

    const calls = vi.mocked(evictRoomsUnder).mock.calls;
    expect(calls.map(([name]) => name)).toEqual([
      'project-1/dir',
      // Destination too, and NOT idle-only: a live room can sit on a path with
      // no file behind it and would otherwise autosave its stale seed over the
      // bytes just moved in.
      'project-1/archive/dir',
    ]);
    for (const [, opts] of calls) {
      expect(opts).toMatchObject({ closeConnections: true, closeCode: 4002 });
    }
    // The source reason is per-room: a folder move must tell each descendant
    // ITS own new path, not the folder's, or the client follows a directory.
    const [, sourceOpts] = calls[0];
    expect(typeof sourceOpts.closeReason).toBe('function');
    expect(sourceOpts.closeReason('project-1/dir')).toBe('archive/dir');
    expect(sourceOpts.closeReason('project-1/dir/a.md')).toBe('archive/dir/a.md');
    expect(sourceOpts.closeReason('project-1/dir/sub/b.md')).toBe('archive/dir/sub/b.md');
    expect(evictRoom).not.toHaveBeenCalled();
  });

  it('evicts the canonical paths applyMove reports, not the raw ones', () => {
    vi.mocked(applyMove).mockReturnValue({ from: 'dir', to: 'archive/dir' });
    publishProjectEvent(1, moved({ path: 'archive/dir/', meta: { from: './dir//' } }));

    expect(vi.mocked(evictRoomsUnder).mock.calls.map(([name]) => name))
      .toEqual(['project-1/dir', 'project-1/archive/dir']);
  });

  it('fans out exactly one envelope, after the transaction and the eviction', () => {
    const order = [];
    const a = vi.fn(() => order.push([
      vi.mocked(applyMove).mock.calls.length,
      vi.mocked(evictRoomsUnder).mock.calls.length,
    ]));
    sub(1, a);

    publishProjectEvent(1, moved(), { userId: 9 });

    expect(a).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toMatchObject({
      kind: 'moved', path: 'archive/main.md', meta: { from: 'draft/main.md' },
    });
    expect(typeof a.mock.calls[0][0].ts).toBe('string');
    // Subscribers must never see a move whose DB rewrite or eviction is still
    // pending — they would re-read the old room / the old rows.
    expect(order).toEqual([[1, 2]]);
  });

  it('propagates an applyMove failure (other kinds keep swallowing theirs)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const a = vi.fn();
      sub(1, a);
      vi.mocked(applyMove).mockImplementation(() => { throw new Error('SQLITE_CONSTRAINT'); });

      const event = moved();
      // The fs rename already happened; only the producer can compensate, so
      // the failure has to reach it.
      expect(() => publishProjectEvent(1, event)).toThrow('SQLITE_CONSTRAINT');
      expect(a).not.toHaveBeenCalled();
      expect(evictRoomsUnder).not.toHaveBeenCalled();
      expect(scheduleCommit).not.toHaveBeenCalled();

      // Nothing was persisted or delivered, so the same event object is still
      // publishable — the dedupe set must not have swallowed the retry.
      vi.mocked(applyMove).mockReturnValue({ from: 'draft/main.md', to: 'archive/main.md' });
      publishProjectEvent(1, event);
      expect(applyMove).toHaveBeenCalledTimes(2);
      expect(a).toHaveBeenCalledTimes(1);

      // A lost activity row for a plain write is still non-fatal by design.
      vi.mocked(recordFileEvent).mockImplementation(() => { throw new Error('db down'); });
      expect(() => publishProjectEvent(1, { type: 'file_change', path: 'x.md', kind: 'update' }))
        .not.toThrow();
      expect(a).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });

  it("refuses a 'moved' event with no meta.from rather than logging a bare row", () => {
    const a = vi.fn();
    sub(1, a);
    expect(() => publishProjectEvent(1, { type: 'file_change', kind: 'moved', path: 'archive/main.md' }))
      .toThrow(/meta\.from/);
    expect(applyMove).not.toHaveBeenCalled();
    expect(recordFileEvent).not.toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
  });
});

describe('review-link lifecycle (epic 013, story 003)', () => {
  const change = (kind, over = {}) => ({
    type: 'file_change', kind, path: 'draft/main.md', ...over,
  });

  beforeEach(() => {
    for (const mock of [
      recordFileEvent, applyMove, evictRoom, evictRoomsUnder, scheduleCommit,
      revokeLinksUnder, closeReviewerConnections, closeReviewerOnlyRoom,
    ]) {
      vi.mocked(mock).mockReset();
    }
    vi.mocked(revokeLinksUnder).mockReturnValue([]);
  });

  it('delete revokes every link under the path and closes each credential\'s sockets', () => {
    vi.mocked(revokeLinksUnder).mockReturnValue([3, 8]);

    publishProjectEvent(7, change('delete', { path: 'draft/dir' }));

    expect(revokeLinksUnder).toHaveBeenCalledTimes(1);
    expect(revokeLinksUnder).toHaveBeenCalledWith(7, 'draft/dir');
    // One close per revoked credential — NOT room-level eviction, which would
    // kick members and destroy doc state (that stays evictRoom's job below).
    expect(closeReviewerConnections).toHaveBeenCalledTimes(2);
    expect(closeReviewerConnections).toHaveBeenNthCalledWith(1, 3, {
      code: 4003, reason: 'Document removed',
    });
    expect(closeReviewerConnections).toHaveBeenNthCalledWith(2, 8, {
      code: 4003, reason: 'Document removed',
    });
    // The delete still closes the room itself for everyone.
    expect(evictRoom).toHaveBeenCalledWith('project-7/draft/dir', { closeConnections: true });
  });

  it('revocation runs before fan-out, so no subscriber acts while links are live', () => {
    vi.mocked(revokeLinksUnder).mockReturnValue([5]);
    const order = [];
    const a = vi.fn(() => order.push([
      vi.mocked(revokeLinksUnder).mock.calls.length,
      vi.mocked(closeReviewerConnections).mock.calls.length,
    ]));
    sub(1, a);

    publishProjectEvent(1, change('delete'));

    expect(order).toEqual([[1, 1]]);
  });

  it('a revocation failure is loud and does not break eviction or delivery', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.mocked(revokeLinksUnder).mockImplementation(() => { throw new Error('db locked'); });
      const a = vi.fn();
      sub(1, a);

      // A credential failure must not take event delivery down with it…
      expect(() => publishProjectEvent(1, change('delete'))).not.toThrow();
      expect(a).toHaveBeenCalledTimes(1);
      expect(evictRoom).toHaveBeenCalledTimes(1);
      expect(closeReviewerConnections).not.toHaveBeenCalled();
      // …but it must NOT inherit the generic activity-row swallow either:
      // its own catch logs a distinct, unmistakable message.
      const logged = errors.mock.calls.map(([msg]) => String(msg));
      expect(logged.some((m) => m.includes('REVIEW LINK REVOCATION FAILED')
        && m.includes("'draft/main.md'"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it('a real non-delete write closes a reviewer-only room at that path (decision 3)', () => {
    for (const kind of ['create', 'update', 'upload']) {
      publishProjectEvent(2, change(kind, { path: `docs/${kind}.md` }));
      expect(closeReviewerOnlyRoom).toHaveBeenCalledWith(`project-2/docs/${kind}.md`);
    }
    expect(closeReviewerOnlyRoom).toHaveBeenCalledTimes(3);
    // No revocation on a mere write.
    expect(revokeLinksUnder).not.toHaveBeenCalled();
  });

  it('delete, proposed, moved and non-file events never reach the reviewer-only closure', () => {
    publishProjectEvent(1, change('delete')); // evictRoom already closed everyone
    publishProjectEvent(1, change('proposed')); // pending marker, not a real write
    publishProjectEvent(1, change('moved', { path: 'b.md', meta: { from: 'a.md' } }));
    publishProjectEvent(1, { type: 'notice' });
    expect(closeReviewerOnlyRoom).not.toHaveBeenCalled();
    // And nothing but delete revokes.
    expect(revokeLinksUnder).toHaveBeenCalledTimes(1);
    expect(revokeLinksUnder).toHaveBeenCalledWith(1, 'draft/main.md');
  });
});
