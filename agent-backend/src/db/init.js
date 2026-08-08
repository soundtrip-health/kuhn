import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, exec, querySync, transaction } from '../db.js';
import { config } from '../config.js';
import { seed } from './seed.js';
import { syncSuperadmins } from './users.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Columns added after a table first shipped. schema.sql only covers fresh
// databases (CREATE TABLE IF NOT EXISTS skips existing tables), so each entry
// here is ALTERed in when missing — keep the two in sync.
const COLUMN_MIGRATIONS = [
  // Story 007-001: user attribution on content rows (+ the Epic 005 gap on
  // file_events). Nullable — existing rows stay NULL, no fake backfill.
  { table: 'conversations', column: 'user_id', ddl: 'INTEGER REFERENCES users(id) ON DELETE SET NULL' },
  { table: 'jobs', column: 'user_id', ddl: 'INTEGER REFERENCES users(id) ON DELETE SET NULL' },
  { table: 'messages', column: 'user_id', ddl: 'INTEGER REFERENCES users(id) ON DELETE SET NULL' },
  { table: 'file_events', column: 'user_id', ddl: 'INTEGER REFERENCES users(id) ON DELETE SET NULL' },
  // Issue #42: tool-result error flag for log audits. Nullable — non-tool rows
  // and pre-migration history stay NULL.
  { table: 'messages', column: 'is_error', ddl: 'INTEGER' },
  // Story 012-002: JSON sidecar on file events ('moved' stores {"from": ...}).
  { table: 'file_events', column: 'meta', ddl: 'TEXT' },
  // Epic 013: reviewer attribution. Nullable — member rows stay NULL. Safe to
  // ALTER: review_links is created by schema.sql before this runs.
  { table: 'comments', column: 'review_link_id', ddl: 'INTEGER REFERENCES review_links(id) ON DELETE SET NULL' },
  { table: 'comments', column: 'resolved_by_link_id', ddl: 'INTEGER REFERENCES review_links(id) ON DELETE SET NULL' },
  { table: 'file_events', column: 'review_link_id', ddl: 'INTEGER REFERENCES review_links(id) ON DELETE SET NULL' },
  // Epic 011: platform flag + org lifecycle/settings. ALTER ... ADD COLUMN
  // permits CHECK + NOT NULL-with-default; existing rows take the defaults,
  // which satisfy the CHECKs.
  { table: 'users', column: 'is_superadmin', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'organizations', column: 'status',
    ddl: "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'))" },
  { table: 'organizations', column: 'settings', ddl: "TEXT NOT NULL DEFAULT '{}'" },
];

// Story 012-002: file_events.kind gained 'moved'. SQLite cannot ALTER a CHECK
// constraint and applyColumnMigrations only ADDs columns, so an existing
// database needs the documented table rebuild. Keep this DDL byte-compatible
// with the file_events definition in schema.sql.
const FILE_EVENTS_NEW_DDL = `
  CREATE TABLE file_events_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('create', 'update', 'delete', 'rename', 'moved')),
    meta        TEXT,
    agent_slug  TEXT,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    review_link_id INTEGER REFERENCES review_links(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`;

