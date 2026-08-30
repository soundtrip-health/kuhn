import { describe, it, expect, vi } from 'vitest';

import { HEARTBEAT_MS, streamEvents } from './sse.js';

function mockRes() {
  return { writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() };
}

describe('streamEvents', () => {
  it('writes each event as an SSE data frame and ends the response', async () => {
    const res = mockRes();
    async function* events() {
      yield { type: 'text', content: 'hi' };
    }
    await streamEvents(res, events());
    expect(res.write).toHaveBeenCalledWith('data: {"type":"text","content":"hi"}\n\n');
    expect(res.end).toHaveBeenCalled();
  });

  it('emits comment keepalives while the producer is idle, and stops after it ends (STH-48)', async () => {
    vi.useFakeTimers();
    try {
      const res = mockRes();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      async function* events() { await gate; }
      const done = streamEvents(res, events());

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3 + 1);
      const keepalives = res.write.mock.calls.filter(([frame]) => frame.startsWith(':'));
      expect(keepalives).toHaveLength(3);
      // A comment frame carries no "data:" line, so the webapp parser skips it.
      expect(keepalives[0][0]).toBe(': keepalive\n\n');

      release();
      await done;
      expect(res.end).toHaveBeenCalled();
      const writes = res.write.mock.calls.length;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
      expect(res.write.mock.calls.length).toBe(writes); // interval cleared
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes a producer error as an SSE error event', async () => {
    const res = mockRes();
    // eslint-disable-next-line require-yield
    async function* events() { throw new Error('boom'); }
    await streamEvents(res, events());
    expect(res.write).toHaveBeenCalledWith('data: {"type":"error","message":"boom"}\n\n');
    expect(res.end).toHaveBeenCalled();
  });
});
