/**
 * y-websocket document sync server.
 *
 * Implements the Yjs binary sync + awareness protocol so that
 * y-websocket WebsocketProvider clients can connect and collaborate.
 *
 * Documents are held in memory. Persistence (DB or filesystem) can be
 * added later by listening to doc updates.
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { reviewerLinkState } from './collab-auth.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
// Kuhn extension (story 041): sent once per connection, payload 1 if this
// client is the room's designated seeder — i.e. it is the first connection
// into a room with no content, so it (and only it) should apply the storage
// template. Kills the race where two clients both observe an empty room and
// both seed it. y-websocket reserves 0-3; 64 leaves headroom for upstream.
const MSG_SEED_GRANT = 64;
/**
 * Kuhn extension (epic 013): server-attributed external presence. Broadcast to
 * every connection in a room on any reviewer join/leave (and sent once to each
 * new connection when reviewers are present), payload a varString JSON
 * `{"reviewers":[{"linkId":3,"name":"Jane","mode":"comment"}]}`. This — not
 * the awareness `user` field, which is client-claimed and forgeable — is the
 * trust-bearing "an outsider is on this document" signal members render.
 */
export const MSG_REVIEWERS = 65;

/** The room's file was removed (story 038). Clients stop reconnecting. */
export const CLOSE_ROOM_EVICTED = 4001;
/**
 * The room's file was moved (story 012-002). Clients stop reconnecting and
 * re-open at the new path, which the close reason carries when it fits —
 * mirrored in webapp/src/editor.ts.
 */
export const CLOSE_ROOM_MOVED = 4002;
/** Epic 013: the reviewer's link was revoked. Clients stop reconnecting. */
export const CLOSE_LINK_REVOKED = 4003;
/** Epic 013: the reviewer's link has expired. Clients stop reconnecting. */
export const CLOSE_LINK_EXPIRED = 4004;
/**
 * Epic 013: the document changed in storage under a reviewer-only room (e.g.
 * an accepted agent edit landed). RECONNECTABLE — the reviewer client should
 * reconnect at the same room, which re-seeds fresh from storage, so the
 * reviewer sees the update instead of silently diverging (and a stale room can
 * never clobber the accepted edit).
 */
export const CLOSE_DOC_REFRESH = 4005;

// A WebSocket close frame caps the reason at 123 UTF-8 BYTES and ws.close()
// throws RangeError past it. Project paths can be long and non-ASCII, so
// measure bytes, not characters, and drop the reason rather than let one
// oversized path abort the eviction loop for every other connection. The
// reason is a hint only: the SSE 'moved' event is the authoritative carrier
// of the new path (story 012-002).
const MAX_CLOSE_REASON_BYTES = 123;

function safeReason(reason) {
  if (typeof reason !== 'string' || reason === '') return '';
  return Buffer.byteLength(reason, 'utf8') > MAX_CLOSE_REASON_BYTES ? '' : reason;
}

/**
 * @typedef {Object} DocEntry
 * @property {Y.Doc} doc
 * @property {awarenessProtocol.Awareness} awareness
 * @property {Set<import('ws').WebSocket>} conns
 */

/** @type {Map<string, DocEntry>} */
const docs = new Map();

// --- Move tombstones (story 012-004) ----------------------------------------
// getOrCreateDoc recreates any room name on demand, so a client that ignores
// close code 4002 (any pre-012 tab: y-websocket reconnects on every close
// unless disconnect() is called) would rejoin the old name and silently edit a
// ghost. A tombstone remembers, for a grace window, that a room-name PREFIX
// was moved, and bounces joins with 4002 + the room's own new path — the same
// verdict the eviction gave, so the compliant path is identical either way.
//
// Prefix-based (not per-room) because a folder move re-keys descendants that
// may have no live room to enumerate at eviction time. In-memory on purpose:
// a restart drops every room anyway, so there is no stale client state a
// persisted tombstone would protect against (see story 038).
//
// The TTL is memory hygiene, not the correctness boundary — a path made
// legitimately live again is cleared immediately (a move back via
// plantMoveTombstone, any other file event via clearMoveTombstonesUnder).
const TOMBSTONE_TTL_MS = 5 * 60_000;

