import { describe, it, expect, vi } from 'vitest';

// Keep this an eviction test: file_change persistence is covered in
// db/file-activity.test.js, hub fan-out in project-events.test.js.
vi.mock('./db/file-activity.js', () => ({ recordFileEvent: vi.fn() }));
vi.mock('./history.js', () => ({ scheduleCommit: vi.fn(), commitNow: vi.fn() }));

import * as decoding from 'lib0/decoding';

import { handleYjsConnection, evictRoom, hasRoom } from './yjs-websocket.js';
import { publishProjectEvent } from './project-events.js';

/** Minimal ws double: enough surface for handleYjsConnection + evictRoom. */
function fakeWs() {
  const handlers = new Map();
  return {
    readyState: 1,
    closed: null,
    sent: [],
    on(event, fn) {
      handlers.set(event, fn);
    },
    send(message) {
      this.sent.push(message);
    },
    close(code, reason) {
      this.closed = { code, reason };
      handlers.get('close')?.();
    },
    /** Simulate the client going away without a server-initiated close. */
    disconnect() {
      handlers.get('close')?.();
    },
  };
}

function connect(room) {
  const ws = fakeWs();
  handleYjsConnection(ws, { url: `/yjs-websocket/${room}`, headers: { host: 'localhost' } });
  return ws;
}

/** Decode a seed-grant message (varUint type 64, varUint 0|1). */
function decodeGrant(message) {
  const dec = decoding.createDecoder(new Uint8Array(message));
  expect(decoding.readVarUint(dec)).toBe(64);
  return decoding.readVarUint(dec);
}

describe('collab room eviction (story 038)', () => {
  it('evicts an idle room (empty-room grace window)', () => {
    const room = 'project-901/draft/idle.md';
    connect(room).disconnect(); // room now idle, inside the 30s grace window
    expect(hasRoom(room)).toBe(true);
    expect(evictRoom(room)).toBe(true);
    expect(hasRoom(room)).toBe(false);
  });

  it('leaves a room with live connections alone unless closeConnections is set', () => {
    const room = 'project-901/draft/live.md';
    const ws = connect(room);
    expect(evictRoom(room)).toBe(false);
    expect(hasRoom(room)).toBe(true);
    expect(ws.closed).toBe(null);

    expect(evictRoom(room, { closeConnections: true })).toBe(true);
    expect(hasRoom(room)).toBe(false);
    expect(ws.closed).toEqual({ code: 4001, reason: 'Document removed' });
  });

  it('returns false for a room that does not exist', () => {
    expect(evictRoom('project-901/never-opened.md')).toBe(false);
  });

  it('a delete file_change evicts the room and kicks live clients', () => {
    const room = 'project-902/draft/main.md';
    const ws = connect(room);
    publishProjectEvent(902, { type: 'file_change', path: 'draft/main.md', kind: 'delete' });
    expect(hasRoom(room)).toBe(false);
    expect(ws.closed?.code).toBe(4001);
  });

  it('an upload overwrite evicts only an idle room, never live collaborators', () => {
    const liveRoom = 'project-903/draft/open.md';
    const idleRoom = 'project-903/draft/closed.md';
    const ws = connect(liveRoom);
    connect(idleRoom).disconnect();

    publishProjectEvent(903, { type: 'file_change', path: 'draft/open.md', kind: 'update' });
    publishProjectEvent(903, { type: 'file_change', path: 'draft/closed.md', kind: 'update' });

    expect(hasRoom(liveRoom)).toBe(true); // open editor reconciles via the feed
    expect(ws.closed).toBe(null);
    expect(hasRoom(idleRoom)).toBe(false); // stale orphan: next open seeds fresh
  });

  it('grants seeding to the first connection into an empty room only (story 041)', () => {
    const room = 'project-905/draft/seed.md';
    const first = connect(room);
    const second = connect(room);
    // The grant is the first message every connection receives.
    expect(decodeGrant(first.sent[0])).toBe(1);
    expect(decodeGrant(second.sent[0])).toBe(0);

    // A fresh room after eviction grants again.
    first.disconnect();
    second.disconnect();
    evictRoom(room);
    const third = connect(room);
    expect(decodeGrant(third.sent[0])).toBe(1);
  });

  it('a re-created room after eviction starts from empty state', () => {
    const room = 'project-904/draft/reup.md';
    connect(room).disconnect();
    publishProjectEvent(904, { type: 'file_change', path: 'draft/reup.md', kind: 'delete' });
    expect(hasRoom(room)).toBe(false);
    // The delete+re-upload repro: a new connection gets a brand-new doc.
    connect(room);
    expect(hasRoom(room)).toBe(true);
  });
});
