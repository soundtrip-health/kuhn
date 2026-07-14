// Story 007-003: authorization for the collaboration WebSockets.
//
// Closes the Epic 002/004 hole: /yjs-websocket/<room> and /yjs-signaling
// accepted anyone who could reach the port. Chosen mechanism (the story's
// open decision): the Story 002 **session cookie, read at upgrade time** —
// browsers attach cookies to same-site WS handshakes automatically, so the
// webapp's WebsocketProvider needs no token plumbing and reconnect-after-
// reload keeps working for free. No minted room tokens.
//
// Enforcement points:
//   - Doc sync: the HTTP upgrade itself (createUpgradeHandler) — an
//     unauthorized socket is refused before any doc bytes flow.
//   - Signaling: the upgrade authenticates the user; each subscribe/publish
//     topic is then membership-checked per message (topics are room names).
//
// Dev mode (KUHN_AUTH_MODE=dev) keeps today's frictionless behavior — no
// cookie, no membership check — so editor-check/parity-check run unchanged.

import { config } from './config.js';
import { getSessionUser } from './db/auth.js';
import { isMember } from './db/orgs.js';
import { getProject } from './db/projects.js';
import { readSessionCookie, resolveUser } from './session.js';

const ROOM_RE = /^project-(\d+)\/(.+)$/;

/**
 * Parse and validate a collab room name (`project-<id>/<path>`).
 * The path must look like a sane project-relative file path — no traversal,
 * no absolute paths, no empty segments — so a crafted room name cannot
 * confuse the authorization check.
 * @returns {{ projectId: number, path: string } | null}
 */
export function parseRoomName(room) {
  if (typeof room !== 'string') return null;
  const match = ROOM_RE.exec(room);
  if (!match) return null;
  const path = match[2];
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (path.includes('\\') || path.includes('\0')) return null;
  return { projectId: parseInt(match[1]), path };
}

/**
 * Resolve the user behind a WS upgrade request. Dev mode mirrors the REST
 * session middleware (header or seeded dev user); real mode accepts only the
 * signed session cookie.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{id: number, email: string}|null>}
 */
export async function wsUser(req) {
  if (config.auth.mode === 'dev') {
    return resolveUser(req.headers['x-kuhn-user']);
  }
  return getSessionUser(readSessionCookie(req.headers.cookie));
}

/**
 * May this user join this room? Membership in the project's org is the rule
 * (same as every REST route). Dev mode: always yes (current behavior).
 * @returns {Promise<boolean>}
 */
export async function canJoinRoom(user, room) {
  if (config.auth.mode === 'dev') return true;
  if (!user) return false;
  const parsed = parseRoomName(room);
  if (!parsed) return false;
  const project = await getProject(parsed.projectId);
  if (!project) return false;
  return isMember(user.id, project.org_id);
}

/** Refuse a WS upgrade before completing the handshake. */
function refuse(socket, status = 401, reason = 'Unauthorized') {
  // The socket is still raw HTTP at upgrade time; answer plainly, then close.
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Build the server 'upgrade' listener: route + authenticate + authorize,
 * then hand off to the right WebSocketServer. Kept here (not index.js) so
 * the whole gate is integration-testable against a scratch http server.
 * @param {{ signalingWss: import('ws').WebSocketServer, yjsWss: import('ws').WebSocketServer }} servers
 */
export function createUpgradeHandler({ signalingWss, yjsWss }) {
  return async (req, socket, head) => {
    try {
      const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
      const isSignaling = pathname === '/yjs-signaling';
      const isDocSync = pathname.startsWith('/yjs-websocket/');
      if (!isSignaling && !isDocSync) {
        socket.destroy();
        return;
      }

      const user = await wsUser(req);
      if (!user) {
        refuse(socket);
        return;
      }

      if (isDocSync) {
        const room = decodeURIComponent(pathname.replace(/^\/yjs-websocket\//, ''));
        if (!(await canJoinRoom(user, room))) {
          refuse(socket, 403, 'Forbidden');
          return;
        }
        yjsWss.handleUpgrade(req, socket, head, (ws) => yjsWss.emit('connection', ws, req));
        return;
      }

      // Signaling: authenticated here; topics are authorized per message.
      req.kuhnUser = user;
      signalingWss.handleUpgrade(req, socket, head, (ws) => signalingWss.emit('connection', ws, req));
    } catch (err) {
      console.error('[collab] Upgrade failed:', err);
      socket.destroy();
    }
  };
}
