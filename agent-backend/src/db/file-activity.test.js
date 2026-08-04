import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Real in-memory SQLite (references.test.js pattern) — the unseen/prune SQL
// is the substance here, so no mocks. Must be set before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync; let config;
let recordFileEvent; let listFileActivity; let markSeen; let unseenPaths; let migrateSeenPaths;
let publishProjectEvent;
let PROJECT_ID;
const USER_ID = 1;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ config } = await import('../config.js'));
  ({ recordFileEvent, listFileActivity, markSeen, unseenPaths, migrateSeenPaths } =
    await import('./file-activity.js'));
  ({ publishProjectEvent } = await import('../project-events.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
});

beforeEach(() => {
  querySync('DELETE FROM file_events');
  querySync('DELETE FROM file_seen');
  querySync('DELETE FROM review_links');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync('DELETE FROM users');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync("INSERT INTO users (id, email, display_name) VALUES (1, 'dev@kuhn.local', 'Dev')");
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id",
  );
  PROJECT_ID = rows[0].id;
});

const ageSeenRow = (path) => querySync(
  "UPDATE file_seen SET seen_at = '2020-01-01T00:00:00.000Z' WHERE project_id = $1 AND path = $2",
  [PROJECT_ID, path],
);

describe('file activity store (story 005-002)', () => {
  it('records events and lists them newest first', () => {
    recordFileEvent(PROJECT_ID, { path: 'a.md', kind: 'create', agentSlug: 'writer' });
    recordFileEvent(PROJECT_ID, { path: 'a.md', kind: 'update', agentSlug: null });
    const events = listFileActivity(PROJECT_ID);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ path: 'a.md', kind: 'update', agent_slug: null });
    expect(events[1]).toMatchObject({ kind: 'create', agent_slug: 'writer' });
  });

  it('prunes the log to the per-project cap, keeping the newest', () => {
    const saved = config.fileActivity.maxEventsPerProject;
    config.fileActivity.maxEventsPerProject = 3;
    try {
      for (let i = 1; i <= 6; i++) {
        recordFileEvent(PROJECT_ID, { path: `f${i}.md`, kind: 'create' });
      }
      const events = listFileActivity(PROJECT_ID);
      expect(events.map((e) => e.path)).toEqual(['f6.md', 'f5.md', 'f4.md']);
    } finally {
      config.fileActivity.maxEventsPerProject = saved;
    }
  });

  it('unseen flips across the seen upsert and back on a newer event', () => {
    recordFileEvent(PROJECT_ID, { path: 'draft/main.md', kind: 'update' });
    expect(unseenPaths(PROJECT_ID, USER_ID).has('draft/main.md')).toBe(true);

    markSeen(USER_ID, PROJECT_ID, 'draft/main.md');
    expect(unseenPaths(PROJECT_ID, USER_ID).has('draft/main.md')).toBe(false);

    ageSeenRow('draft/main.md'); // avoid same-millisecond timestamp ties
    recordFileEvent(PROJECT_ID, { path: 'draft/main.md', kind: 'update' });
    expect(unseenPaths(PROJECT_ID, USER_ID).has('draft/main.md')).toBe(true);
  });

  it('unseen is per-user and ignores paths whose latest activity is a delete', () => {
    recordFileEvent(PROJECT_ID, { path: 'x.md', kind: 'create' });
    recordFileEvent(PROJECT_ID, { path: 'gone.md', kind: 'delete' });
    markSeen(USER_ID, PROJECT_ID, 'x.md');
    expect(unseenPaths(PROJECT_ID, USER_ID).has('x.md')).toBe(false);
    expect(unseenPaths(PROJECT_ID, USER_ID).has('gone.md')).toBe(false);
    // A second user has no seen rows: x.md is unseen for them.
    querySync("INSERT INTO users (id, email) VALUES (2, 'two@kuhn.local')");
    expect(unseenPaths(PROJECT_ID, 2).has('x.md')).toBe(true);
    // No identity → no flags.
    expect(unseenPaths(PROJECT_ID, null).size).toBe(0);
  });

  it("round-trips a 'moved' event's meta and leaves other kinds' meta null (story 012-002)", () => {
    recordFileEvent(PROJECT_ID, { path: 'a.md', kind: 'create' });
    recordFileEvent(PROJECT_ID, {
      path: 'archive/a.md', kind: 'moved', meta: { from: 'a.md' }, agentSlug: 'writer',
    });
    const events = listFileActivity(PROJECT_ID);
    // path is always the NEW path; meta.from carries the old one.
    expect(events[0]).toMatchObject({
      path: 'archive/a.md', kind: 'moved', meta: { from: 'a.md' }, agent_slug: 'writer',
    });
    expect(events[1].meta).toBeNull();
  });

  it('degrades unparseable meta to null rather than throwing', () => {
    recordFileEvent(PROJECT_ID, { path: 'a.md', kind: 'update' });
    querySync("UPDATE file_events SET meta = '{not json' WHERE project_id = $1", [PROJECT_ID]);
    expect(listFileActivity(PROJECT_ID)[0].meta).toBeNull();
  });

  it('attributes reviewer events and joins the reviewer name (epic 013)', () => {
    const linkId = querySync(
      `INSERT INTO review_links
         (project_id, path, mode, token_hash, created_by, reviewer_name, claimed_at, expires_at)
       VALUES ($1, 'draft/main.md', 'edit', 'hash-1', $2, 'Jane',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '2999-01-01T00:00:00.000Z')
       RETURNING id`,
      [PROJECT_ID, USER_ID],
    ).rows[0].id;

    recordFileEvent(PROJECT_ID, { path: 'draft/main.md', kind: 'update', reviewLinkId: linkId });
    recordFileEvent(PROJECT_ID, { path: 'draft/main.md', kind: 'update', userId: USER_ID });

    const [member, reviewer] = listFileActivity(PROJECT_ID);
    expect(member).toMatchObject({ review_link_id: null, reviewer_name: null, user_id: USER_ID });
    expect(reviewer).toMatchObject({
      review_link_id: linkId, reviewer_name: 'Jane', user_id: null, kind: 'update',
    });
  });

  it("a 'moved' event marks the new path unseen (renamed = changed)", () => {
    markSeen(USER_ID, PROJECT_ID, 'archive/a.md');
    ageSeenRow('archive/a.md');
    recordFileEvent(PROJECT_ID, { path: 'archive/a.md', kind: 'moved', meta: { from: 'a.md' } });
    expect(unseenPaths(PROJECT_ID, USER_ID).has('archive/a.md')).toBe(true);
  });

  it('migrates seen paths on rename, including directory subtrees', () => {
    markSeen(USER_ID, PROJECT_ID, 'a.md');
    markSeen(USER_ID, PROJECT_ID, 'dir/b.md');
    markSeen(USER_ID, PROJECT_ID, 'directive.md'); // prefix look-alike, no slash

    migrateSeenPaths(PROJECT_ID, 'a.md', 'c.md');
    migrateSeenPaths(PROJECT_ID, 'dir', 'archive/dir2');

    const { rows } = querySync(
      'SELECT path FROM file_seen WHERE project_id = $1 ORDER BY path', [PROJECT_ID],
    );
    expect(rows.map((r) => r.path)).toEqual(['archive/dir2/b.md', 'c.md', 'directive.md']);
  });
});

