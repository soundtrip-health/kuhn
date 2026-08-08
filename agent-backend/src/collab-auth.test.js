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
let memberRoomAccess; let canPublishRoom;
let createSession;
let createReviewLink; let claimReviewLink; let revokeReviewLink;
let handleSignalingConnection; let handleYjsConnection;
let server; let port;
let memberCookie; let strangerCookie; let viewerCookie; let editorCookie;
let viewer; // claimed view link on project-5/draft/main.md

const MEMBER = { id: 1, email: 'member@lab.org' };      // owner of org 7
const STRANGER = { id: 2, email: 'stranger@elsewhere.org' };
const VIEWER = { id: 3, email: 'viewer@lab.org' };      // viewer in org 7
const EDITOR = { id: 4, email: 'editor@lab.org' };      // editor in org 7
const FROZEN = { id: 5, email: 'frozen@ice.org' };      // editor in suspended org 8

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
    memberRoomAccess, canPublishRoom,
  } = await import('./collab-auth.js'));
  ({ createSession } = await import('./db/auth.js'));
  ({ createReviewLink, claimReviewLink, revokeReviewLink } = await import('./db/review-links.js'));
  ({ handleSignalingConnection } = await import('./yjs-signaling.js'));
  ({ handleYjsConnection } = await import('./yjs-websocket.js'));

  // One org with one project; MEMBER (owner), VIEWER and EDITOR belong,
  // STRANGER exists but does not. Org 8 is SUSPENDED (story 010-003/011-001):
  // FROZEN is an editor there, project 6 belongs to it.
  querySync("INSERT INTO organizations (id, name, slug) VALUES (7, 'Lab', 'lab')");
  querySync("INSERT INTO organizations (id, name, slug, status) VALUES (8, 'Ice', 'ice', 'suspended')");
  querySync(`INSERT INTO users (id, email) VALUES
    (1, 'member@lab.org'), (2, 'stranger@elsewhere.org'),
    (3, 'viewer@lab.org'), (4, 'editor@lab.org'), (5, 'frozen@ice.org')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES
    (1, 7, 'owner'), (3, 7, 'viewer'), (4, 7, 'editor'), (5, 8, 'editor')`);
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (5, 7, 'P', 'manuscript')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (6, 8, 'F', 'manuscript')");
  memberCookie = (await createSession(MEMBER.id)).cookieValue;
  strangerCookie = (await createSession(STRANGER.id)).cookieValue;
  viewerCookie = (await createSession(VIEWER.id)).cookieValue;
  editorCookie = (await createSession(EDITOR.id)).cookieValue;
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

// --- hand-rolled Yjs client helpers (epic 013 story 002; reused for the
// 010-003 viewer-member AC2 test) ---------------------------------------------

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

// --- Story 010-003: member roles on the collab gate --------------------------

