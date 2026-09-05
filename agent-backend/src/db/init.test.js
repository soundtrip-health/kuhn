import { beforeAll, describe, expect, it } from 'vitest';

// Real in-memory SQLite (file-activity.test.js pattern) — the migration SQL is
// the substance. Must be set before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

let db; let exec; let querySync;
let applyColumnMigrations; let applyFileEventsKindMigration; let applyMembershipsRoleMigration;
let applyModelProfilesProviderMigration;

const columns = (table) =>
  querySync(`SELECT name FROM pragma_table_info('${table}')`).rows.map((r) => r.name);

beforeAll(async () => {
  ({ db, exec, querySync } = await import('../db.js'));
  ({ applyColumnMigrations, applyFileEventsKindMigration, applyMembershipsRoleMigration, applyModelProfilesProviderMigration } =
    await import('./init.js'));
  // Pre-007-001 shapes: the tables exist (so schema.sql's CREATE IF NOT EXISTS
  // skips them on a real upgrade) but lack the user_id column. `projects` is
  // stubbed too: file_events' outbound FK targets are what the 012-002 rebuild
  // re-validates while copying rows. memberships carries the LEGACY role CHECK
  // ('owner','member') so the 010-003 rebuild has real work to do.
  exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE memberships (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (user_id, org_id)
    );
    CREATE INDEX idx_memberships_user ON memberships(user_id);
    CREATE INDEX idx_memberships_org  ON memberships(org_id);
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
    INSERT INTO users (id, email) VALUES (1, 'owner@lab.org'), (2, 'member@lab.org');
    INSERT INTO organizations (id, name, slug) VALUES (1, 'Lab', 'lab');
    INSERT INTO memberships (user_id, org_id, role) VALUES (1, 1, 'owner'), (2, 1, 'member');
    -- Issue #133: the pre-google model_profiles CHECK, with one org profile.
    CREATE TABLE model_profiles (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id            INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      slug              TEXT NOT NULL,
      name              TEXT NOT NULL,
      provider          TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'openrouter', 'openai-compatible')),
      model_id          TEXT NOT NULL,
      base_url          TEXT,
      credential_secret TEXT,
      capabilities      TEXT NOT NULL DEFAULT '{}',
      cost_weight       REAL NOT NULL DEFAULT 5,
      data_policy       TEXT,
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (org_id, slug)
    );
    INSERT INTO model_profiles (org_id, slug, name, provider, model_id, credential_secret, capabilities, cost_weight, created_by)
      VALUES (1, 'gpt-mini', 'GPT mini', 'openai', 'gpt-5-mini', 'openai-api-key', '{"contextWindow":100000}', 0.25, 1);
  `);
});

describe('applyModelProfilesProviderMigration (issue #133)', () => {
  it("rebuilds a pre-google model_profiles so provider 'google' is accepted, preserving rows", () => {
    expect(() => querySync(
      "INSERT INTO model_profiles (org_id, slug, name, provider, model_id, credential_secret) VALUES (1, 'gem', 'Gemini', 'google', 'gemini-2.5-flash', 'gemini-api-key')",
    )).toThrow(/CHECK constraint failed/);

    applyModelProfilesProviderMigration();

    expect(querySync('SELECT id, slug, provider, model_id, capabilities, cost_weight, created_by FROM model_profiles').rows).toEqual([
      { id: 1, slug: 'gpt-mini', provider: 'openai', model_id: 'gpt-5-mini', capabilities: '{"contextWindow":100000}', cost_weight: 0.25, created_by: 1 },
    ]);
    querySync(
      "INSERT INTO model_profiles (org_id, slug, name, provider, model_id, credential_secret) VALUES (1, 'gem', 'Gemini', 'google', 'gemini-2.5-flash', 'gemini-api-key')",
    );
    expect(querySync("SELECT slug FROM model_profiles WHERE provider = 'google'").rows).toEqual([{ slug: 'gem' }]);
    // The org-scoped uniqueness survives the rebuild.
    expect(() => querySync(
      "INSERT INTO model_profiles (org_id, slug, name, provider, model_id) VALUES (1, 'gem', 'Dup', 'openai-compatible', 'x')",
    )).toThrow(/UNIQUE/);
    // Still refuses an unknown provider.
    expect(() => querySync(
      "INSERT INTO model_profiles (org_id, slug, name, provider, model_id) VALUES (1, 'zz', 'Z', 'vertex', 'x')",
    )).toThrow(/CHECK constraint failed/);
  });

  it('is a no-op on a second run and restores foreign-key enforcement', () => {
    const before = querySync('SELECT COUNT(*) AS n FROM model_profiles').rows[0].n;
    expect(() => applyModelProfilesProviderMigration()).not.toThrow();
    expect(querySync('SELECT COUNT(*) AS n FROM model_profiles').rows[0].n).toBe(before);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
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

  it('adds the epic 011 tenancy columns with defaults on existing rows', () => {
    applyColumnMigrations();
    expect(columns('users')).toContain('is_superadmin');
    expect(columns('organizations')).toEqual(expect.arrayContaining(['status', 'settings']));
    // Pre-migration rows take the defaults, which satisfy the CHECKs.
    expect(querySync('SELECT is_superadmin FROM users WHERE id = 1').rows)
      .toEqual([{ is_superadmin: 0 }]);
    expect(querySync('SELECT status, settings FROM organizations WHERE id = 1').rows)
      .toEqual([{ status: 'active', settings: '{}' }]);
    expect(() => querySync("UPDATE organizations SET status = 'archived' WHERE id = 1"))
      .toThrow(/CHECK/);
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

describe('applyMembershipsRoleMigration (story 010-003)', () => {
  it("rebuilds legacy memberships: 'member' → 'editor', owners kept, indexes recreated", () => {
    applyMembershipsRoleMigration();

    expect(querySync('SELECT user_id, role FROM memberships ORDER BY user_id').rows).toEqual([
      { user_id: 1, role: 'owner' },
      { user_id: 2, role: 'editor' },
    ]);

    // The rebuild drops the old table, so both indexes must be re-created.
    const indexes = querySync(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memberships'",
    ).rows.map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_memberships_user', 'idx_memberships_org',
    ]));

    // No FK damage, and enforcement is back on.
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it("the widened CHECK accepts 'viewer' and rejects the retired 'member'", () => {
    querySync("INSERT INTO users (id, email) VALUES (3, 'viewer@lab.org')");
    querySync("INSERT INTO memberships (user_id, org_id, role) VALUES (3, 1, 'viewer')");
    expect(querySync('SELECT role FROM memberships WHERE user_id = 3').rows)
      .toEqual([{ role: 'viewer' }]);
    expect(() =>
      querySync("UPDATE memberships SET role = 'member' WHERE user_id = 3"),
    ).toThrow(/CHECK/);
  });

  it('is a no-op on a second run', () => {
    const before = querySync('SELECT COUNT(*) AS n FROM memberships').rows[0].n;
    expect(() => applyMembershipsRoleMigration()).not.toThrow();
    expect(querySync('SELECT COUNT(*) AS n FROM memberships').rows[0].n).toBe(before);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
