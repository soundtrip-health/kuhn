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
//
// Epic 013 (external review): a socket holding a kuhn_review_session cookie is
// authorized for exactly its link's doc room, read-only unless the link is
// edit-mode. THE REVIEWER COOKIE WINS for that room, in every auth mode —
// resolveUser() never returns null in dev (session.js defaults to the seeded
// dev user), so member-first resolution would silently upgrade every reviewer
// socket to a writable dev member (making the whole gate dead code in dev) and
// in prod would 403-loop a reviewer who happens to be signed into a different
// org. Member resolution is the fallback, not the first look.

import { config } from './config.js';
import { querySync } from './db.js';
import { getSessionUser } from './db/auth.js';
import { isMember } from './db/orgs.js';
import { getProject } from './db/projects.js';
import { reviewerPrincipal } from './review-auth.js';
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
 * Resolve the principal behind a doc-sync upgrade (epic 013). Reviewer cookie
 * wins for the room its link covers (see module doc for why member-first is
 * wrong); otherwise a member session; otherwise the mismatched reviewer
 * principal is returned so authorizeRoom refuses it with 403 (authenticated,
 * not authorized — the §2.4 matrix's "any other room" row) rather than 401.
 * @param {import('node:http').IncomingMessage|{headers?: {cookie?: string}}} req
 * @param {string|null} room the requested room name, when known
 * @returns {Promise<{kind: 'member', user: object}
 *   | {kind: 'reviewer', linkId: number, projectId: number, path: string,
 *      mode: 'view'|'comment'|'edit', name: string|null, expiresAt: string}
 *   | null>}
 */
export async function wsPrincipal(req, room = null) {
  const reviewer = reviewerPrincipal(req?.headers?.cookie ?? null);
  if (reviewer && room !== null) {
    const parsed = parseRoomName(room);
    if (parsed && parsed.projectId === reviewer.projectId && parsed.path === reviewer.path) {
      return reviewer;
    }
  }
  // Fallback: member resolution. In dev this never returns null (the seeded
  // dev user), which is exactly why the reviewer check above runs first.
  const user = await wsUser(req);
  if (user) return { kind: 'member', user };
  return reviewer;
}

/**
 * May this principal join this room, and at what access level?
 * - member: org membership (same rule as every REST route); access 'write'.
 * - reviewer: exactly the link's own doc; access 'read' unless mode 'edit'.
 * Reviewer principals are enforced in EVERY auth mode — dev's unconditional
 * allow stays member-only, or dev-mode reviewer tests would be vacuous.
 * @returns {Promise<{ok: boolean, access?: 'read'|'write'}>}
 */
export async function authorizeRoom(principal, room) {
  if (!principal) return { ok: false };
  if (principal.kind === 'reviewer') {
    const parsed = parseRoomName(room);
    const ok = parsed !== null
      && parsed.projectId === principal.projectId
      && parsed.path === principal.path;
    if (!ok) return { ok: false };
    return { ok: true, access: principal.mode === 'edit' ? 'write' : 'read' };
  }
  return (await canJoinRoom(principal.user, room)) ? { ok: true, access: 'write' } : { ok: false };
}

/**
 * Current lifecycle state of a review link, by id — for established reviewer
 * sockets (epic 013): the post-registration TOCTOU re-check and the 60s sweep
 * in yjs-websocket.js, which must re-validate revocation and existence in the
 * DB rather than trust the upgrade-time principal for up to 90 days.
 * @returns {'live'|'revoked'|'expired'|'missing'}
 */
export function reviewerLinkState(linkId) {
  const { rows } = querySync(
    'SELECT revoked_at, expires_at FROM review_links WHERE id = $1',
    [linkId],
  );
  const row = rows[0];
  if (!row) return 'missing';
  if (row.revoked_at != null) return 'revoked';
  if (row.expires_at < new Date().toISOString()) return 'expired';
  return 'live';
}

/**
 * May this user join this room? Membership in the project's org is the rule
 * (same as every REST route). Dev mode: always yes (current behavior).
 * Kept exported unchanged for yjs-signaling.js's per-message topic checks —
 * signaling is member-only (reviewers never reach it, see createUpgradeHandler).
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

      if (isDocSync) {
        const room = decodeURIComponent(pathname.replace(/^\/yjs-websocket\//, ''));
        const principal = await wsPrincipal(req, room);
        if (!principal) {
          refuse(socket);
          return;
        }
        const auth = await authorizeRoom(principal, room);
        if (!auth.ok) {
          // Covers non-member members AND reviewers on any room but their own
          // — including a revoked/expired link whose cookie still parses.
          refuse(socket, 403, 'Forbidden');
          return;
        }
        // Stamp the verdict for handleYjsConnection (same idiom as signaling's
        // req.kuhnUser below): the message-level read-only gate, the reviewer
        // registry and server-attributed presence all key off this.
        req.kuhnCollab = { principal, access: auth.access };
        yjsWss.handleUpgrade(req, socket, head, (ws) => yjsWss.emit('connection', ws, req));
        return;
      }

      // Signaling is member-only: a browser holding ONLY a reviewer cookie
      // resolves no user here and is refused (reviewers don't get webrtc
      // fan-out, and the per-connection topic cache never needs eviction).
      const user = await wsUser(req);
      if (!user) {
        refuse(socket);
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