describe('memberRoomAccess / authorizeRoom member branch (story 010-003)', () => {
  const member = (user) => ({ kind: 'member', user });

  it('maps roles to access: viewer read, editor write, owner write', async () => {
    expect(await memberRoomAccess(VIEWER, ROOM)).toBe('read');
    expect(await memberRoomAccess(EDITOR, ROOM)).toBe('write');
    expect(await memberRoomAccess(MEMBER, ROOM)).toBe('write'); // owner
    expect(await authorizeRoom(member(VIEWER), ROOM)).toEqual({ ok: true, access: 'read' });
    expect(await authorizeRoom(member(EDITOR), ROOM)).toEqual({ ok: true, access: 'write' });
    expect(await authorizeRoom(member(MEMBER), ROOM)).toEqual({ ok: true, access: 'write' });
  });

  it('refuses strangers, unknown projects, malformed rooms and the anonymous', async () => {
    expect(await memberRoomAccess(STRANGER, ROOM)).toBe(null);
    expect(await memberRoomAccess(MEMBER, 'project-999/draft.md')).toBe(null);
    expect(await memberRoomAccess(MEMBER, 'project-5/../4/x.md')).toBe(null);
    expect(await memberRoomAccess(null, ROOM)).toBe(null);
    expect((await authorizeRoom(member(STRANGER), ROOM)).ok).toBe(false);
  });

  it('refuses a suspended org even for its own editor', async () => {
    expect(await memberRoomAccess(FROZEN, 'project-6/draft/main.md')).toBe(null);
    expect((await authorizeRoom(member(FROZEN), 'project-6/draft/main.md')).ok).toBe(false);
  });

  it('dev mode: write even for identities with no membership (WS-only dev users)', async () => {
    config.auth.mode = 'dev';
    try {
      expect(await memberRoomAccess({ id: 999, email: 'no@member.ship' }, ROOM)).toBe('write');
      expect(await authorizeRoom(member(STRANGER), ROOM)).toEqual({ ok: true, access: 'write' });
    } finally {
      config.auth.mode = 'magic-link';
    }
  });

  it('a viewer session joins over the real upgrade and is stamped read: crafted updates are dropped, broadcasts still arrive', async () => {
    const room = 'project-5/draft/viewer-gate.md';

    const view = await attemptCollecting(`/yjs-websocket/${room}`, `kuhn_session=${viewerCookie}`);
    expect(view.opened).toBe(true);

    // Raw protocol bytes, no y-websocket client: a crafted MSG_SYNC Update.
    view.ws.send(updateMessage('INJECTED'));
    await new Promise((ok) => setTimeout(ok, 200)); // give a rogue apply time to land

    // An editor syncs the room and sees an EMPTY doc — the viewer's write was
    // dropped at the message level (010-003 AC2).
    const editor = await attemptCollecting(`/yjs-websocket/${room}`, `kuhn_session=${editorCookie}`);
    expect(editor.opened).toBe(true);
    const editorDoc = new Y.Doc();
    editor.ws.send(step1Message(editorDoc));
    await waitFor(() => syncMessagesInto(editor.messages.splice(0), editorDoc) && editorDoc.getText('t').length > 0, 400);
    expect(editorDoc.getText('t').toString()).toBe('');

    // Positive control: the editor's write lands and reaches the viewer.
    editor.ws.send(updateMessage('LEGIT'));
    const viewDoc = new Y.Doc();
    const gotIt = await waitFor(() => {
      syncMessagesInto(view.messages.splice(0), viewDoc);
      return viewDoc.getText('t').toString() === 'LEGIT';
    });
    expect(gotIt).toBe(true);

    view.ws.close();
    editor.ws.close();
  });
});

describe('canPublishRoom (story 010-003, fix I6)', () => {
  it('allows editor and owner, refuses viewer, stranger, suspended and anonymous', async () => {
    expect(await canPublishRoom(EDITOR, ROOM)).toBe(true);
    expect(await canPublishRoom(MEMBER, ROOM)).toBe(true); // owner
    expect(await canPublishRoom(VIEWER, ROOM)).toBe(false);
    expect(await canPublishRoom(STRANGER, ROOM)).toBe(false);
    expect(await canPublishRoom(FROZEN, 'project-6/draft/main.md')).toBe(false);
    expect(await canPublishRoom(null, ROOM)).toBe(false);
  });

  it('dev mode stays frictionless', async () => {
    config.auth.mode = 'dev';
    try {
      expect(await canPublishRoom(null, 'anything-goes')).toBe(true);
    } finally {
      config.auth.mode = 'magic-link';
    }
  });
});

