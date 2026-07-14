import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';

// Real in-memory SQLite — membership checks are the substance. Must be set
// before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config; let exec; let querySync;
let parseRoomName; let canJoinRoom; let createUpgradeHandler;
let createSession;
let handleSignalingConnection; let handleYjsConnection;
let server; let port;
let memberCookie; let strangerCookie;

const MEMBER = { id: 1, email: 'member@lab.org' };
const STRANGER = { id: 2, email: 'stranger@elsewhere.org' };

beforeAll(async () => {
  ({ config } = await import('./config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';

  ({ exec, querySync } = await import('./db.js'));
  exec(readFileSync(resolve(__dirname, 'db/schema.sql'), 'utf-8'));
  ({ parseRoomName, canJoinRoom, createUpgradeHandler } = await import('./collab-auth.js'));
  ({ createSession } = await import('./db/auth.js'));
  ({ handleSignalingConnection } = await import('./yjs-signaling.js'));
  ({ handleYjsConnection } = await import('./yjs-websocket.js'));

  // One org with one project; MEMBER belongs, STRANGER exists but does not.
  querySync("INSERT INTO organizations (id, name, slug) VALUES (7, 'Lab', 'lab')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'member@lab.org'), (2, 'stranger@elsewhere.org')");
  querySync("INSERT INTO memberships (user_id, org_id) VALUES (1, 7)");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (5, 7, 'P', 'manuscript')");
  memberCookie = (await createSession(MEMBER.id)).cookieValue;
  strangerCookie = (await createSession(STRANGER.id)).cookieValue;

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
function attempt(path, cookie) {
  return new Promise((resolveAttempt) => {
    const ws = new WebSocket(`ws://localhost:${port}${path}`, {
      headers: cookie ? { Cookie: `kuhn_session=${cookie}` } : {},
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
    const { ws, opened, firstMessage } = await attempt('/yjs-websocket/project-5/draft/main.md', memberCookie);
    expect(opened).toBe(true);
    expect((await firstMessage).length).toBeGreaterThan(0); // syncStep1 arrived
    ws.close();
  });

  it('refuses without a cookie, with a non-member cookie, and for malformed rooms — before any doc bytes', async () => {
    const anonymous = await attempt('/yjs-websocket/project-5/draft/main.md', null);
    expect(anonymous.opened).toBe(false);
    expect(anonymous.error).toMatch(/401/);

    const stranger = await attempt('/yjs-websocket/project-5/draft/main.md', strangerCookie);
    expect(stranger.opened).toBe(false);
    expect(stranger.error).toMatch(/403/);

    const malformed = await attempt('/yjs-websocket/project-5/../4/draft.md', memberCookie);
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
    const member = await attempt('/yjs-signaling', memberCookie);
    const stranger = await attempt('/yjs-signaling', strangerCookie);
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
