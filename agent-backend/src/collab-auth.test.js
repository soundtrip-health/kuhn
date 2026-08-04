import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

// Real in-memory SQLite — membership checks are the substance. Must be set
// before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config; let exec; let querySync;
let parseRoomName; let canJoinRoom; let createUpgradeHandler;
let wsPrincipal; let authorizeRoom; let reviewerLinkState;
let createSession;
let createReviewLink; let claimReviewLink; let revokeReviewLink;
let handleSignalingConnection; let handleYjsConnection;
let server; let port;
let memberCookie; let strangerCookie;
let viewer; // claimed view link on project-5/draft/main.md

const MEMBER = { id: 1, email: 'member@lab.org' };
const STRANGER = { id: 2, email: 'stranger@elsewhere.org' };

/** Mint + claim a review link on project 5; returns its signed cookie value. */
function mintClaimed(path, mode, name) {
  const { token } = createReviewLink({ projectId: 5, path, mode, createdBy: MEMBER.id });
  const res = claimReviewLink(token, name);
  expect(res.ok).toBe(true);
  return { cookieValue: res.cookieValue, link: res.link };
}

beforeAll(async () => {
  ({ config } = await import('./config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';

  ({ exec, querySync } = await import('./db.js'));
  exec(readFileSync(resolve(__dirname, 'db/schema.sql'), 'utf-8'));
  ({
    parseRoomName, canJoinRoom, createUpgradeHandler,
    wsPrincipal, authorizeRoom, reviewerLinkState,
  } = await import('./collab-auth.js'));
  ({ createSession } = await import('./db/auth.js'));
  ({ createReviewLink, claimReviewLink, revokeReviewLink } = await import('./db/review-links.js'));
  ({ handleSignalingConnection } = await import('./yjs-signaling.js'));
  ({ handleYjsConnection } = await import('./yjs-websocket.js'));

  // One org with one project; MEMBER belongs, STRANGER exists but does not.
  querySync("INSERT INTO organizations (id, name, slug) VALUES (7, 'Lab', 'lab')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'member@lab.org'), (2, 'stranger@elsewhere.org')");
  querySync("INSERT INTO memberships (user_id, org_id) VALUES (1, 7)");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (5, 7, 'P', 'manuscript')");
  memberCookie = (await createSession(MEMBER.id)).cookieValue;
  strangerCookie = (await createSession(STRANGER.id)).cookieValue;
  viewer = mintClaimed('draft/main.md', 'view', 'Jane Reviewer');

  // The same wiring index.js uses, on a scratch server.
  const signalingWss = new WebSocketServer({ noServer: true });
  const yjsWss = new WebSocketServer({ noServer: true });
  signalingWss.on('connection', handleSignalingConnection);
  yjsWss.on('connection', handleYjsConnection);
  server = createServer();
  server.on('upgrade', createUpgradeHandler({ signalingWss, yjsWss }));
  await new Promise((ok) => { server = server.listen(0, ok); });
  port = server.address().port;
});

afterAll(async () => {
  config.auth.mode = 'dev';
  config.auth.sessionSecret = '';
  await new Promise((ok) => server.close(ok));
});

/**
 * Open a WS and resolve with how the handshake ended. The first-message
 * listener is attached at construction — before 'open' resolves — so a
 * server greeting can't slip past between open and the test's await.
 */
function attempt(path, cookieHeader) {
  return new Promise((resolveAttempt) => {
    const ws = new WebSocket(`ws://localhost:${port}${path}`, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
    const firstMessage = new Promise((ok) => ws.once('message', ok));
    firstMessage.catch(() => {});
    ws.on('open', () => resolveAttempt({ ws, opened: true, firstMessage }));
    ws.on('error', (err) => resolveAttempt({ ws, opened: false, error: err.message }));
  });
}

describe('parseRoomName (story 007-003)', () => {
  it('accepts project rooms and extracts id + path', () => {
    expect(parseRoomName('project-5/draft/main.md')).toEqual({ projectId: 5, path: 'draft/main.md' });
  });

  it.each([
    ['no-prefix/draft.md'],
    ['project-x/draft.md'],
    ['project-5'],
    ['project-5/'],
    ['project-5/../4/draft.md'],
    ['project-5/draft/../../secret.md'],
    ['project-5//double.md'],
    ['project-5/back\\slash.md'],
  ])('rejects malformed room %s', (room) => {
    expect(parseRoomName(room)).toBeNull();
  });
});

describe('canJoinRoom (story 007-003)', () => {
  it('allows org members, refuses strangers and the anonymous', async () => {
    expect(await canJoinRoom(MEMBER, 'project-5/draft/main.md')).toBe(true);
    expect(await canJoinRoom(STRANGER, 'project-5/draft/main.md')).toBe(false);
    expect(await canJoinRoom(null, 'project-5/draft/main.md')).toBe(false);
  });

  it('refuses malformed rooms and unknown projects', async () => {
    expect(await canJoinRoom(MEMBER, 'project-5/../4/x.md')).toBe(false);
    expect(await canJoinRoom(MEMBER, 'project-999/draft.md')).toBe(false);
  });

  it('dev mode stays frictionless', async () => {
    config.auth.mode = 'dev';
    try {
      expect(await canJoinRoom(null, 'anything-goes')).toBe(true);
    } finally {
      config.auth.mode = 'magic-link';
    }
  });
});

describe('doc-sync upgrade gate (story 007-003)', () => {
  it('a member joins and receives sync bytes', async () => {
    const { ws, opened, firstMessage } = await attempt('/yjs-websocket/project-5/draft/main.md', `kuhn_session=${memberCookie}`);
    expect(opened).toBe(true);
    expect((await firstMessage).length).toBeGreaterThan(0); // syncStep1 arrived
    ws.close();
  });

  it('refuses without a cookie, with a non-member cookie, and for malformed rooms — before any doc bytes', async () => {
    const anonymous = await attempt('/yjs-websocket/project-5/draft/main.md', null);
    expect(anonymous.opened).toBe(false);
    expect(anonymous.error).toMatch(/401/);

    const stranger = await attempt('/yjs-websocket/project-5/draft/main.md', `kuhn_session=${strangerCookie}`);
    expect(stranger.opened).toBe(false);
    expect(stranger.error).toMatch(/403/);

    const malformed = await attempt('/yjs-websocket/project-5/../4/draft.md', `kuhn_session=${memberCookie}`);
    expect(malformed.opened).toBe(false);
    expect(malformed.error).toMatch(/403|404|400/); // refused either by the gate or by URL normalization upstream
  });
});

describe('signaling gate (story 007-003)', () => {
  const request = (ws, message) => ws.send(JSON.stringify(message));
  const nextMessage = (ws) =>
    new Promise((ok) => ws.once('message', (raw) => ok(JSON.parse(raw.toString()))));

  it('refuses the upgrade without a session', async () => {
    const { opened, error } = await attempt('/yjs-signaling', null);
    expect(opened).toBe(false);
    expect(error).toMatch(/401/);
  });

  it('confirms only topics the user may join, and only relays into them', async () => {
    const member = await attempt('/yjs-signaling', `kuhn_session=${memberCookie}`);
    const stranger = await attempt('/yjs-signaling', `kuhn_session=${strangerCookie}`);
    expect(member.opened).toBe(true);
    expect(stranger.opened).toBe(true);

    request(member.ws, { type: 'subscribe', topics: ['project-5/draft/main.md'] });
    expect((await nextMessage(member.ws)).topics).toEqual(['project-5/draft/main.md']);

    // The stranger's subscribe is confirmed empty…
    request(stranger.ws, { type: 'subscribe', topics: ['project-5/draft/main.md'] });
    expect((await nextMessage(stranger.ws)).topics).toEqual([]);

    // …and their publish into the room reaches nobody: the member hears
    // silence for a beat where the relay would have been near-instant.
    const raced = await Promise.race([
      new Promise((ok) => member.ws.once('message', () => ok('relay'))),
      new Promise((ok) => setTimeout(() => ok('silence'), 300)),
    ]);
    expect(raced).toBe('silence');

    member.ws.close();
    stranger.ws.close();
  });
});

// --- Epic 013: external reviewers on the collab gate ------------------------

const reviewCookie = (c) => `kuhn_review_session=${c}`;
const ROOM = 'project-5/draft/main.md';

describe('wsPrincipal — reviewer cookie wins (epic 013 blocker fix)', () => {
  it('dev mode: a socket holding kuhn_review_session resolves as the REVIEWER for its doc, not the dev member', async () => {
    config.auth.mode = 'dev';
    try {
      const req = { headers: { cookie: reviewCookie(viewer.cookieValue) } };
      const principal = await wsPrincipal(req, ROOM);
      expect(principal.kind).toBe('reviewer'); // member-first would yield the dev user here
      expect(principal.linkId).toBe(viewer.link.id);
      expect(principal.mode).toBe('view');
      expect(principal.name).toBe('Jane Reviewer');

      // Any OTHER room: falls back to member resolution — dev stays frictionless.
      const other = await wsPrincipal(req, 'project-5/draft/other.md');
      expect(other.kind).toBe('member');
    } finally {
      config.auth.mode = 'magic-link';
    }
  });

  it('magic-link mode: reviewer for its own room; mismatched rooms fall through to a refusable principal', async () => {
    const req = { headers: { cookie: reviewCookie(viewer.cookieValue) } };
    const matched = await wsPrincipal(req, ROOM);
    expect(matched.kind).toBe('reviewer');

    // Wrong room, no member session: still the reviewer principal —
    // authenticated but never authorized (403, not 401).
    const mismatched = await wsPrincipal(req, 'project-5/draft/other.md');
    expect(mismatched.kind).toBe('reviewer');
    expect((await authorizeRoom(mismatched, 'project-5/draft/other.md')).ok).toBe(false);

    // Both cookies: the reviewer wins for the link's doc, the member elsewhere.
    const both = { headers: { cookie: `kuhn_session=${memberCookie}; ${reviewCookie(viewer.cookieValue)}` } };
    expect((await wsPrincipal(both, ROOM)).kind).toBe('reviewer');
    expect((await wsPrincipal(both, 'project-5/draft/other.md')).kind).toBe('member');

    // No credential at all: null.
    expect(await wsPrincipal({ headers: {} }, ROOM)).toBe(null);
  });
});

describe('authorizeRoom (epic 013)', () => {
  it('maps reviewer modes to access levels, exact doc only', async () => {
    const p = (mode) => ({ kind: 'reviewer', linkId: 99, projectId: 5, path: 'draft/main.md', mode, name: 'J', expiresAt: '2999-01-01T00:00:00.000Z' });
    expect(await authorizeRoom(p('view'), ROOM)).toEqual({ ok: true, access: 'read' });
    expect(await authorizeRoom(p('comment'), ROOM)).toEqual({ ok: true, access: 'read' });
    expect(await authorizeRoom(p('edit'), ROOM)).toEqual({ ok: true, access: 'write' });
    expect((await authorizeRoom(p('comment'), 'project-5/draft/other.md')).ok).toBe(false);
    expect((await authorizeRoom(p('comment'), 'project-6/draft/main.md')).ok).toBe(false);
    expect((await authorizeRoom(p('comment'), 'project-5/../5/draft/main.md')).ok).toBe(false);
  });

  it('members get write on membership-checked rooms; null principals are refused', async () => {
    expect(await authorizeRoom({ kind: 'member', user: MEMBER }, ROOM)).toEqual({ ok: true, access: 'write' });
    expect((await authorizeRoom({ kind: 'member', user: STRANGER }, ROOM)).ok).toBe(false);
    expect((await authorizeRoom(null, ROOM)).ok).toBe(false);
  });
});

describe('reviewerLinkState (epic 013)', () => {
  it('reports live, revoked, expired, missing', () => {
    const { link } = createReviewLink({ projectId: 5, path: 'draft/state.md', mode: 'view', createdBy: MEMBER.id });
    expect(reviewerLinkState(link.id)).toBe('live');

    querySync("UPDATE review_links SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1", [link.id]);
    expect(reviewerLinkState(link.id)).toBe('expired');

    // Revocation outranks expiry (matches db/review-links state precedence).
    revokeReviewLink(5, link.id, { revokedBy: MEMBER.id });
    expect(reviewerLinkState(link.id)).toBe('revoked');

    querySync('DELETE FROM review_links WHERE id = $1', [link.id]);
    expect(reviewerLinkState(link.id)).toBe('missing');
  });
});

describe('reviewer doc-sync upgrade + hand-rolled client (epic 013 story 002)', () => {
  const waitFor = async (predicate, ms = 1500) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) return false;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    return true;
  };

  /** attempt() + collect every message the socket receives from open onward. */
  async function attemptCollecting(path, cookieHeader) {
    const res = await attempt(path, cookieHeader);
    res.messages = [];
    if (res.opened) {
      res.ws.on('message', (raw) => res.messages.push(new Uint8Array(raw)));
      const first = await res.firstMessage; // once() consumed it before our .on
      res.messages.unshift(new Uint8Array(first));
    }
    return res;
  }

  const syncMessagesInto = (messages, doc) => {
    for (const m of messages) {
      const dec = decoding.createDecoder(m);
      if (decoding.readVarUint(dec) !== 0) continue;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.readSyncMessage(dec, enc, doc, null);
    }
    return doc;
  };

  const updateMessage = (text) => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, text);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
    return encoding.toUint8Array(enc);
  };

  const step1Message = (doc) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, doc);
    return encoding.toUint8Array(enc);
  };

  it('a claimed view link joins exactly its doc room; other rooms are 403; signaling is member-only', async () => {
    const joined = await attempt(`/yjs-websocket/${ROOM}`, reviewCookie(viewer.cookieValue));
    expect(joined.opened).toBe(true);
    expect((await joined.firstMessage).length).toBeGreaterThan(0);
    joined.ws.close();

    const wrongRoom = await attempt('/yjs-websocket/project-5/draft/other.md', reviewCookie(viewer.cookieValue));
    expect(wrongRoom.opened).toBe(false);
    expect(wrongRoom.error).toMatch(/403/);

    const signaling = await attempt('/yjs-signaling', reviewCookie(viewer.cookieValue));
    expect(signaling.opened).toBe(false);
    expect(signaling.error).toMatch(/401/);
  });

  it('a revoked link is refused at upgrade — one socket cycle, no doc bytes', async () => {
    const revocable = mintClaimed('draft/main.md', 'comment', 'Shortlived');
    const before = await attempt(`/yjs-websocket/${ROOM}`, reviewCookie(revocable.cookieValue));
    expect(before.opened).toBe(true);
    before.ws.close();

    revokeReviewLink(5, revocable.link.id, { revokedBy: MEMBER.id });
    const after = await attempt(`/yjs-websocket/${ROOM}`, reviewCookie(revocable.cookieValue));
    expect(after.opened).toBe(false);
    expect(after.error).toMatch(/401|403/);
  });

  it('a hand-rolled ws client holding a view session cannot mutate the doc; member updates still reach it', async () => {
    const room = 'project-5/draft/handrolled.md';
    const eve = mintClaimed('draft/handrolled.md', 'view', 'Eve');

    const rev = await attemptCollecting(`/yjs-websocket/${room}`, reviewCookie(eve.cookieValue));
    expect(rev.opened).toBe(true);

    // Raw protocol bytes, no y-websocket client: a crafted MSG_SYNC Update.
    rev.ws.send(updateMessage('INJECTED'));
    await new Promise((ok) => setTimeout(ok, 200)); // give a rogue apply time to land

    // A member syncs the room and sees an EMPTY doc — the write was dropped
    // at the message level, not merely unbroadcast.
    const member = await attemptCollecting(`/yjs-websocket/${room}`, `kuhn_session=${memberCookie}`);
    expect(member.opened).toBe(true);
    const memberDoc = new Y.Doc();
    member.ws.send(step1Message(memberDoc));
    await waitFor(() => syncMessagesInto(member.messages.splice(0), memberDoc) && memberDoc.getText('t').length > 0, 400);
    expect(memberDoc.getText('t').toString()).toBe('');

    // Positive control: the member's write lands and is broadcast to the
    // read-only reviewer connection.
    member.ws.send(updateMessage('LEGIT'));
    const revDoc = new Y.Doc();
    const gotIt = await waitFor(() => {
      syncMessagesInto(rev.messages.splice(0), revDoc);
      return revDoc.getText('t').toString() === 'LEGIT';
    });
    expect(gotIt).toBe(true);

    rev.ws.close();
    member.ws.close();
  });
});
