import { beforeAll, describe, expect, it } from 'vitest';

// Real in-memory SQLite (file-activity.test.js pattern) — the migration SQL is
// the substance. Must be set before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

let exec; let querySync; let applyColumnMigrations;

const columns = (table) =>
  querySync(`SELECT name FROM pragma_table_info('${table}')`).rows.map((r) => r.name);

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ applyColumnMigrations } = await import('./init.js'));
  // Pre-007-001 shapes: the tables exist (so schema.sql's CREATE IF NOT EXISTS
  // skips them on a real upgrade) but lack the user_id column.
  exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, agent_slug TEXT NOT NULL);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, role TEXT NOT NULL, input TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, role TEXT NOT NULL);
    CREATE TABLE file_events (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL);
    INSERT INTO conversations (agent_slug) VALUES ('pm');
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
});
