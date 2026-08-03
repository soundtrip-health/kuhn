/**
 * Story 012-002, acceptance criterion 3 — the only test that drives REAL
 * websockets through a move.
 *
 * Two clients with the doc open during a move must both land in the new room
 * with identical content and no duplicate-doc merge. The duplicate-doc hazard
 * (docs/data-pipeline.md) is lineage, not bytes: a Y.Doc that carries the old
 * room's insertions into the new room merges them alongside the new seeder's
 * insertions, producing exact 2x text that autosave then persists. So the
 * contract every client must honour is: a room join gets a BRAND-NEW Y.Doc.
 * The negative-control case below proves that assertion can actually fail.
 *
 * Harness: a scratch http server whose upgrade handler goes straight to
 * handleYjsConnection. collab-auth.js's createUpgradeHandler (the real wiring,
 * covered by collab-auth.test.js) is deliberately bypassed — this suite is
 * about room lifecycle, not membership. The clients hand-roll the Yjs sync
 * protocol against local Y.Docs rather than pulling y-websocket in as a
 * backend devDependency; the backend already ships yjs/y-protocols/lib0/ws.
 * The webapp binds an XmlFragment through Milkdown's collab plugin, but for
 * lineage and duplication a Y.Text is the same thing and reads far better.
 *
 * Only the DB and history seams are mocked — the room lifecycle, the close
 * codes and the eviction prefixes are the real implementations.
 */

import { createServer } from 'node:http';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

// applyMove echoes back the canonical paths the hub then publishes/evicts on;
// its own transaction is covered in db/move-paths.test.js.
vi.mock('./db/move-paths.js', () => ({ applyMove: vi.fn((_projectId, from, to) => ({ from, to })) }));
vi.mock('./db/file-activity.js', () => ({ recordFileEvent: vi.fn(), migrateSeenPaths: vi.fn() }));
vi.mock('./history.js', () => ({ scheduleCommit: vi.fn(), commitNow: vi.fn() }));

import { handleYjsConnection, hasRoom, plantMoveTombstone } from './yjs-websocket.js';
import { publishProjectEvent } from './project-events.js';

const MSG_SYNC = 0;
const MSG_SEED_GRANT = 64;
/** Transaction origin for anything that arrived over the wire — never echoed back. */
const REMOTE = 'remote';
const TEXT_NAME = 'content';

let server;
let port;
/** Every client opened by a test, so afterEach can hang up on all of them. */
let clients = [];

beforeAll(async () => {
  const yjsWss = new WebSocketServer({ noServer: true });
  yjsWss.on('connection', handleYjsConnection);
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    yjsWss.handleUpgrade(req, socket, head, (ws) => yjsWss.emit('connection', ws, req));
  });
  await new Promise((ok) => { server = server.listen(0, ok); });
  port = server.address().port;
});

afterEach(async () => {
  const open = clients.filter((c) => c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING);
  await Promise.all(open.map((c) => new Promise((ok) => { c.ws.once('close', ok); c.ws.close(); })));
  clients = [];
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
});

/**
 * Join a room the way the webapp does: a fresh Y.Doc per join unless a test
 * deliberately smuggles in a stale one. Resolves `ready` when the seed grant
 * — always the server's first message — has arrived.
 */
