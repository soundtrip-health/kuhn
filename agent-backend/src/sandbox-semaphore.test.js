// Issue #68b: FIFO semaphore semantics — capacity, ordering, release-on-throw.

import { describe, expect, it } from 'vitest';

import { Semaphore } from './sandbox-semaphore.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('Semaphore', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it('caps concurrency at capacity and hands freed slots to waiters in FIFO order', async () => {
    const sem = new Semaphore(2);
    const running = new Set();
    let peak = 0;
    const order = [];
    const gates = [];

    const job = (id) => sem.run(async () => {
      running.add(id);
      order.push(id);
      peak = Math.max(peak, running.size);
      await new Promise((resolve) => { gates.push(resolve); });
      running.delete(id);
    });

    const all = Promise.all([job('a'), job('b'), job('c'), job('d')]);
    await tick();
    expect([...running]).toEqual(['a', 'b']); // c and d queued
    expect(peak).toBe(2);

    gates.shift()(); // finish a → c starts
    await tick();
    expect(order).toEqual(['a', 'b', 'c']);
    gates.shift()(); // finish b → d starts
    await tick();
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    gates.shift()();
    gates.shift()();
    await all;
    expect(peak).toBe(2);
  });

  it('releases the slot when the wrapped fn throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The slot must be free again.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
    expect(sem.inUse).toBe(0);
  });
});
