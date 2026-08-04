import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Epic 013 §5.4: the agent-overlap semantics are a TEST, not an assumption.
// This suite drives the REAL suggestion pipeline (pending-edits.js), the REAL
// event hub (project-events.js), and the REAL collab server (yjs-websocket.js)
// against real storage + in-memory SQLite, and pins what a reviewer holding a
// room experiences when an agent proposes and when an accepted edit lands:
//
//   (a) a suggestion (kind 'proposed') never touches disk or rooms — the
//       reviewer sees nothing;
//   (b) an accepted edit landing under a REVIEWER-ONLY room closes those
//       sockets with the reconnectable CLOSE_DOC_REFRESH (4005) and drops the
//       room, so reconnect re-seeds fresh from storage (brief decision 3 —
//       no silent divergence, no stale room clobbering the accepted edit);
//   (c) a room with at least one member connection keeps story-038 semantics
//       (nobody kicked; members reconcile through their SSE feed), and an
//       idle reviewer-less room is evicted exactly as today.
//
// Only git side effects are mocked — everything else is the production path.
process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('./history.js', () => ({
  commitNow: vi.fn(async () => 'commit-hash'),
  scheduleCommit: vi.fn(),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let handleYjsConnection; let hasRoom; let CLOSE_DOC_REFRESH;
let publishProjectEvent;
let proposeEdit; let acceptEdit;
let createReviewLink;
let reviewerLinkState;
let readProjectFile; let writeProjectFile;

let root;
const ORG_ID = 1;
const USER_ID = 1;
let PROJECT_ID;

const BASE = '# Overlap fixture\n\nOriginal paragraph.\n';
const PROPOSED = '# Overlap fixture\n\nAgent-accepted paragraph.\n';

beforeAll(async () => {
  let exec;
  ({ exec, querySync } = await import('./db.js'));
  exec(readFileSync(resolve(__dirname, 'db', 'schema.sql'), 'utf-8'));
  ({
    handleYjsConnection, hasRoom, CLOSE_DOC_REFRESH,
  } = await import('./yjs-websocket.js'));
  ({ publishProjectEvent } = await import('./project-events.js'));
  ({ proposeEdit, acceptEdit } = await import('./pending-edits.js'));
  ({ createReviewLink } = await import('./db/review-links.js'));
  ({ reviewerLinkState } = await import('./collab-auth.js'));
  ({ readProjectFile, writeProjectFile } = await import('./storage.js'));

  root = await mkdtemp(join(tmpdir(), 'kuhn-overlap-'));
  querySync("INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')", [ORG_ID]);
  querySync("INSERT INTO users (id, email) VALUES ($1, 'member@lab.org')", [USER_ID]);
  querySync('INSERT INTO memberships (user_id, org_id) VALUES ($1, $2)', [USER_ID, ORG_ID]);
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type, root_path) VALUES ($1, 'P', 'manuscript', $2) RETURNING id",
    [ORG_ID, root],
  );
  PROJECT_ID = rows[0].id;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Minimal ws double: enough surface for handleYjsConnection + eviction. */
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

function connect(room, collab) {
  const ws = fakeWs();
  const req = { url: `/yjs-websocket/${room}`, headers: { host: 'localhost' } };
  if (collab) req.kuhnCollab = collab;
  handleYjsConnection(ws, req);
  return ws;
}

const roomFor = (path) => `project-${PROJECT_ID}/${path}`;

/** Mint a live link and shape the principal the upgrade handler would stamp. */
function reviewerCollab(path, mode) {
  const { link } = createReviewLink({ projectId: PROJECT_ID, path, mode, createdBy: USER_ID });
  return {
    linkId: link.id,
    collab: {
      principal: {
        kind: 'reviewer', linkId: link.id, projectId: PROJECT_ID, path, mode,
        name: 'Jane', expiresAt: link.expiresAt,
      },
      access: mode === 'edit' ? 'write' : 'read',
    },
  };
}

const MEMBER_COLLAB = { principal: { kind: 'member', user: { id: USER_ID } }, access: 'write' };

/** Seed a doc on disk and register an agent suggestion against it. */
async function fixture(path) {
  await writeProjectFile(PROJECT_ID, path, BASE);
  const edit = await proposeEdit(PROJECT_ID, {
    path, proposedContent: PROPOSED, agentSlug: 'writer', jobId: null,
  });
  return edit;
}

const fileEventCount = (path) => querySync(
  'SELECT COUNT(*) AS n FROM file_events WHERE project_id = $1 AND path = $2',
  [PROJECT_ID, path],
).rows[0].n;

describe('agent suggestion vs live reviewer room (013-002 §5.4a)', () => {
  it('a proposed suggestion touches neither disk nor the room the reviewer holds', async () => {
    const path = 'draft/overlap-suggest.md';
    const edit = await fixture(path);
    const { collab } = reviewerCollab(path, 'comment');
    const ws = connect(roomFor(path), collab);
    const sentBefore = ws.sent.length;

    // The publish site suggestions actually use (routes/pending-edits.js and
    // the agent tool's fileChangeEvent): kind 'proposed', SSE fan-out only.
    publishProjectEvent(PROJECT_ID, {
      type: 'file_change', agent: 'writer', path, kind: 'proposed',
    }, { userId: USER_ID });

    expect(edit.id).toBeGreaterThan(0);
    expect(hasRoom(roomFor(path))).toBe(true); // no eviction of any flavor
    expect(ws.closed).toBe(null); // reviewer connection untouched
    expect(ws.sent.length).toBe(sentBefore); // nothing reviewer-visible
    expect((await readProjectFile(PROJECT_ID, path)).toString()).toBe(BASE); // never touched disk
    expect(fileEventCount(path)).toBe(0); // no activity row either
  });
});

describe('accepted pending edit vs live rooms (013-002 §5.4b/c, brief decision 3)', () => {
  it('reviewer-only room: sockets close with reconnectable 4005 and the room drops', async () => {
    const path = 'draft/overlap-reviewer-only.md';
    const edit = await fixture(path);
    const { linkId, collab } = reviewerCollab(path, 'comment');
    const ws = connect(roomFor(path), collab);
    expect(ws.closed).toBe(null);

    await acceptEdit(PROJECT_ID, edit.id, { userId: USER_ID });

    // The accept really landed…
    expect((await readProjectFile(PROJECT_ID, path)).toString()).toBe(PROPOSED);
    // …and the reviewer was told to come back, not that the link died: 4005 is
    // reconnectable (4003/4004 are terminal), distinct reason included.
    expect(ws.closed).toEqual({ code: CLOSE_DOC_REFRESH, reason: 'Document updated' });
    expect(ws.closed.code).toBe(4005);
    // The stale room is gone, so nothing can replay old bytes over the accept.
    expect(hasRoom(roomFor(path))).toBe(false);

    // The credential survived: reconnecting passes the registration re-check
    // and lands in a FRESH room that will seed from (post-accept) storage.
    expect(reviewerLinkState(linkId)).toBe('live');
    const ws2 = connect(roomFor(path), collab);
    expect(ws2.closed).toBe(null);
    expect(hasRoom(roomFor(path))).toBe(true);
    ws2.disconnect();
  });

  it('room with a member connection keeps story-038 semantics: nobody is kicked', async () => {
    const path = 'draft/overlap-member.md';
    const edit = await fixture(path);
    const member = connect(roomFor(path), MEMBER_COLLAB);
    const { collab } = reviewerCollab(path, 'view');
    const reviewer = connect(roomFor(path), collab);

    await acceptEdit(PROJECT_ID, edit.id, { userId: USER_ID });

    expect((await readProjectFile(PROJECT_ID, path)).toString()).toBe(PROPOSED);
    // Divergence-with-a-member is the deliberate v1 behavior: the member's SSE
    // feed reconciles it (story 038); evicting would kick live collaborators.
    expect(hasRoom(roomFor(path))).toBe(true);
    expect(member.closed).toBe(null);
    expect(reviewer.closed).toBe(null);
    member.disconnect();
    reviewer.disconnect();
  });

  it('idle reviewer-less room is evicted exactly as today', async () => {
    const path = 'draft/overlap-idle.md';
    const edit = await fixture(path);
    connect(roomFor(path), MEMBER_COLLAB).disconnect(); // idle, in the 30s grace window
    expect(hasRoom(roomFor(path))).toBe(true);

    await acceptEdit(PROJECT_ID, edit.id, { userId: USER_ID });

    expect(hasRoom(roomFor(path))).toBe(false); // next open seeds fresh from storage
    expect((await readProjectFile(PROJECT_ID, path)).toString()).toBe(PROPOSED);
  });
});