function join(room, doc = new Y.Doc()) {
  const client = { room, doc, grant: null, closed: null };
  let markReady;
  client.ready = new Promise((ok) => { markReady = ok; });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/yjs-websocket/${room}`);
  client.ws = ws;
  clients.push(client);

  const send = (bytes) => { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); };

  doc.on('update', (update, origin) => {
    if (origin === REMOTE) return; // already came from the room
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  });

  ws.on('open', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(encoding.toUint8Array(encoder));
  });

  ws.on('message', (raw) => {
    const decoder = decoding.createDecoder(new Uint8Array(raw));
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SEED_GRANT) {
      client.grant = decoding.readVarUint(decoder) === 1;
      markReady();
      return;
    }
    if (type !== MSG_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
    if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
  });

  ws.on('close', (code, reason) => {
    client.closed = { code, reason: reason.toString() };
    markReady(); // a refused join must not hang the test
  });

  return client;
}

const text = (client) => client.doc.getText(TEXT_NAME).toString();
const type = (client, s) => client.doc.getText(TEXT_NAME).insert(text(client).length, s);

/** Apply the storage bytes. Story 041: exactly one client per room may do this. */
function seedFromStorage(clients_, content) {
  const granted = clients_.filter((c) => c.grant);
  expect(granted.map((c) => c.room)).toHaveLength(1);
  granted[0].doc.getText(TEXT_NAME).insert(0, content);
  return granted[0];
}

/** Poll a predicate — the only waiting in this file, and always on real state. */
async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((ok) => { setTimeout(ok, 5); });
  }
}

/**
 * Round-trip barrier: once `to` has seen an edit made by `from`, anything the
 * server was going to deliver to `to` beforehand has already arrived. Lets the
 * cross-talk assertions below be exact instead of timed.
 */
async function roundTrip(from, to, marker) {
  type(from, marker);
  await waitFor(() => text(to).endsWith(marker), `${marker} to reach ${to.room}`);
}

const publishMove = (projectId, from, to) =>
  publishProjectEvent(projectId, { type: 'file_change', kind: 'moved', path: to, meta: { from } });

describe('collab rooms across a move (story 012-002, AC 3)', () => {
  it('closes both clients with 4002 and rejoins them, once, on the new room', async () => {
    const STORAGE = '# Methods\n\nCalibration was performed at 20 Hz.\n';
    const oldRoom = 'project-921/draft/main.md';
    const newRoom = 'project-921/archive/main.md';

    const a = join(oldRoom);
    const b = join(oldRoom);
    await Promise.all([a.ready, b.ready]);
    seedFromStorage([a, b], STORAGE);
    await waitFor(() => text(a) === STORAGE && text(b) === STORAGE, 'the old room to converge');

    publishMove(921, 'draft/main.md', 'archive/main.md');

    await waitFor(() => a.closed && b.closed, 'both clients to be evicted');
    expect(a.closed).toEqual({ code: 4002, reason: 'archive/main.md' });
    expect(b.closed).toEqual({ code: 4002, reason: 'archive/main.md' });
    expect(hasRoom(oldRoom)).toBe(false);

    // The webapp contract: re-open at the new path, which tears everything
    // down and builds a fresh Y.Doc. The storage bytes are unchanged — a move
    // is rename(2), so the new path re-reads exactly what the old one held.
    const a2 = join(newRoom);
    const b2 = join(newRoom);
    await Promise.all([a2.ready, b2.ready]);
    seedFromStorage([a2, b2], STORAGE);
    await waitFor(() => text(a2) === STORAGE && text(b2) === STORAGE, 'the new room to converge');

    // Exact equality is the whole point: a doc that carried the old room's
    // lineage in would read STORAGE twice here (see the control below).
    expect(text(a2)).toBe(STORAGE);
    expect(text(b2)).toBe(STORAGE);
    expect(text(a2)).toBe(text(b2));

    // …and the rejoined pair is genuinely one room, not two isolated tabs.
    await roundTrip(a2, b2, 'edit-from-a');
  });

  it('negative control: reusing the old Y.Doc in the new room duplicates the text', async () => {
    const STORAGE = '# Results\n\nn = 42.\n';
    const oldRoom = 'project-922/draft/main.md';
    const newRoom = 'project-922/archive/main.md';

    const a = join(oldRoom);
    await a.ready;
    seedFromStorage([a], STORAGE);
    await waitFor(() => text(a) === STORAGE, 'the old room to seed');

    publishMove(922, 'draft/main.md', 'archive/main.md');
    await waitFor(() => a.closed, 'the client to be evicted');

    // A compliant client re-opens with a fresh doc and seeds from storage.
    const fresh = join(newRoom);
    await fresh.ready;
    seedFromStorage([fresh], STORAGE);
    await waitFor(() => text(fresh) === STORAGE, 'the new room to seed');

    // A client that shortcut the rejoin — reusing its Y.Doc, or mutating
    // provider.roomname instead of rebuilding — carries the old lineage in.
    const reused = join(newRoom, a.doc);
    await reused.ready;
    expect(reused.grant).toBe(false);
    await waitFor(() => text(fresh) === STORAGE.repeat(2), 'the duplicate merge to land');
    expect(text(reused)).toBe(STORAGE.repeat(2));
    // Which is exactly what the previous test's exact-equality assertion
    // catches, and what autosave would then write to the moved file.
  });

  it('kicks a live room sitting at the destination so it re-seeds from the moved bytes', async () => {
    // A room can be live at a path with no file behind it: the editor seeds
    // DEFAULT_TEMPLATE when the read 404s (editor.ts), and main.ts falls back
    // to draft/main.md after a delete. Story 038's hazard in reverse — that
    // client must be kicked, not left to autosave a template over the move.
    const TEMPLATE = '# Untitled draft\n';
    const MOVED = '# Protocol\n\nStep 1.\n';
    const sourceRoom = 'project-923/notes/x.md';
    const destRoom = 'project-923/draft/main.md';

    const squatter = join(destRoom);
    await squatter.ready;
    seedFromStorage([squatter], TEMPLATE);
    await waitFor(() => text(squatter) === TEMPLATE, 'the template room to seed');

    const mover = join(sourceRoom);
    await mover.ready;
    seedFromStorage([mover], MOVED);
    await waitFor(() => text(mover) === MOVED, 'the source room to seed');

    publishMove(923, 'notes/x.md', 'draft/main.md');

    await waitFor(() => squatter.closed && mover.closed, 'both rooms to be evicted');
    expect(mover.closed.code).toBe(4002);
    expect(squatter.closed.code).toBe(4002); // destination is NOT evicted idle-only
    expect(hasRoom(destRoom)).toBe(false);
    expect(hasRoom(sourceRoom)).toBe(false);

    // Re-opening the destination reads the moved bytes, not the stale template.
    const rejoined = join(destRoom);
    await rejoined.ready;
    expect(rejoined.grant).toBe(true); // a brand-new room: it must seed
    seedFromStorage([rejoined], MOVED);
    await waitFor(() => text(rejoined) === MOVED, 'the destination to re-seed');
    expect(text(rejoined)).toBe(MOVED);
    expect(text(rejoined)).not.toContain('Untitled draft');
  });

  it('a folder move evicts every descendant room and leaves a prefix look-alike alone', async () => {
    const child = 'project-924/dir/a.md';
    const grandchild = 'project-924/dir/sub/b.md';
    const lookAlike = 'project-924/directive.md';

    const first = join(child);
    const second = join(grandchild);
    // Two clients on the decoy, so we can prove it stays a working room and
    // not merely an unclosed socket.
    const decoyA = join(lookAlike);
    const decoyB = join(lookAlike);
    await Promise.all([first.ready, second.ready, decoyA.ready, decoyB.ready]);
    seedFromStorage([decoyA, decoyB], '# Directive\n');
    await waitFor(() => text(decoyB) === '# Directive\n', 'the decoy room to converge');

    publishMove(924, 'dir', 'archive/dir');

    await waitFor(() => first.closed && second.closed, 'the descendant rooms to be evicted');
    // Each descendant is told ITS own new path, not the folder's. Telling
    // `dir/a.md` it moved to `archive/dir` would send the client after a
    // directory, which does not read back as a file.
    expect(first.closed).toEqual({ code: 4002, reason: 'archive/dir/a.md' });
    expect(second.closed).toEqual({ code: 4002, reason: 'archive/dir/sub/b.md' });
    expect(hasRoom(child)).toBe(false);
    expect(hasRoom(grandchild)).toBe(false);

    // 'directive.md' starts with 'dir' but is not under it — the '/' in the
    // eviction prefix is what keeps it alive, and it must still relay edits.
    expect(decoyA.closed).toBe(null);
    expect(decoyB.closed).toBe(null);
    expect(hasRoom(lookAlike)).toBe(true);
    await roundTrip(decoyA, decoyB, ' — still live');
  });

  it('a client that ignores 4002 is bounced by the tombstone, never given a live room (story 012-004)', async () => {
    // Formerly the KNOWN GAP characterisation: getOrCreateDoc recreates any
    // name on demand, so a tab that ignores 4002 (any pre-012 tab —
    // y-websocket reconnects on every close unless disconnect() is called)
    // used to come straight back into the old name and edit a ghost. The
    // tombstone turns that reconnect into a replay of the eviction verdict.
    const STORAGE = '# Discussion\n\nEffect size held.\n';
    const oldRoom = 'project-925/draft/main.md';
    const newRoom = 'project-925/archive/main.md';

    const a = join(oldRoom);
    const b = join(oldRoom);
    await Promise.all([a.ready, b.ready]);
    seedFromStorage([a, b], STORAGE);
    await waitFor(() => text(a) === STORAGE && text(b) === STORAGE, 'the old room to converge');

    publishMove(925, 'draft/main.md', 'archive/main.md');
    await waitFor(() => a.closed && b.closed, 'both clients to be evicted');

    // Compliant client: fresh doc, new room.
    const compliant = join(newRoom);
    await compliant.ready;
    seedFromStorage([compliant], STORAGE);
    await waitFor(() => text(compliant) === STORAGE, 'the new room to seed');

    // Non-compliant client: same doc, same room name, straight back at the
    // old name — refused with the same verdict the eviction gave, and no
    // room comes into being behind it.
    const stubborn = join(oldRoom, b.doc);
    await stubborn.ready;
    expect(stubborn.closed).toEqual({ code: 4002, reason: 'archive/main.md' });
    expect(stubborn.grant).toBe(null); // never admitted, no seed grant sent
    expect(hasRoom(oldRoom)).toBe(false);

    // The moved document never sees any of it.
    const second = join(newRoom);
    await second.ready;
    await roundTrip(compliant, second, 'live');
    expect(text(compliant)).toBe(`${STORAGE}live`);
  });

  it('bounces a descendant room that was idle at eviction time (story 012-004)', async () => {
    // A folder move can re-key paths whose rooms are not live, so eviction
    // never sees them — the prefix tombstone is what covers the difference.
    // No room exists anywhere in this test until the final join.
    publishMove(926, 'sources', 'archive/sources');

    const late = join('project-926/sources/protocol.md');
    await late.ready;
    expect(late.closed).toEqual({ code: 4002, reason: 'archive/sources/protocol.md' });
    expect(hasRoom('project-926/sources/protocol.md')).toBe(false);
  });

  it('a move back inside the window makes the returned-to name joinable again (story 012-004)', async () => {
    publishMove(927, 'draft/main.md', 'archive/main.md');
    const bounced = join('project-927/draft/main.md');
    await bounced.ready;
    expect(bounced.closed?.code).toBe(4002);

    publishMove(927, 'archive/main.md', 'draft/main.md');
    const back = join('project-927/draft/main.md');
    await back.ready;
    expect(back.closed).toBe(null);
    expect(back.grant).toBe(true); // a fresh room, seeded from storage as usual
    // …and the vacated name now bounces toward the returned document.
    const stale = join('project-927/archive/main.md');
    await stale.ready;
    expect(stale.closed).toEqual({ code: 4002, reason: 'draft/main.md' });
  });

  it('a new file created at the old name clears the tombstone (story 012-004)', async () => {
    publishMove(928, 'draft/notes.md', 'archive/notes.md');
    publishProjectEvent(928, { type: 'file_change', kind: 'create', path: 'draft/notes.md' });

    const fresh = join('project-928/draft/notes.md');
    await fresh.ready;
    expect(fresh.closed).toBe(null);
    expect(fresh.grant).toBe(true);
  });

  it('an expired tombstone stops bouncing (story 012-004)', async () => {
    publishMove(929, 'draft/old.md', 'archive/old.md');
    // Overwrite the entry the move planted with an already-short TTL — the
    // production TTL is minutes, which a real-time test cannot wait out.
    plantMoveTombstone('project-929/draft/old.md', 'archive/old.md', 1);
    await new Promise((ok) => { setTimeout(ok, 10); });

    const late = join('project-929/draft/old.md');
    await late.ready;
    expect(late.closed).toBe(null);
    expect(late.grant).toBe(true);
  });
});
