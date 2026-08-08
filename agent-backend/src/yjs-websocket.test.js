import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';

// Keep this an eviction + message-gate test: file_change persistence is
// covered in db/file-activity.test.js, hub fan-out in project-events.test.js.
vi.mock('./db/file-activity.js', () => ({ recordFileEvent: vi.fn() }));
vi.mock('./history.js', () => ({ scheduleCommit: vi.fn(), commitNow: vi.fn() }));

// Real in-memory SQLite: the reviewer TOCTOU re-check and sweep validate link
// state in the DB (epic 013). Must be set before db.js loads, hence the
// dynamic imports in beforeAll (static app-module imports would hoist past it).
process.env.KUHN_SQLITE_PATH = ':memory:';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const __dirname = dirname(fileURLToPath(import.meta.url));

let handleYjsConnection; let evictRoom; let evictRoomsUnder; let hasRoom;
let closeReviewerConnections; let closeReviewerOnlyRoom; let sweepReviewerConnections;
let sweepMemberConnections;
let publishProjectEvent;
let config;
let querySync;
let createReviewLink; let revokeReviewLink;

beforeAll(async () => {
  let exec;
  ({ config } = await import('./config.js'));
  ({ exec, querySync } = await import('./db.js'));
  exec(readFileSync(resolve(__dirname, 'db/schema.sql'), 'utf-8'));
  ({
    handleYjsConnection, evictRoom, evictRoomsUnder, hasRoom,
    closeReviewerConnections, closeReviewerOnlyRoom, sweepReviewerConnections,
    sweepMemberConnections,
  } = await import('./yjs-websocket.js'));
  ({ publishProjectEvent } = await import('./project-events.js'));
  ({ createReviewLink, revokeReviewLink } = await import('./db/review-links.js'));

  // Minimal tenancy fixtures for review_links FKs and the member sweep
  // (010-003): org 7 holds an owner-ish member (1), a viewer (2) and an
  // editor (3); org 9 with project 6 is suspendable within tests; user 4
  // belongs to both (editor) so removal/suspension can be exercised without
  // disturbing the other fixtures.
  querySync("INSERT INTO organizations (id, name, slug) VALUES (7, 'Lab', 'lab'), (9, 'Freezable', 'freezable')");
  querySync(`INSERT INTO users (id, email) VALUES
    (1, 'member@lab.org'), (2, 'viewer@lab.org'), (3, 'editor@lab.org'), (4, 'other@lab.org')`);
  querySync('INSERT INTO memberships (user_id, org_id) VALUES (1, 7)'); // default role: editor
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES
    (2, 7, 'viewer'), (3, 7, 'editor'), (4, 7, 'editor'), (4, 9, 'editor')`);
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (5, 7, 'P', 'manuscript')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (6, 9, 'F', 'manuscript')");
});

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
      // The real ws throws here past the close-frame limit; emulate it so the
      // safeReason guard is actually exercised (story 012-002).
      if (Buffer.byteLength(reason ?? '', 'utf8') > 123) {
        throw new RangeError('The message must not be greater than 123 bytes');
      }
      this.closed = { code, reason };
      handlers.get('close')?.();
    },
    /** Deliver a client → server message. */
    receive(bytes) {
      handlers.get('message')?.(bytes);
    },
    /** Simulate the client going away without a server-initiated close. */
    disconnect() {
      handlers.get('close')?.();
    },
  };
}

function connect(room, collab) {
  const ws = fakeWs();
  const req = { url: `/yjs-websocket/${room}`, headers: { host: 'localhost' } };
  if (collab) req.kuhnCollab = collab;
  handleYjsConnection(ws, req);
  return ws;
}

/** Mint a live review link and shape its reviewer principal. */
function mintPrincipal(path, mode, name = 'Jane', projectId = 5) {
  const { link } = createReviewLink({ projectId, path, mode, createdBy: 1 });
  return {
    kind: 'reviewer', linkId: link.id, projectId, path, mode, name,
    expiresAt: link.expiresAt,
  };
}

const MEMBER_COLLAB = { principal: { kind: 'member', user: { id: 1 } }, access: 'write' };

/** Member collab stamp for any fixture user (story 010-003). */
const memberCollab = (id, access = 'write') => ({ principal: { kind: 'member', user: { id } }, access });

// --- binary message helpers -------------------------------------------------

const msgType = (m) => decoding.readVarUint(decoding.createDecoder(new Uint8Array(m)));
const messagesOfType = (ws, type) => ws.sent.filter((m) => msgType(m) === type);

/** Decode a seed-grant message (varUint type 64, varUint 0|1). */
function decodeGrant(message) {
  const dec = decoding.createDecoder(new Uint8Array(message));
  expect(decoding.readVarUint(dec)).toBe(64);
  return decoding.readVarUint(dec);
}

/** Decode a MSG_REVIEWERS message (varUint type 65, varString JSON). */
function decodeReviewers(message) {
  const dec = decoding.createDecoder(new Uint8Array(message));
  expect(decoding.readVarUint(dec)).toBe(65);
  return JSON.parse(decoding.readVarString(dec)).reviewers;
}

function docWithText(text) {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, text);
  return doc;
}

function updateMessage(update) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

function step1Message(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
}

function step2Message(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep2(enc, doc);
  return encoding.toUint8Array(enc);
}

/** Apply every MSG_SYNC message a conn has received into a client-side doc. */
function applySync(ws, doc, from = 0) {
  for (const m of ws.sent.slice(from)) {
    const dec = decoding.createDecoder(new Uint8Array(m));
    if (decoding.readVarUint(dec) !== 0) continue;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.readSyncMessage(dec, enc, doc, null);
  }
  return doc;
}

/** Read the server room's text via a fresh read-only probe's step1/step2. */
function serverText(room) {
  const probe = connect(room, { principal: null, access: 'read' });
  const doc = new Y.Doc();
  probe.receive(step1Message(doc));
  applySync(probe, doc);
  probe.disconnect();
  return doc.getText('t').toString();
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

  it('closes with the caller\'s code and reason when a move redirects the room (story 012-002)', () => {
    const room = 'project-906/draft/main.md';
    const ws = connect(room);
    expect(
      evictRoom(room, { closeConnections: true, closeCode: 4002, closeReason: 'archive/main.md' }),
    ).toBe(true);
    expect(hasRoom(room)).toBe(false);
    expect(ws.closed).toEqual({ code: 4002, reason: 'archive/main.md' });
  });

  it('drops an over-long close reason instead of throwing mid-eviction', () => {
    const room = 'project-907/draft/main.md';
    const first = connect(room);
    const second = connect(room);
    // 124 UTF-8 bytes: one past the close-frame cap. The SSE 'moved' event,
    // not the reason string, is what tells clients where the file went.
    const longPath = `${'a'.repeat(120)}/x.md`;
    expect(Buffer.byteLength(longPath, 'utf8')).toBeGreaterThan(123);

    expect(
      evictRoom(room, { closeConnections: true, closeCode: 4002, closeReason: longPath }),
    ).toBe(true);
    expect(hasRoom(room)).toBe(false);
    // Every connection is closed — the first oversized reason must not abort
    // the loop and strand the rest.
    expect(first.closed).toEqual({ code: 4002, reason: '' });
    expect(second.closed).toEqual({ code: 4002, reason: '' });
  });

  it('evictRoomsUnder evicts a folder and its descendants but not a prefix look-alike', () => {
    const folder = 'project-908/dir';
    const child = 'project-908/dir/a.md';
    const grandchild = 'project-908/dir/sub/b.md';
    const lookAlike = 'project-908/directive.md';
    const otherProject = 'project-9080/dir/a.md';
    const rooms = [folder, child, grandchild, lookAlike, otherProject].map((r) => [r, connect(r)]);

    expect(
      evictRoomsUnder(folder, { closeConnections: true, closeCode: 4002, closeReason: 'archive/dir' }),
    ).toBe(3);

    for (const [room, ws] of rooms) {
      const evicted = room === folder || room === child || room === grandchild;
      expect([room, hasRoom(room)]).toEqual([room, !evicted]);
      expect([room, ws.closed]).toEqual([room, evicted ? { code: 4002, reason: 'archive/dir' } : null]);
    }
  });

  it('evictRoomsUnder honours idle-only semantics and returns 0 when nothing matches', () => {
    const live = 'project-909/dir/live.md';
    const idle = 'project-909/dir/idle.md';
    const ws = connect(live);
    connect(idle).disconnect();

    expect(evictRoomsUnder('project-909/dir')).toBe(1); // idle only
    expect(hasRoom(idle)).toBe(false);
    expect(hasRoom(live)).toBe(true);
    expect(ws.closed).toBe(null);

    expect(evictRoomsUnder('project-909/never-opened')).toBe(0);
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

describe('message-level read-only gate (epic 013 story 002)', () => {
  it('drops a crafted Update and a crafted SyncStep2 from a read connection — the doc is provably unchanged', () => {
    const room = 'project-5/draft/gate.md';
    const member = connect(room, MEMBER_COLLAB);
    const viewer = connect(room, { principal: mintPrincipal('draft/gate.md', 'view'), access: 'read' });

    const before = member.sent.length;
    viewer.receive(updateMessage(Y.encodeStateAsUpdate(docWithText('INJECTED'))));
    viewer.receive(step2Message(docWithText('ALSO INJECTED')));

    // No broadcast reached the member, and a fresh sync sees an empty doc.
    expect(member.sent.length).toBe(before);
    expect(serverText(room)).toBe('');

    // Positive control: the same bytes from a write connection DO land…
    member.receive(updateMessage(Y.encodeStateAsUpdate(docWithText('LEGIT'))));
    expect(serverText(room)).toBe('LEGIT');

    // …and the read connection received the live broadcast (read ≠ deaf).
    const viewerDoc = applySync(viewer, new Y.Doc());
    expect(viewerDoc.getText('t').toString()).toBe('LEGIT');
    member.disconnect();
    viewer.disconnect();
  });

  it('answers a read connection\'s SyncStep1 with full state (reads stay open)', () => {
    const room = 'project-5/draft/gate-read.md';
    const member = connect(room, MEMBER_COLLAB);
    member.receive(updateMessage(Y.encodeStateAsUpdate(docWithText('HELLO'))));

    const viewer = connect(room, { principal: mintPrincipal('draft/gate-read.md', 'view'), access: 'read' });
    const doc = new Y.Doc();
    const from = viewer.sent.length;
    viewer.receive(step1Message(doc));
    applySync(viewer, doc, from);
    expect(doc.getText('t').toString()).toBe('HELLO');
    member.disconnect();
    viewer.disconnect();
  });

  it('never grants the seed to a read-only connection, even first into an empty room', () => {
    const room = 'project-5/draft/seed-guard.md';
    const viewer = connect(room, { principal: mintPrincipal('draft/seed-guard.md', 'view'), access: 'read' });
    expect(decodeGrant(viewer.sent[0])).toBe(0);

    // The first WRITE-capable connection (an edit-mode reviewer) gets it.
    const editor = connect(room, { principal: mintPrincipal('draft/seed-guard.md', 'edit'), access: 'write' });
    expect(decodeGrant(editor.sent[0])).toBe(1);

    // A later write connection does not.
    const member = connect(room, MEMBER_COLLAB);
    expect(decodeGrant(member.sent[0])).toBe(0);
    viewer.disconnect();
    editor.disconnect();
    member.disconnect();
  });

  it('applies awareness from a read connection, stamped with the server-side reviewer identity', () => {
    const room = 'project-5/draft/aware.md';
    const member = connect(room, MEMBER_COLLAB);
    const viewer = connect(room, { principal: mintPrincipal('draft/aware.md', 'comment', 'Jane'), access: 'read' });

    // The client CLAIMS to be a member — the stamp must override the name.
    const clientAw = new awarenessProtocol.Awareness(new Y.Doc());
    clientAw.setLocalState({ user: { name: 'Dr. Member', color: '#123456' }, cursor: 7 });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(
      enc, awarenessProtocol.encodeAwarenessUpdate(clientAw, [clientAw.clientID]),
    );
    viewer.receive(encoding.toUint8Array(enc));

    const scratch = new awarenessProtocol.Awareness(new Y.Doc());
    const applyAwareness = () => {
      for (const m of messagesOfType(member, 1)) {
        const dec = decoding.createDecoder(new Uint8Array(m));
        decoding.readVarUint(dec);
        awarenessProtocol.applyAwarenessUpdate(scratch, decoding.readVarUint8Array(dec), null);
      }
    };
    applyAwareness();
    const state = scratch.getStates().get(clientAw.clientID);
    expect(state.cursor).toBe(7); // presence itself propagates
    expect(state.user).toEqual({ color: '#123456', name: 'Jane', external: true });

    // Disconnect removes exactly the tracked awareness states (the pre-013
    // `_awarenessClientId` cleanup was dead code — nothing ever set it).
    viewer.disconnect();
    applyAwareness();
    expect(scratch.getStates().has(clientAw.clientID)).toBe(false);
    member.disconnect();
  });

  it('a malformed frame closes the sender (1002) without crashing the room', () => {
    const room = 'project-5/draft/mangle.md';
    const member = connect(room, MEMBER_COLLAB);
    // Each of these throws inside the lib0/y-protocols decode path if the
    // handler lets it escape: empty frame, MSG_SYNC with no sub-type,
    // MSG_AWARENESS with no payload, truncated varUint payload length.
    for (const bytes of [[], [0], [1], [1, 200]]) {
      const attacker = connect(room, {
        principal: mintPrincipal('draft/mangle.md', 'view', 'Mallory'), access: 'read',
      });
      expect(() => attacker.receive(new Uint8Array(bytes))).not.toThrow();
      expect(attacker.closed?.code).toBe(1002);
    }
    // The room and its member survive; a well-formed sync still round-trips.
    const probe = new Y.Doc();
    member.receive(step1Message(probe));
    expect(messagesOfType(member, 0).length).toBeGreaterThan(0);
    member.disconnect();
  });

  it('a reviewer cannot speak for another socket\'s awareness client id', () => {
    const room = 'project-5/draft/spoof.md';
    const member = connect(room, MEMBER_COLLAB);
    const observer = connect(room, MEMBER_COLLAB); // watches the broadcasts
    const memberAw = new awarenessProtocol.Awareness(new Y.Doc());
    memberAw.setLocalState({ user: { name: 'Dr. Member' }, cursor: 1 });
    const send = (ws, aw, ids) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(aw, ids));
      ws.receive(encoding.toUint8Array(enc));
    };
    send(member, memberAw, [memberAw.clientID]);

    // The reviewer replays the member's clientID with a bumped clock — the
    // roster broadcast handed it that id, applyAwarenessUpdate would accept it.
    const reviewer = connect(room, { principal: mintPrincipal('draft/spoof.md', 'comment', 'Jane'), access: 'read' });
    memberAw.setLocalState({ user: { name: 'Dr. Member' }, cursor: 99 });
    send(reviewer, memberAw, [memberAw.clientID]);

    const scratch = new awarenessProtocol.Awareness(new Y.Doc());
    const applyAwareness = () => {
      for (const m of messagesOfType(observer, 1)) {
        const dec = decoding.createDecoder(new Uint8Array(m));
        decoding.readVarUint(dec);
        awarenessProtocol.applyAwarenessUpdate(scratch, decoding.readVarUint8Array(dec), null);
      }
    };
    applyAwareness();
    const state = scratch.getStates().get(memberAw.clientID);
    expect(state.cursor).toBe(1); // the spoofed update never applied
    expect(state.user.name).toBe('Dr. Member');
    expect(state.user.external).toBeUndefined();

    // And the reviewer's disconnect must not delete the member's presence.
    reviewer.disconnect();
    applyAwareness();
    expect(scratch.getStates().has(memberAw.clientID)).toBe(true);
    member.disconnect();
    observer.disconnect();
  });
});

describe('reviewer connection lifecycle (epic 013)', () => {
  it('closeReviewerConnections closes only that link\'s sockets with 4003; the room and its members survive', () => {
    const room = 'project-5/draft/revoke.md';
    const member = connect(room, MEMBER_COLLAB);
    const pA = mintPrincipal('draft/revoke.md', 'comment', 'Jane');
    const pB = mintPrincipal('draft/revoke.md', 'view', 'Ada');
    const revA = connect(room, { principal: pA, access: 'read' });
    const revB = connect(room, { principal: pB, access: 'read' });

    expect(closeReviewerConnections(pA.linkId)).toBe(1);
    expect(revA.closed).toEqual({ code: 4003, reason: 'Link revoked' });
    expect(revB.closed).toBe(null);
    expect(member.closed).toBe(null);
    expect(hasRoom(room)).toBe(true);

    // Idempotent: the registry was cleaned by the close handler.
    expect(closeReviewerConnections(pA.linkId)).toBe(0);
    revB.disconnect();
    member.disconnect();
  });

  it('closeReviewerOnlyRoom refreshes a reviewer-only room (4005) but never one holding a member', () => {
    const mixed = 'project-5/draft/mixed.md';
    const member = connect(mixed, MEMBER_COLLAB);
    const rev = connect(mixed, { principal: mintPrincipal('draft/mixed.md', 'view'), access: 'read' });
    expect(closeReviewerOnlyRoom(mixed)).toBe(false);
    expect(member.closed).toBe(null);
    expect(rev.closed).toBe(null);

    const only = 'project-5/draft/only-reviewers.md';
    const r1 = connect(only, { principal: mintPrincipal('draft/only-reviewers.md', 'edit'), access: 'write' });
    const r2 = connect(only, { principal: mintPrincipal('draft/only-reviewers.md', 'view'), access: 'read' });
    expect(closeReviewerOnlyRoom(only)).toBe(true);
    expect(r1.closed).toEqual({ code: 4005, reason: 'Document updated' });
    expect(r2.closed).toEqual({ code: 4005, reason: 'Document updated' });
    expect(hasRoom(only)).toBe(false); // reconnect re-seeds fresh from storage

    expect(closeReviewerOnlyRoom('project-5/never-opened.md')).toBe(false);
    member.disconnect();
    rev.disconnect();
  });

  it('re-checks link state right after registration: a revoke in the upgrade window closes immediately', () => {
    const p = mintPrincipal('draft/toctou.md', 'comment');
    revokeReviewLink(5, p.linkId);
    const ws = connect('project-5/draft/toctou.md', { principal: p, access: 'read' });
    expect(ws.closed).toEqual({ code: 4003, reason: 'Link revoked' });
    expect(ws.sent).toEqual([]); // no grant, no doc bytes

    const pExp = mintPrincipal('draft/toctou2.md', 'view');
    querySync("UPDATE review_links SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1", [pExp.linkId]);
    const ws2 = connect('project-5/draft/toctou2.md', { principal: pExp, access: 'read' });
    expect(ws2.closed).toEqual({ code: 4004, reason: 'Link expired' });
  });

  it('the sweep re-validates links in the DB: expiry → 4004, revocation → 4003, deletion → 4003', () => {
    const room = 'project-5/draft/sweep.md';
    const pLive = mintPrincipal(`draft/sweep.md`, 'view', 'Live');
    const pExpire = mintPrincipal('draft/sweep.md', 'view', 'Old');
    const pRevoke = mintPrincipal('draft/sweep.md', 'view', 'Cut');
    const pGone = mintPrincipal('draft/sweep.md', 'view', 'Gone');
    const live = connect(room, { principal: pLive, access: 'read' });
    const expiring = connect(room, { principal: pExpire, access: 'read' });
    const revoking = connect(room, { principal: pRevoke, access: 'read' });
    const vanishing = connect(room, { principal: pGone, access: 'read' });

    sweepReviewerConnections();
    expect([live.closed, expiring.closed, revoking.closed, vanishing.closed]).toEqual([null, null, null, null]);

    querySync("UPDATE review_links SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1", [pExpire.linkId]);
    querySync(`UPDATE review_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1`, [pRevoke.linkId]);
    querySync('DELETE FROM review_links WHERE id = $1', [pGone.linkId]);
    sweepReviewerConnections();

    expect(live.closed).toBe(null);
    expect(expiring.closed).toEqual({ code: 4004, reason: 'Link expired' });
    expect(revoking.closed).toEqual({ code: 4003, reason: 'Link revoked' });
    expect(vanishing.closed).toEqual({ code: 4003, reason: 'Document removed' });
    live.disconnect();
  });

  it('broadcasts a server-attributed reviewer roster (MSG_REVIEWERS) on join, to late joiners, and on leave', () => {
    const room = 'project-5/draft/presence.md';
    const member = connect(room, MEMBER_COLLAB);
    expect(messagesOfType(member, 65)).toEqual([]); // no reviewers yet

    const p = mintPrincipal('draft/presence.md', 'comment', 'Jane');
    const rev = connect(room, { principal: p, access: 'read' });
    const joined = messagesOfType(member, 65);
    expect(joined.length).toBe(1);
    expect(decodeReviewers(joined[0])).toEqual([{ linkId: p.linkId, name: 'Jane', mode: 'comment' }]);

    // A member joining a room that already has a reviewer is told about them.
    const late = connect(room, MEMBER_COLLAB);
    const lateRoster = messagesOfType(late, 65);
    expect(lateRoster.length).toBe(1);
    expect(decodeReviewers(lateRoster[0])).toEqual([{ linkId: p.linkId, name: 'Jane', mode: 'comment' }]);

    rev.disconnect();
    const after = messagesOfType(member, 65);
    expect(decodeReviewers(after[after.length - 1])).toEqual([]);
    member.disconnect();
    late.disconnect();
  });
});

// --- Story 010-003: viewer members on the message gate + the member sweep ----

describe('viewer-member message gate (story 010-003 AC2)', () => {
  it('drops crafted Update/SyncStep2 from a member socket stamped read; broadcasts still reach it', () => {
    const room = 'project-5/draft/member-gate.md';
    const editor = connect(room, memberCollab(3));
    const viewer = connect(room, memberCollab(2, 'read'));

    const before = editor.sent.length;
    viewer.receive(updateMessage(Y.encodeStateAsUpdate(docWithText('INJECTED'))));
    viewer.receive(step2Message(docWithText('ALSO INJECTED')));

    // No broadcast reached the editor, and a fresh sync sees an empty doc —
    // dropped at the message level, exactly like a view-mode reviewer.
    expect(editor.sent.length).toBe(before);
    expect(serverText(room)).toBe('');

    // Positive control: the editor's write lands and is broadcast to the
    // read-only viewer connection (read ≠ deaf).
    editor.receive(updateMessage(Y.encodeStateAsUpdate(docWithText('LEGIT'))));
    expect(serverText(room)).toBe('LEGIT');
    const viewerDoc = applySync(viewer, new Y.Doc());
    expect(viewerDoc.getText('t').toString()).toBe('LEGIT');
    editor.disconnect();
    viewer.disconnect();
  });

  it('never grants the seed to a viewer-member read socket, even first into an empty room', () => {
    const room = 'project-5/draft/member-seed.md';
    const viewer = connect(room, memberCollab(2, 'read'));
    expect(decodeGrant(viewer.sent[0])).toBe(0);

    const editor = connect(room, memberCollab(3));
    expect(decodeGrant(editor.sent[0])).toBe(1);
    viewer.disconnect();
    editor.disconnect();
  });
});

describe('member socket sweep (story 010-003, fix MB3)', () => {
  // The sweep consults the DB through memberRoomAccess, which is
  // unconditionally 'write' in dev mode — flip to magic-link so entitlement
  // changes are actually evaluated. handleYjsConnection itself never reads
  // config, so the rest of this file is unaffected.
  beforeAll(() => {
    config.auth.mode = 'magic-link';
  });
  afterAll(() => {
    config.auth.mode = 'dev';
  });

  it('leaves sockets alone while their entitlement still covers the stamp', async () => {
    const room = 'project-5/draft/sweep-ok.md';
    const write = connect(room, memberCollab(3));
    const read = connect(room, memberCollab(2, 'read'));
    await sweepMemberConnections();
    expect(write.closed).toBe(null);
    expect(read.closed).toBe(null);
    write.disconnect();
    read.disconnect();
  });

  it('demotion closes the write socket with 4006; a promoted viewer read socket survives', async () => {
    const room = 'project-5/draft/sweep-demote.md';
    const write = connect(room, memberCollab(3)); // editor, stamped write
    const read = connect(room, memberCollab(2, 'read')); // viewer, stamped read
    querySync("UPDATE memberships SET role = 'viewer' WHERE user_id = 3 AND org_id = 7");
    querySync("UPDATE memberships SET role = 'editor' WHERE user_id = 2 AND org_id = 7");
    try {
      await sweepMemberConnections();
      // The demoted editor's write socket closes; reconnect re-authorizes at
      // upgrade and lands read-only.
      expect(write.closed).toEqual({ code: 4006, reason: 'Write access revoked' });
      // The promoted viewer's read socket is still within entitlement.
      expect(read.closed).toBe(null);
    } finally {
      querySync("UPDATE memberships SET role = 'editor' WHERE user_id = 3 AND org_id = 7");
      querySync("UPDATE memberships SET role = 'viewer' WHERE user_id = 2 AND org_id = 7");
    }
    read.disconnect();
  });

  it('membership removal closes the socket', async () => {
    const ws = connect('project-5/draft/sweep-removed.md', memberCollab(4));
    querySync('DELETE FROM memberships WHERE user_id = 4 AND org_id = 7');
    try {
      await sweepMemberConnections();
      expect(ws.closed).toEqual({ code: 4006, reason: 'Organization access revoked' });
    } finally {
      querySync("INSERT INTO memberships (user_id, org_id, role) VALUES (4, 7, 'editor')");
    }
  });

  it('suspension closes live member sockets AND reviewer sockets on the org (fixes MB3 + MA2)', async () => {
    const room = 'project-6/draft/frozen.md';
    const memberWs = connect(room, memberCollab(4));
    const rev = connect(room, {
      principal: mintPrincipal('draft/frozen.md', 'view', 'Ada', 6), access: 'read',
    });
    sweepReviewerConnections();
    await sweepMemberConnections();
    expect(memberWs.closed).toBe(null);
    expect(rev.closed).toBe(null);

    querySync("UPDATE organizations SET status = 'suspended' WHERE id = 9");
    try {
      sweepReviewerConnections();
      await sweepMemberConnections();
      expect(memberWs.closed).toEqual({ code: 4006, reason: 'Organization access revoked' });
      expect(rev.closed).toEqual({ code: 4006, reason: 'Organization suspended' });

      // A reviewer landing DURING suspension is closed by the registration
      // TOCTOU re-check before any doc bytes.
      const late = connect(room, {
        principal: mintPrincipal('draft/frozen.md', 'view', 'Late', 6), access: 'read',
      });
      expect(late.closed).toEqual({ code: 4006, reason: 'Organization suspended' });
      expect(late.sent).toEqual([]);
    } finally {
      querySync("UPDATE organizations SET status = 'active' WHERE id = 9");
    }
  });

  it('a disconnected socket is deregistered — the sweep does not close it retroactively', async () => {
    const ws = connect('project-999/draft/gone-project.md', memberCollab(3));
    ws.disconnect(); // close handler deregisters before the sweep runs
    await sweepMemberConnections();
    expect(ws.closed).toBe(null);
  });

  it('dev mode never closes member sockets, even identities with no membership', async () => {
    config.auth.mode = 'dev';
    try {
      const ws = connect('project-999/draft/dev.md', memberCollab(4242));
      await sweepMemberConnections();
      expect(ws.closed).toBe(null);
      ws.disconnect();
    } finally {
      config.auth.mode = 'magic-link';
    }
  });
});
