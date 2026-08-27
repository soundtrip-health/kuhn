// The fixed-window limiter behind request-link (STH-35). Fake timers, because
// window expiry is the whole behavior and sleeping through a 15-minute window
// is not a test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const limiter = () => createRateLimiter({ limit: 3, windowMs: 1000 });

describe('createRateLimiter', () => {
  it('allows up to the limit, then refuses', () => {
    const rl = limiter();
    for (let i = 0; i < 3; i++) expect(rl.consume('a').ok).toBe(true);
    expect(rl.consume('a').ok).toBe(false);
  });

  it('keeps a separate budget per key', () => {
    const rl = limiter();
    for (let i = 0; i < 3; i++) rl.consume('a');
    expect(rl.consume('a').ok).toBe(false);
    expect(rl.consume('b').ok).toBe(true); // b is untouched by a's spending
  });

  it('reports a retryAfter that shrinks as the window drains', () => {
    const rl = limiter();
    for (let i = 0; i < 3; i++) rl.consume('a');
    expect(rl.consume('a').retryAfterMs).toBe(1000);
    vi.advanceTimersByTime(400);
    expect(rl.consume('a').retryAfterMs).toBe(600);
  });

  it('trips exactly once per window, so audit rows stay bounded', () => {
    const rl = limiter();
    for (let i = 0; i < 3; i++) rl.consume('a');
    expect(rl.consume('a').tripped).toBe(true);
    expect(rl.consume('a').tripped).toBe(false);
    expect(rl.consume('a').tripped).toBe(false);

    // A fresh window can trip again — an offender who returns is worth a row.
    vi.advanceTimersByTime(1001);
    for (let i = 0; i < 3; i++) rl.consume('a');
    expect(rl.consume('a').tripped).toBe(true);
  });

  it('restores the full budget once the window passes', () => {
    const rl = limiter();
    for (let i = 0; i < 4; i++) rl.consume('a');
    expect(rl.consume('a').ok).toBe(false);
    vi.advanceTimersByTime(1001);
    for (let i = 0; i < 3; i++) expect(rl.consume('a').ok).toBe(true);
    expect(rl.consume('a').ok).toBe(false);
  });

  it('sweeps expired keys instead of growing without bound', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    for (let i = 0; i < 50; i++) rl.consume(`key-${i}`);
    expect(rl.size()).toBe(50);
    // Everything above has expired; the next call sweeps and leaves only it.
    vi.advanceTimersByTime(1001);
    rl.consume('fresh');
    expect(rl.size()).toBe(1);
  });

  it('reset() drops every window', () => {
    const rl = limiter();
    for (let i = 0; i < 4; i++) rl.consume('a');
    rl.reset();
    expect(rl.size()).toBe(0);
    expect(rl.consume('a').ok).toBe(true);
  });
});
