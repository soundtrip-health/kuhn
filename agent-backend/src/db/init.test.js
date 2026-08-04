import { beforeAll, describe, expect, it } from 'vitest';

// Real in-memory SQLite (file-activity.test.js pattern) — the migration SQL is
// the substance. Must be set before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

let db; let exec; let querySync;
let applyColumnMigrations; let applyFileEventsKindMigration;

const columns = (table) =>
  querySync(`SELECT name FROM pragma_table_info('${table}')`).rows.map((r) => r.name);

beforeAll(async () => {
  ({ db, exec, querySync } = await import('../db.js'));
  ({ applyColumnMigrations, applyFileEventsKindMigration } = await import('./init.js'));
  // Pre-007-001 shapes: the tables exist (so schema.sql's CREATE IF NOT EXISTS
  // skips them on a real upgrade) but lack the user_id column. `projects` is
  // stubbed too: file_events' outbound FK targets are what the 012-002 rebuild
  // re-validates while copying rows.
  exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, agent_slug TEXT NOT NULL);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, role TEXT NOT NULL, input TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, role TEXT NOT NULL);
    CREATE TABLE file_events (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL);
    -- Epic 013: schema.sql creates review_links BEFORE applyColumnMigrations
    -- runs, so the FK targets of the new columns always exist by then.
    CREATE TABLE review_links (id INTEGER PRIMARY KEY);
    INSERT INTO conversations (agent_slug) VALUES ('pm');
    INSERT INTO projects (id, name) VALUES (1, 'P');
    INSERT INTO file_events (project_id, path, kind) VALUES (1, 'draft/main.md', 'update');
  `);
});

describe('applyColumnMigrations (story 007-001)', () => {
  it('adds user_id to existing tables, leaving prior rows NULL, and is idempotent', () => {
    applyColumnMigrations();
    for (const table of ['conversations', 'jobs', 'messages', 'file_events']) {
      expect(columns(table)).toContain('user_id');
    }
    // Unattributable history stays NULL — no fake backfill.
    const { rows } = querySync('SELECT user_id FROM conversations');
    expect(rows).toEqual([{ user_id: null }]);

    // Second run: nothing to add, no duplicate-column error.
    expect(() => applyColumnMigrations()).not.toThrow();
    expect(columns('jobs').filter((c) => c === 'user_id')).toHaveLength(1);
  });

  it('adds the epic 013 reviewer-attribution columns', () => {
    applyColumnMigrations();
    expect(columns('comments')).toEqual(
      expect.arrayContaining(['review_link_id', 'resolved_by_link_id']),
    );
    expect(columns('file_events')).toContain('review_link_id');
  });
});

describe('applyFileEventsKindMigration (story 012-002)', () => {
  it("rebuilds a legacy file_events so kind 'moved' is accepted, preserving rows", () => {
    applyColumnMigrations();          // adds user_id + meta + review_link_id
    applyFileEventsKindMigration();   // rebuilds it for the widened CHECK

    expect(columns('file_events')).toContain('meta');
    // The migration-order trap (epic 013): applyColumnMigrations runs FIRST,
    // so the rebuild DDL must carry review_link_id or the rebuild drops it.
    expect(columns('file_events')).toContain('review_link_id');
    expect(querySync('SELECT id, path, kind FROM file_events').rows).toEqual([
      { id: 1, path: 'draft/main.md', kind: 'update' },
    ]);

    querySync(
      'INSERT INTO file_events (project_id, path, kind, meta) VALUES ($1, $2, $3, $4)',
      [1, 'archive/main.md', 'moved', '{"from":"draft/main.md"}'],
    );
    const { rows } = querySync("SELECT path, meta FROM file_events WHERE kind = 'moved'");
    expect(rows).toEqual([{ path: 'archive/main.md', meta: '{"from":"draft/main.md"}' }]);

    // The rebuild drops the old table, so both indexes must be re-created.
    const indexes = querySync(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'file_events'",
    ).rows.map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_file_events_project_path', 'idx_file_events_project_time',
    ]));
  });

  it('is a no-op on a second run and restores foreign-key enforcement', () => {
    const before = querySync('SELECT COUNT(*) AS n FROM file_events').rows[0].n;
    expect(() => applyFileEventsKindMigration()).not.toThrow();
    expect(querySync('SELECT COUNT(*) AS n FROM file_events').rows[0].n).toBe(before);
    // The pragma is toggled OFF around the copy (it is a no-op inside a
    // transaction) and must come back ON — db.js enables it at startup.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