const FILE_EVENTS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_file_events_project_path
     ON file_events(project_id, path, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_file_events_project_time
     ON file_events(project_id, created_at DESC)`,
];

const FILE_EVENTS_COLUMNS = [
  'id', 'project_id', 'path', 'kind', 'meta', 'agent_slug', 'user_id', 'job_id',
  'review_link_id', 'created_at',
];

/**
 * Rebuild file_events so its kind CHECK accepts 'moved' (story 012-002).
 * Follows SQLite's documented 12-step ALTER: foreign_keys must be toggled
 * OUTSIDE the transaction (the pragma is a silent no-op inside one), because
 * file_events carries three OUTBOUND foreign keys — project_id, user_id,
 * job_id — that SQLite re-validates on every row the INSERT ... SELECT copies,
 * and db.js turns enforcement ON unconditionally.
 */
export function applyFileEventsKindMigration() {
  const { rows } = querySync(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'file_events'",
  );
  const currentDdl = rows[0]?.sql;
  // Idempotent: no table yet (schema.sql will create it), or already rebuilt.
  if (!currentDdl || currentDdl.includes("'moved'")) return;

  const [{ foreign_keys: fkEnabled }] = db.pragma('foreign_keys');
  db.pragma('foreign_keys = OFF');
  try {
    transaction(() => {
      // Copy only the columns the old table actually has — a database that
      // predates user_id (or a test stub with a handful of columns) must still
      // migrate. The rest take their DDL defaults.
      const present = new Set(
        querySync("SELECT name FROM pragma_table_info('file_events')").rows.map((r) => r.name),
      );
      const cols = FILE_EVENTS_COLUMNS.filter((c) => present.has(c)).join(', ');
      // One statement per querySync: exec() would open its own transaction and
      // the rebuild would not be atomic.
      querySync(FILE_EVENTS_NEW_DDL);
      querySync(`INSERT INTO file_events_new (${cols}) SELECT ${cols} FROM file_events`);
      querySync('DROP TABLE file_events');
      querySync('ALTER TABLE file_events_new RENAME TO file_events');
      for (const ddl of FILE_EVENTS_INDEXES) querySync(ddl);
    });
    const violations = db.pragma('foreign_key_check');
    if (violations.length) {
      throw new Error(
        `file_events rebuild left ${violations.length} foreign key violation(s)`,
      );
    }
    console.log("[db] Migrated: file_events rebuilt for kind 'moved'.");
  } finally {
    db.pragma(`foreign_keys = ${fkEnabled ? 'ON' : 'OFF'}`);
  }
}

// Story 010-003: memberships.role gained 'editor'/'viewer' (and 'member' rows
// become 'editor'). CHECK constraints cannot be ALTERed, so an existing
// database needs the documented table rebuild. Keep this DDL byte-compatible
// with the memberships definition in schema.sql.
const MEMBERSHIPS_NEW_DDL = `
  CREATE TABLE memberships_new (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, org_id)
  )`;

const MEMBERSHIPS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_memberships_org  ON memberships(org_id)',
];

/**
 * Rebuild memberships so its role CHECK accepts owner/editor/viewer
 * (story 010-003), migrating legacy 'member' rows to 'editor'. Same 12-step
 * ALTER discipline as applyFileEventsKindMigration above: foreign_keys is
 * toggled OUTSIDE the transaction (a silent no-op inside one), because
 * memberships carries two outbound FKs — user_id, org_id — that SQLite
 * re-validates on every row the INSERT ... SELECT copies.
 */
export function applyMembershipsRoleMigration() {
  const { rows } = querySync(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memberships'",
  );
  const currentDdl = rows[0]?.sql;
  // Idempotent: no table yet (schema.sql will create it), or already rebuilt.
  if (!currentDdl || currentDdl.includes("'editor'")) return;

  const [{ foreign_keys: fkEnabled }] = db.pragma('foreign_keys');
  db.pragma('foreign_keys = OFF');
  try {
    transaction(() => {
      // One statement per querySync: exec() would open its own transaction and
      // the rebuild would not be atomic.
      querySync(MEMBERSHIPS_NEW_DDL);
      querySync(
        `INSERT INTO memberships_new (user_id, org_id, role, created_at)
         SELECT user_id, org_id,
                CASE WHEN role = 'member' THEN 'editor' ELSE role END,
                created_at
         FROM memberships`,
      );
      querySync('DROP TABLE memberships');
      querySync('ALTER TABLE memberships_new RENAME TO memberships');
      for (const ddl of MEMBERSHIPS_INDEXES) querySync(ddl);
    });
    const violations = db.pragma('foreign_key_check');
    if (violations.length) {
      throw new Error(
        `memberships rebuild left ${violations.length} foreign key violation(s)`,
      );
    }
    console.log('[db] Migrated: memberships rebuilt for roles owner/editor/viewer.');
  } finally {
    db.pragma(`foreign_keys = ${fkEnabled ? 'ON' : 'OFF'}`);
  }
}

/** Add any COLUMN_MIGRATIONS entries missing from an existing database. */
export function applyColumnMigrations() {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    const { rows } = querySync(`SELECT name FROM pragma_table_info('${table}')`);
    if (!rows.some((r) => r.name === column)) {
      exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      console.log(`[db] Migrated: ${table}.${column} added.`);
    }
  }
}

export async function initDb() {
  // Apply schema DDL (multi-statement script).
  const schemaPath = resolve(__dirname, 'schema.sql');
  const schemaSql = await readFile(schemaPath, 'utf-8');
  exec(schemaSql);
  applyColumnMigrations();
  applyFileEventsKindMigration();
  applyMembershipsRoleMigration();
  console.log('[db] Schema applied.');

  // Seed default tenant, agents, tools, and assignments.
  await seed();

  // After seed so the default user row exists before the flag sync.
  syncSuperadmins(config.auth.superadminEmails);
}
