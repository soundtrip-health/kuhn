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

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
// Kuhn extension (story 041): sent once per connection, payload 1 if this
// client is the room's designated seeder — i.e. it is the first connection
// into a room with no content, so it (and only it) should apply the storage
// template. Kills the race where two clients both observe an empty room and
// both seed it. y-websocket reserves 0-3; 64 leaves headroom for upstream.
const MSG_SEED_GRANT = 64;

/** The room's file was removed (story 038). Clients stop reconnecting. */
export const CLOSE_ROOM_EVICTED = 4001;
/**
 * The room's file was moved (story 012-002). Clients stop reconnecting and
 * re-open at the new path, which the close reason carries when it fits —
 * mirrored in webapp/src/editor.ts.
 */
export const CLOSE_ROOM_MOVED = 4002;

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

  const entry = getOrCreateDoc(roomName);
  entry.conns.add(ws);

  // Seed grant (story 041): decided server-side, where connection order is
  // sequential and unambiguous. `share.size === 0` means no update has ever
  // been applied to this doc — a brand-new (or freshly evicted) room.
  {
    const granted = entry.conns.size === 1 && entry.doc.share.size === 0;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SEED_GRANT);
    encoding.writeVarUint(encoder, granted ? 1 : 0);
    ws.send(encoding.toUint8Array(encoder));
  }

  ws.on('message', (raw) => {
    const data = new Uint8Array(raw);
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MSG_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, entry.doc, ws);
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
        break;
      }
      case MSG_AWARENESS: {
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(entry.awareness, update, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    entry.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(entry.awareness, [ws._awarenessClientId ?? -1], null);
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

  // Send current document state and awareness
  sendSync(ws, entry.doc);
  sendAwareness(ws, entry.awareness);
}