/** @type {Map<string, { to: string, expires: number }>} — old room-name prefix → workspace-relative destination */
const moveTombstones = new Map();

/**
 * Drop every tombstone at or under `prefix` (same `+ '/'` predicate as
 * evictRoomsUnder). Called when the path is live again: a file event at it,
 * or a move whose destination lands on it.
 */
export function clearMoveTombstonesUnder(prefix) {
  for (const key of [...moveTombstones.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}/`)) moveTombstones.delete(key);
  }
}

/**
 * Remember that the room-name prefix `oldPrefix` (e.g. `project-7/draft`)
 * moved to the workspace-relative path `to` (e.g. `archive/draft`). Joins at
 * or under the prefix are bounced with 4002 + their own new path until the
 * tombstone expires or the old path becomes live again.
 *
 * A chain of moves within the window (a→b, b→c) resolves by hopping: the
 * client bounced from a re-opens at b and is bounced again to c.
 */
export function plantMoveTombstone(oldPrefix, to, ttlMs = TOMBSTONE_TTL_MS) {
  moveTombstones.set(oldPrefix, { to, expires: Date.now() + ttlMs });
  // The destination is live by definition — a move back inside the window
  // must not leave the returned-to name refusing joins.
  const projectPart = oldPrefix.slice(0, oldPrefix.indexOf('/') + 1);
  clearMoveTombstonesUnder(projectPart + to);
}

/**
 * The workspace-relative redirect for a room name covered by a live
 * tombstone, or null. Expired tombstones are reaped as they are met.
 */
function matchMoveTombstone(roomName) {
  const now = Date.now();
  for (const [prefix, t] of moveTombstones) {
    if (t.expires <= now) {
      moveTombstones.delete(prefix);
      continue;
    }
    if (roomName === prefix) return t.to;
    if (roomName.startsWith(`${prefix}/`)) return t.to + roomName.slice(prefix.length);
  }
  return null;
}

function getOrCreateDoc(name) {
  if (docs.has(name)) return docs.get(name);

  const doc = new Y.Doc({ gc: true });
  const awareness = new awarenessProtocol.Awareness(doc);

  awareness.on('update', (/** @type {{ added: number[], updated: number[], removed: number[] }} */ changes, origin) => {
    const changedClients = changes.added.concat(changes.updated, changes.removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients));
    const message = encoding.toUint8Array(encoder);

    const entry = docs.get(name);
    if (entry) {
      for (const ws of entry.conns) {
        if (ws !== origin && ws.readyState === 1) {
          ws.send(message);
        }
      }
    }
  });

  // Broadcast document updates to every other connection in the room.
  // readSyncMessage passes the sender's ws as the transaction origin, so the
  // sender is skipped (it already has the change).
  doc.on('update', (update, origin) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);

    const entry = docs.get(name);
    if (entry) {
      for (const ws of entry.conns) {
        if (ws !== origin && ws.readyState === 1) {
          ws.send(message);
        }
      }
    }
  });

  const entry = { doc, awareness, conns: new Set() };
  docs.set(name, entry);
  return entry;
}

/**
 * Evict a room so the next client to open it seeds fresh from storage
 * (story 038). Rooms outlive their file: after the last client disconnects
 * the empty room lingers for 30s (grace period below), and a file deleted
 * and re-uploaded inside that window would reconnect to the stale state —
 * which then wins over the new bytes and can even be autosaved back over
 * them. With `closeConnections` (the file was deleted) live sockets are
 * closed with 4001; without it the room is dropped only when idle, so live
 * collaborators are never kicked by a mere overwrite — their open editor
 * reconciles through the file_change feed instead.
 *
 * A move (story 012-002) is the same eviction with a different verdict for
 * the client: `closeCode` 4002 plus the new path as `closeReason` tells it
 * to re-open there rather than treat the document as gone.
 * @returns {boolean} whether a room was evicted
 */
export function evictRoom(
  name,
  { closeConnections = false, closeCode = CLOSE_ROOM_EVICTED, closeReason = 'Document removed' } = {},
) {
  const entry = docs.get(name);
  if (!entry) return false;
  if (entry.conns.size > 0 && !closeConnections) return false;
  const reason = safeReason(closeReason);
  for (const ws of entry.conns) {
    try {
      ws.close(closeCode, reason);
    } catch {
      // a dying socket must not block eviction
    }
  }
  entry.conns.clear();
  docs.delete(name); // out of the map before destroy so no update rebroadcasts
  entry.doc.destroy();
  return true;
}

/**
 * Evict a room subtree: the room named `prefix` itself plus every room under
 * `prefix + '/'` (story 012-002 — a folder move re-keys every descendant, and
 * a room named for a path that no longer exists must not survive).
 *
 * The `+ '/'` is load-bearing: a bare startsWith would also match
 * 'project-7/directive.md' when evicting 'project-7/dir'. Same predicate as
 * the SQL prefix idiom in db/file-activity.js.
 *
 * `closeReason` may be a function of the room name. It has to be for a folder
 * move: every descendant room needs its OWN new path in the close frame, not
 * the folder's. Passing the folder's destination to all of them would tell the
 * client holding `project-7/dir/a.md` that its document is now the directory
 * `archive/dir`, and it would follow that to a path that is not a file.
 * @returns {number} how many rooms were evicted
 */
export function evictRoomsUnder(prefix, opts = {}) {
  let evicted = 0;
  const { closeReason } = opts;
  // Snapshot the keys: evictRoom mutates `docs` as we go.
  for (const name of [...docs.keys()]) {
    if (name !== prefix && !name.startsWith(`${prefix}/`)) continue;
    const perRoom = typeof closeReason === 'function'
      ? { ...opts, closeReason: closeReason(name) }
      : opts;
    if (evictRoom(name, perRoom)) evicted += 1;
  }
  return evicted;
}

/** Test hook: does a room currently exist in memory? */
export function hasRoom(name) {
  return docs.has(name);
}

// --- Reviewer connections (epic 013) ----------------------------------------
// Every socket carries ws.kuhnAccess ('read'|'write') and ws.kuhnPrincipal
// (stamped from req.kuhnCollab by the upgrade handler in collab-auth.js).
// Reviewer sockets are additionally indexed by link id so a revocation can
// close exactly that credential's connections — room-level evictRoom must NOT
// be used for revocation: it would kick org members and destroy doc state.

/** @type {Map<number, Set<import('ws').WebSocket>>} linkId → live sockets */
const reviewerConns = new Map();

const REVIEWER_SWEEP_MS = 60_000;
let reviewerSweepTimer = null;

function ensureReviewerSweep() {
  if (reviewerSweepTimer) return;
  reviewerSweepTimer = setInterval(sweepReviewerConnections, REVIEWER_SWEEP_MS);
  reviewerSweepTimer.unref?.();
}

/** Close one reviewer socket with the verdict for a non-live link state. */
function closeForLinkState(ws, state) {
  const [code, reason] = state === 'expired'
    ? [CLOSE_LINK_EXPIRED, 'Link expired']
    : [CLOSE_LINK_REVOKED, state === 'missing' ? 'Document removed' : 'Link revoked'];
  try {
    ws.close(code, reason);
  } catch {
    // a dying socket must not block the sweep/re-check
  }
}

/**
 * Close every live socket held by one review link (revocation, delete).
 * Only that credential's sockets — members and other reviewers in the same
 * room are untouched and the in-memory doc survives.
 * @returns {number} sockets closed
 */
export function closeReviewerConnections(linkId, { code = CLOSE_LINK_REVOKED, reason = 'Link revoked' } = {}) {
  const set = reviewerConns.get(linkId);
  if (!set) return 0;
  let closed = 0;
  for (const ws of [...set]) {
    try {
      ws.close(code, safeReason(reason));
      closed += 1;
    } catch {
      // keep closing the rest
    }
  }
  return closed;
}

/**
 * A real file change landed at this room's path (epic 013, brief decision 3).
 * If the room's ONLY connections are reviewers, close them with the
 * reconnectable CLOSE_DOC_REFRESH and drop the room, so reconnect re-seeds
 * fresh from storage — no silent divergence, and no stale reviewer room left
 * to clobber the accepted edit. Rooms with at least one member connection are
 * left alone (members reconcile through their SSE feed, story 038 semantics).
 * Called by project-events.js's non-delete file_change branch (U5).
 * @returns {boolean} whether the room was reviewer-only and was closed
 */
export function closeReviewerOnlyRoom(name, { code = CLOSE_DOC_REFRESH, reason = 'Document updated' } = {}) {
  const entry = docs.get(name);
  if (!entry || entry.conns.size === 0) return false;
  for (const ws of entry.conns) {
    if (ws.kuhnPrincipal?.kind !== 'reviewer') return false;
  }
  return evictRoom(name, { closeConnections: true, closeCode: code, closeReason: reason });
}

/**
 * 60s sweep over registered reviewer sockets. Re-validates each link IN THE
 * DATABASE — revocation and existence, not just the upgrade-time expiry stamp
 * — so any socket that slipped a race (revoke between upgrade check and
 * registration re-check) survives at most one sweep interval, not 90 days.
 */
export function sweepReviewerConnections() {
  for (const [linkId, set] of [...reviewerConns]) {
    if (set.size === 0) {
      reviewerConns.delete(linkId);
      continue;
    }
    const state = reviewerLinkState(linkId);
    if (state === 'live') continue;
    for (const ws of [...set]) closeForLinkState(ws, state);
  }
}

/** Deduped {linkId, name, mode} roster of reviewer connections in a room. */
function reviewerRoster(entry) {
  const seen = new Map();
  for (const ws of entry.conns) {
    const p = ws.kuhnPrincipal;
    if (p?.kind === 'reviewer' && !seen.has(p.linkId)) {
      seen.set(p.linkId, { linkId: p.linkId, name: p.name, mode: p.mode });
    }
  }
  return [...seen.values()];
}

function encodeReviewers(roster) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_REVIEWERS);
  encoding.writeVarString(encoder, JSON.stringify({ reviewers: roster }));
  return encoding.toUint8Array(encoder);
}

function broadcastReviewers(name) {
  const entry = docs.get(name);
  if (!entry) return;
  const message = encodeReviewers(reviewerRoster(entry));
  for (const ws of entry.conns) {
    if (ws.readyState === 1) ws.send(message);
  }
}

/**
 * Rewrite a reviewer's awareness update so its `user` field is the
 * server-attributed identity (epic 013): a reviewer must not be able to render
 * a cursor labeled as a member. The client's claimed cursor color is kept
 * (cosmetic); name and the external flag are forced. Wire format mirrors
 * y-protocols/awareness encodeAwarenessUpdate exactly: varUint count, then per
 * client varUint id, varUint clock, varString JSON state ('null' = leave).
 */
function stampAwarenessUser(update, name) {
  try {
    const dec = decoding.createDecoder(update);
    const enc = encoding.createEncoder();
    const count = decoding.readVarUint(dec);
    encoding.writeVarUint(enc, count);
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const stateJson = decoding.readVarString(dec);
      encoding.writeVarUint(enc, clientId);
      encoding.writeVarUint(enc, clock);
      let state = null;
      try {
        state = JSON.parse(stateJson);
      } catch {
        // fall through: pass the entry unmodified
      }
      if (state !== null && typeof state === 'object') {
        const claimed = state.user !== null && typeof state.user === 'object' ? state.user : {};
        state.user = {
          ...(typeof claimed.color === 'string' ? { color: claimed.color } : {}),
          name,
          external: true,
        };
        encoding.writeVarString(enc, JSON.stringify(state));
      } else {
        encoding.writeVarString(enc, stateJson);
      }
    }
    return encoding.toUint8Array(enc);
  } catch {
    // Malformed update: same format applyAwarenessUpdate parses, so it will
    // reject it there too — returning as-is cannot smuggle a stamped-over name.
    return update;
  }
}

/**
 * Drop awareness entries whose client id belongs to another live socket in the
 * room (epic 013). applyAwarenessUpdate accepts any clientID with a higher
 * clock, and the sender chooses the ids in the frame — without this, a
 * reviewer who saw a member's id in the roster could overwrite that member's
 * presence (and get it deleted on the reviewer's own disconnect, via the
 * tracked-ids close cleanup). Ids the socket already introduced, or that no
 * other connection owns, pass through.
 */
function filterForeignAwarenessClients(ws, entry, update) {
  try {
    const dec = decoding.createDecoder(update);
    const count = decoding.readVarUint(dec);
    const kept = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const stateJson = decoding.readVarString(dec);
      let foreign = false;
      if (!ws._awarenessClientIds?.has(clientId)) {
        for (const conn of entry.conns) {
          if (conn !== ws && conn._awarenessClientIds?.has(clientId)) {
            foreign = true;
            break;
          }
        }
      }
      if (!foreign) kept.push([clientId, clock, stateJson]);
    }
    if (kept.length === count) return update;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, kept.length);
    for (const [clientId, clock, stateJson] of kept) {
      encoding.writeVarUint(enc, clientId);
      encoding.writeVarUint(enc, clock);
      encoding.writeVarString(enc, stateJson);
    }
    return encoding.toUint8Array(enc);
  } catch {
    // Malformed update: applyAwarenessUpdate will reject it downstream.
    return update;
  }
}

/**
 * Track which awareness client ids a socket has introduced, so disconnect can
 * remove exactly those states. (Replaces the pre-013 `_awarenessClientId`
 * cleanup, which was dead code — nothing ever set it.)
 */
function trackAwarenessClients(ws, update) {
  try {
    const dec = decoding.createDecoder(update);
    const count = decoding.readVarUint(dec);
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(dec);
      decoding.readVarUint(dec); // clock
      const stateJson = decoding.readVarString(dec);
      if (!ws._awarenessClientIds) ws._awarenessClientIds = new Set();
      if (stateJson === 'null') ws._awarenessClientIds.delete(clientId);
      else ws._awarenessClientIds.add(clientId);
    }
  } catch {
    // malformed update: nothing to track
  }
}

function sendSync(ws, doc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  ws.send(encoding.toUint8Array(encoder));
}

function sendAwareness(ws, awareness) {
  const clients = Array.from(awareness.getStates().keys());
  if (clients.length === 0) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  ws.send(encoding.toUint8Array(encoder));
}

export function handleYjsConnection(ws, req) {
  // Room name is the path after /yjs-websocket/
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomName = decodeURIComponent(url.pathname.replace(/^\/yjs-websocket\//, ''));

  if (!roomName) {
    ws.close(4000, 'Missing room name');
    return;
  }

  // Story 012-004: a moved room name is not recreated on demand — the join is
  // refused with the same 4002 + new-path verdict the eviction gave, so a
  // non-compliant reconnect cannot resurrect the old room and edit a ghost.
  const redirect = matchMoveTombstone(roomName);
  if (redirect !== null) {
    ws.close(CLOSE_ROOM_MOVED, safeReason(redirect));
    return;
  }

  // Epic 013: the upgrade handler (collab-auth.js) stamps req.kuhnCollab with
  // the resolved principal and access level. The default preserves member/dev
  // behavior when the handler is driven without the upgrade path (tests).
  const collab = req.kuhnCollab ?? { principal: null, access: 'write' };
  ws.kuhnAccess = collab.access === 'read' ? 'read' : 'write';
  ws.kuhnPrincipal = collab.principal ?? null;
  const reviewer = ws.kuhnPrincipal?.kind === 'reviewer' ? ws.kuhnPrincipal : null;

  const entry = getOrCreateDoc(roomName);
  entry.conns.add(ws);

  if (reviewer) {
    let set = reviewerConns.get(reviewer.linkId);
    if (!set) {
      set = new Set();
      reviewerConns.set(reviewer.linkId, set);
    }
    set.add(ws);
    ensureReviewerSweep();
  }

  ws.on('message', (raw) => {
    // Everything below decodes client-controlled bytes, and lib0/y-protocols
    // throw on truncated or garbage input. A throw escaping a ws 'message'
    // listener is an uncaughtException — process exit. Epic 013 moves this
    // surface across the trust boundary (any holder of a view-mode link), so
    // a malformed frame must cost the sender their connection, not the
    // service (close 1002 = protocol error).
    try {
    const data = new Uint8Array(raw);
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MSG_SYNC: {
        if (ws.kuhnAccess === 'read') {
          // Sync sub-types: 0 = SyncStep1 (pure read; the server answers with
          // step2), 1 = SyncStep2 and 2 = Update (both APPLY the client's
          // bytes to the doc). A read-only socket's writes are silently
          // dropped — the epic's message-level guarantee (013-002); 010-003
          // inherits this by passing access 'read' for viewer members later.
          const sub = decoding.peekVarUint(decoder);
          if (sub !== syncProtocol.messageYjsSyncStep1) break;
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, entry.doc, ws);
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
        break;
      }
      case MSG_AWARENESS: {
        let update = decoding.readVarUint8Array(decoder);
        if (reviewer) {
          // A reviewer may only speak for awareness client ids it introduced:
          // an update naming another socket's id would let it repaint (or, via
          // the close-handler cleanup, delete) a member's presence.
          update = filterForeignAwarenessClients(ws, entry, update);
          // Server-attributed identity: a reviewer's cursor label cannot
          // impersonate a member (epic 013).
          update = stampAwarenessUser(update, reviewer.name ?? 'Reviewer');
        }
        trackAwarenessClients(ws, update);
        awarenessProtocol.applyAwarenessUpdate(entry.awareness, update, ws);
        break;
      }
    }
    } catch (err) {
      console.error(`yjs-websocket: malformed frame in room ${roomName}:`, err?.message ?? err);
      ws.close(1002, 'Malformed message');
    }
  });

  ws.on('close', () => {
    entry.conns.delete(ws);
    if (reviewer) {
      const set = reviewerConns.get(reviewer.linkId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) reviewerConns.delete(reviewer.linkId);
      }
      broadcastReviewers(roomName);
    }
    const awarenessIds = ws._awarenessClientIds ? [...ws._awarenessClientIds] : [];
    if (awarenessIds.length > 0) {
      awarenessProtocol.removeAwarenessStates(entry.awareness, awarenessIds, null);
    }
    // Clean up empty docs after a delay
    if (entry.conns.size === 0) {
      setTimeout(() => {
        const current = docs.get(roomName);
        if (current && current.conns.size === 0) {
          current.doc.destroy();
          docs.delete(roomName);
        }
      }, 30000);
    }
  });

  // TOCTOU guard (epic 013): the upgrade check read link state before this
  // socket existed; a revoke landing in that async window would otherwise ride
  // until the sweep. Re-check once now that the connection is fully registered
  // (so close → complete cleanup), before any doc bytes are exchanged.
  if (reviewer) {
    const state = reviewerLinkState(reviewer.linkId);
    if (state !== 'live') {
      closeForLinkState(ws, state);
      return;
    }
  }

  // Seed grant (story 041; tightened in epic 013): only the FIRST write-
  // capable connection into an empty doc seeds. Read-only connections always
  // receive 0 — a "seed" originating from a read-only socket would otherwise
  // become room truth that a member later autosaves (content injection).
  // Member-only rooms (all-write) behave exactly as before.
  {
    const writeConns = [...entry.conns].filter((c) => c.kuhnAccess !== 'read');
    const granted = entry.doc.share.size === 0
      && ws.kuhnAccess === 'write'
      && writeConns.length === 1
      && writeConns[0] === ws;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SEED_GRANT);
    encoding.writeVarUint(encoder, granted ? 1 : 0);
    ws.send(encoding.toUint8Array(encoder));
  }

  // Send current document state and awareness
  sendSync(ws, entry.doc);
  sendAwareness(ws, entry.awareness);

  // Server-attributed external presence (epic 013): reviewers joining are
  // announced to the whole room; anyone joining a room that already has
  // reviewers is told about them.
  if (reviewer) {
    broadcastReviewers(roomName);
  } else {
    const roster = reviewerRoster(entry);
    if (roster.length > 0 && ws.readyState === 1) ws.send(encodeReviewers(roster));
  }
}