describe('signaling publish requires editor+ (story 010-003, fix I6)', () => {
  const request = (ws, message) => ws.send(JSON.stringify(message));
  const nextMessage = (ws) =>
    new Promise((ok) => ws.once('message', (raw) => ok(JSON.parse(raw.toString()))));

  it('a viewer may subscribe but their publish reaches nobody; an editor publish relays', async () => {
    const topic = 'project-5/draft/main.md';
    const listener = await attempt('/yjs-signaling', `kuhn_session=${memberCookie}`);
    const view = await attempt('/yjs-signaling', `kuhn_session=${viewerCookie}`);
    const edit = await attempt('/yjs-signaling', `kuhn_session=${editorCookie}`);
    expect(listener.opened && view.opened && edit.opened).toBe(true);

    request(listener.ws, { type: 'subscribe', topics: [topic] });
    expect((await nextMessage(listener.ws)).topics).toEqual([topic]);

    // Subscribe stays membership-based: the viewer IS confirmed…
    request(view.ws, { type: 'subscribe', topics: [topic] });
    expect((await nextMessage(view.ws)).topics).toEqual([topic]);

    // …but their publish is dropped: the listener hears silence for a beat
    // where the relay would have been near-instant.
    request(view.ws, { type: 'publish', topic, data: { spoof: 1 } });
    const raced = await Promise.race([
      new Promise((ok) => listener.ws.once('message', () => ok('relay'))),
      new Promise((ok) => setTimeout(() => ok('silence'), 300)),
    ]);
    expect(raced).toBe('silence');

    // Positive control: an editor's publish relays.
    const relayed = new Promise((ok) => listener.ws.once('message', (raw) => ok(JSON.parse(raw.toString()))));
    request(edit.ws, { type: 'publish', topic, data: { legit: 1 } });
    expect(await relayed).toEqual({ type: 'publish', topic, data: { legit: 1 } });

    listener.ws.close();
    view.ws.close();
    edit.ws.close();
  });
});

describe('suspended org closes the reviewer side door (story 011-001, fix MA2)', () => {
  it('authorizeRoom refuses a live link whose project org is suspended', async () => {
    const p = {
      kind: 'reviewer', linkId: 4242, projectId: 6, path: 'draft/main.md',
      mode: 'edit', name: 'J', expiresAt: '2999-01-01T00:00:00.000Z',
    };
    expect((await authorizeRoom(p, 'project-6/draft/main.md')).ok).toBe(false);
  });

  it('reviewerLinkState reports suspended; terminal states outrank it', () => {
    const { link } = createReviewLink({ projectId: 6, path: 'draft/main.md', mode: 'view', createdBy: MEMBER.id });
    expect(reviewerLinkState(link.id)).toBe('suspended');

    // Expiry (terminal) outranks suspension (recoverable)…
    querySync("UPDATE review_links SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1", [link.id]);
    expect(reviewerLinkState(link.id)).toBe('expired');

    // …and revocation outranks both.
    revokeReviewLink(6, link.id, { revokedBy: MEMBER.id });
    expect(reviewerLinkState(link.id)).toBe('revoked');

    // Unsuspension brings a live link back.
    querySync('DELETE FROM review_links WHERE id = $1', [link.id]);
    const fresh = createReviewLink({ projectId: 6, path: 'draft/main.md', mode: 'view', createdBy: MEMBER.id });
    querySync("UPDATE organizations SET status = 'active' WHERE id = 8");
    try {
      expect(reviewerLinkState(fresh.link.id)).toBe('live');
    } finally {
      querySync("UPDATE organizations SET status = 'suspended' WHERE id = 8");
    }
    expect(reviewerLinkState(fresh.link.id)).toBe('suspended');
  });

  it('a claimed link on a suspended org is refused at upgrade with 403 — no doc bytes', async () => {
    const { token } = createReviewLink({ projectId: 6, path: 'draft/main.md', mode: 'view', createdBy: MEMBER.id });
    const res = claimReviewLink(token, 'Frost Reviewer');
    expect(res.ok).toBe(true);

    const joined = await attempt('/yjs-websocket/project-6/draft/main.md', reviewCookie(res.cookieValue));
    expect(joined.opened).toBe(false);
    expect(joined.error).toMatch(/403/);
  });
});