describe('hub persistence (publishProjectEvent → file_events)', () => {
  it('persists file_change events exactly once, with agent and jobId', () => {
    const event = { type: 'file_change', agent: 'ra', path: 'refs.bib', kind: 'update' };
    publishProjectEvent(PROJECT_ID, event, { jobId: null });
    publishProjectEvent(PROJECT_ID, event); // forwarded again — deduped
    const events = listFileActivity(PROJECT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ path: 'refs.bib', kind: 'update', agent_slug: 'ra' });
  });

  it('stamps the acting user when supplied, NULL otherwise (story 007-001)', () => {
    publishProjectEvent(PROJECT_ID, { type: 'file_change', path: 'up.md', kind: 'create' }, { userId: USER_ID });
    publishProjectEvent(PROJECT_ID, { type: 'file_change', path: 'anon.md', kind: 'create' });
    const byPath = Object.fromEntries(listFileActivity(PROJECT_ID).map((e) => [e.path, e.user_id]));
    expect(byPath).toEqual({ 'up.md': USER_ID, 'anon.md': null });
  });

  it('ignores non-file events and survives a failing insert', () => {
    publishProjectEvent(PROJECT_ID, { type: 'text', agent: 'pm', content: 'hi' });
    expect(listFileActivity(PROJECT_ID)).toHaveLength(0);
    // Unknown project: FK rejects the insert; publish must not throw.
    expect(() =>
      publishProjectEvent(99999, { type: 'file_change', path: 'x', kind: 'create' }),
    ).not.toThrow();
  });
});
