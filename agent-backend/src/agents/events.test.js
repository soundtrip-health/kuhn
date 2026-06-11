import { describe, it, expect } from 'vitest';
import { EventChannel } from './events.js';

describe('EventChannel', () => {
  it('delivers buffered events in order', async () => {
    const ch = new EventChannel();
    ch.push(1);
    ch.push(2);
    ch.end();
    const seen = [];
    for await (const v of ch) seen.push(v);
    expect(seen).toEqual([1, 2]);
  });

  it('wakes a waiting consumer when an event is pushed', async () => {
    const ch = new EventChannel();
    const pending = ch.next();
    ch.push('late');
    expect(await pending).toEqual({ value: 'late', done: false });
  });

  it('end() resolves waiting consumers as done', async () => {
    const ch = new EventChannel();
    const pending = ch.next();
    ch.end();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it('ignores pushes after end()', async () => {
    const ch = new EventChannel();
    ch.end();
    ch.push('dropped');
    expect(await ch.next()).toEqual({ value: undefined, done: true });
  });
});
