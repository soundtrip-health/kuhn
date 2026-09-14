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
export const COLUMN_MIGRATIONS = [
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
  // Issue #65: catalog link on imported knowledge documents. Nullable —
  // uploads/promotions stay NULL.
  { table: 'org_documents', column: 'catalog_item_id', ddl: 'TEXT' },
  { table: 'org_documents', column: 'catalog_item_version', ddl: 'INTEGER' },
  // STH-47: effective runtime identity per job (provider/model that ran it).
  // Nullable — pre-migration rows stay NULL.
  { table: 'jobs', column: 'provider', ddl: 'TEXT' },
  { table: 'jobs', column: 'model', ddl: 'TEXT' },
  // STH-47: canonical continuation persisted after a run, so a follow-up
  // (and a rollback to another runtime) resumes provider-neutrally.
  { table: 'jobs', column: 'continuation', ddl: 'TEXT' },
  // Context-meter fix: last-turn prompt size per job (input_tokens is
  // cumulative throughput and overstates context). Default 0 = unknown for
  // pre-migration rows; the webapp leaves the meter unseeded for those.
  { table: 'jobs', column: 'context_tokens', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  // Issue #110: hand-off note captured at a budget pause. Nullable — runs
  // that ended any other way, and pre-migration rows, stay NULL.
  { table: 'jobs', column: 'handoff', ddl: 'TEXT' },
  // Issue #129 item 3: which budget paused the run, beside the note.
  { table: 'jobs', column: 'pause', ddl: 'TEXT' },
  // Issue #110: spend ledger for org budgets. Pre-migration rows count 0.
  { table: 'jobs', column: 'weighted_tokens', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  // Issue #107/#112: model-routing diagnostics on the job row.
  { table: 'jobs', column: 'profile', ddl: 'TEXT' },
  { table: 'jobs', column: 'endpoint', ddl: 'TEXT' },
  // Typst templates: Word reference documents for docx export. Nullable —
  // templates without one export with Pandoc's stock reference.
  { table: 'catalog_typst_templates', column: 'docx_path', ddl: 'TEXT' },
  { table: 'org_typst_templates', column: 'docx', ddl: 'BLOB' },
  { table: 'jobs', column: 'difficulty', ddl: 'REAL' },
  { table: 'jobs', column: 'route_source', ddl: 'TEXT' },
  // Issue #113 item 1: the chat a top-level run belongs to. Nullable —
  // sub-agent, compose, seeding and pre-migration rows stay NULL. Safe to
  // ALTER: chats is created by schema.sql before this runs, and SQLite only
  // checks the reference on writes.
  { table: 'jobs', column: 'chat_id', ddl: 'INTEGER REFERENCES chats(id) ON DELETE SET NULL' },
  // Issue #118 stage 1: durable job lifecycle columns. All nullable or
  // defaulted; pre-migration rows carry NULL root_job_id (a self-reference
  // backfill follows in applyJobsStatusMigration).
  { table: 'jobs', column: 'root_job_id', ddl: 'INTEGER REFERENCES jobs(id) ON DELETE SET NULL' },
  { table: 'jobs', column: 'worker_id', ddl: 'TEXT' },
  { table: 'jobs', column: 'lease_until', ddl: 'TEXT' },
  { table: 'jobs', column: 'heartbeat_at', ddl: 'TEXT' },
  { table: 'jobs', column: 'attempt', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'jobs', column: 'cancel_requested_at', ddl: 'TEXT' },
  { table: 'jobs', column: 'cancel_reason', ddl: 'TEXT' },
  { table: 'jobs', column: 'waiting_since', ddl: 'TEXT' },
  { table: 'jobs', column: 'wake_at', ddl: 'TEXT' },
  { table: 'jobs', column: 'deadline_at', ddl: 'TEXT' },
  { table: 'jobs', column: 'budget_used', ddl: 'INTEGER NOT NULL DEFAULT 0' },
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

// Issue #133: model_profiles.provider gained 'google'. CHECK constraints
// cannot be ALTERed, so an existing database needs the documented table
// rebuild. Keep this DDL byte-compatible with model_profiles in schema.sql.
const MODEL_PROFILES_NEW_DDL = `
  CREATE TABLE model_profiles_new (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id            INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug              TEXT NOT NULL,
    name              TEXT NOT NULL,
    provider          TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'openrouter', 'google', 'openai-compatible')),
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
  )`;

const MODEL_PROFILES_COLUMNS = [
  'id', 'org_id', 'slug', 'name', 'provider', 'model_id', 'base_url', 'credential_secret',
  'capabilities', 'cost_weight', 'data_policy', 'enabled', 'created_by', 'created_at', 'updated_at',
];

/** The provider list the current schema's CHECK must carry (issue #133). */
export const MODEL_PROFILE_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'google', 'openai-compatible'];

/**
 * Rebuild model_profiles so its provider CHECK accepts every provider the
 * store knows (issue #133 added 'google'). Same 12-step ALTER discipline as
 * the rebuilds above: foreign_keys toggled OUTSIDE the transaction, since the
 * table carries outbound FKs (org_id, created_by) that SQLite re-validates
 * while copying. Idempotent: runs only when the live DDL lacks a provider.
 */
export function applyModelProfilesProviderMigration() {
  const { rows } = querySync(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_profiles'",
  );
  const currentDdl = rows[0]?.sql;
  if (!currentDdl || MODEL_PROFILE_PROVIDERS.every((p) => currentDdl.includes(`'${p}'`))) return;

  const [{ foreign_keys: fkEnabled }] = db.pragma('foreign_keys');
  db.pragma('foreign_keys = OFF');
  try {
    transaction(() => {
      const present = new Set(
        querySync("SELECT name FROM pragma_table_info('model_profiles')").rows.map((r) => r.name),
      );
      const cols = MODEL_PROFILES_COLUMNS.filter((c) => present.has(c)).join(', ');
      querySync(MODEL_PROFILES_NEW_DDL);
      querySync(`INSERT INTO model_profiles_new (${cols}) SELECT ${cols} FROM model_profiles`);
      querySync('DROP TABLE model_profiles');
      querySync('ALTER TABLE model_profiles_new RENAME TO model_profiles');
    });
    const violations = db.pragma('foreign_key_check');
    if (violations.length) {
      throw new Error(`model_profiles rebuild left ${violations.length} foreign key violation(s)`);
    }
    console.log(`[db] Migrated: model_profiles rebuilt for providers ${MODEL_PROFILE_PROVIDERS.join(', ')}.`);
  } finally {
    db.pragma(`foreign_keys = ${fkEnabled ? 'ON' : 'OFF'}`);
  }
}

// Issue #106: projects.project_type lost its CHECK — document types are an
// extensible catalog now (db/doc-types.js), validated at the API boundary.
// A CHECK cannot be dropped in place, so an existing database gets the same
// table rebuild as above. Keep this DDL byte-compatible with projects in
// schema.sql.
const PROJECTS_NEW_DDL = `
  CREATE TABLE projects_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id      TEXT NOT NULL DEFAULT 'default',
    org_id        INTEGER REFERENCES organizations(id) ON DELETE RESTRICT,
    name          TEXT NOT NULL,
    project_type  TEXT NOT NULL,
    config        TEXT NOT NULL DEFAULT '{}',
    root_path     TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`;

const PROJECTS_COLUMNS = [
  'id', 'owner_id', 'org_id', 'name', 'project_type', 'config', 'root_path', 'created_at', 'updated_at',
];

const PROJECTS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id)',
  'CREATE INDEX IF NOT EXISTS idx_projects_org   ON projects(org_id)',
];

/**
 * Rebuild projects without the project_type CHECK (issue #106). Idempotent:
 * runs only when the live DDL still carries `project_type IN (...)`. Same
 * 12-step ALTER discipline as the rebuilds above — foreign_keys toggled
 * OUTSIDE the transaction because projects carries an outbound FK (org_id)
 * and is the parent of many tables (jobs, conversations, file_events, …)
 * whose rows SQLite would otherwise re-validate as the old table drops.
 */
export function applyProjectTypeCheckMigration() {
  const { rows } = querySync(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
  );
  const currentDdl = rows[0]?.sql;
  if (!currentDdl || !/project_type\s+IN\s*\(/i.test(currentDdl)) return;

  const [{ foreign_keys: fkEnabled }] = db.pragma('foreign_keys');
  db.pragma('foreign_keys = OFF');
  try {
    transaction(() => {
      const present = new Set(
        querySync("SELECT name FROM pragma_table_info('projects')").rows.map((r) => r.name),
      );
      const cols = PROJECTS_COLUMNS.filter((c) => present.has(c)).join(', ');
      querySync(PROJECTS_NEW_DDL);
      querySync(`INSERT INTO projects_new (${cols}) SELECT ${cols} FROM projects`);
      querySync('DROP TABLE projects');
      querySync('ALTER TABLE projects_new RENAME TO projects');
      for (const ddl of PROJECTS_INDEXES) querySync(ddl);
    });
    const violations = db.pragma('foreign_key_check');
    if (violations.length) {
      throw new Error(`projects rebuild left ${violations.length} foreign key violation(s)`);
    }
    console.log('[db] Migrated: projects rebuilt without the project_type CHECK (issue #106).');
  } finally {
    db.pragma(`foreign_keys = ${fkEnabled ? 'ON' : 'OFF'}`);
  }
}

// Issue #118 stage 1: jobs.status gained queued / waiting_for_user /
// retry_wait and retired 'pending'. CHECK constraints cannot be ALTERed, so
// an existing database gets the same table rebuild as above. Keep this DDL
// byte-compatible with jobs in schema.sql (every COLUMN_MIGRATIONS column
// included — the rebuild runs after applyColumnMigrations).
const JOBS_NEW_DDL = `
  CREATE TABLE jobs_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id       INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id  INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    parent_job_id    INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    role             TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                       'queued', 'running', 'waiting_for_user', 'retry_wait',
                       'done', 'error', 'interrupted', 'cancelled'
                     )),
    input            TEXT NOT NULL,
    context          TEXT,
    session_id       TEXT,
    provider         TEXT,
    model            TEXT,
    continuation     TEXT,
    error            TEXT,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    context_tokens   INTEGER NOT NULL DEFAULT 0,
    handoff          TEXT,
    pause            TEXT,
    weighted_tokens  INTEGER NOT NULL DEFAULT 0,
    profile          TEXT,
    endpoint         TEXT,
    difficulty       REAL,
    route_source     TEXT,
    chat_id          INTEGER REFERENCES chats(id) ON DELETE SET NULL,
    root_job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    worker_id        TEXT,
    lease_until      TEXT,
    heartbeat_at     TEXT,
    attempt          INTEGER NOT NULL DEFAULT 0,
    cancel_requested_at TEXT,
    cancel_reason    TEXT,
    waiting_since    TEXT,
    wake_at          TEXT,
    deadline_at      TEXT,
    budget_used      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`;

const JOBS_COLUMNS = [
  'id', 'project_id', 'conversation_id', 'parent_job_id', 'user_id', 'role', 'status', 'input',
  'context', 'session_id', 'provider', 'model', 'continuation', 'error', 'input_tokens',
  'output_tokens', 'context_tokens', 'handoff', 'pause', 'weighted_tokens', 'profile', 'endpoint',
  'difficulty', 'route_source', 'chat_id', 'root_job_id', 'worker_id', 'lease_until',
  'heartbeat_at', 'attempt', 'cancel_requested_at', 'cancel_reason', 'waiting_since', 'wake_at',
  'deadline_at', 'budget_used', 'created_at', 'updated_at',
];

/** The job states the current schema's CHECK must carry (issue #118). */
export const JOB_STATUSES = ['queued', 'running', 'waiting_for_user', 'retry_wait', 'done', 'error', 'interrupted', 'cancelled'];

/**
 * Rebuild jobs so its status CHECK carries the #118 lifecycle states,
 * mapping the retired 'pending' to 'queued', and backfill root_job_id for
 * pre-migration rows (a top-level job is its own root; a sub-job takes its
 * parent's root, walking up to the dispatch depth limit). Idempotent: runs
 * only when the live DDL lacks a state. Same 12-step discipline as above.
 */
export function applyJobsStatusMigration() {
  const { rows } = querySync("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'");
  const currentDdl = rows[0]?.sql;
  if (!currentDdl) return;
  const present = new Set(querySync("SELECT name FROM pragma_table_info('jobs')").rows.map((r) => r.name));
  if (!present.has('root_job_id')) return; // partial-stub test databases
  if (!JOB_STATUSES.every((st) => currentDdl.includes(`'${st}'`))) {
    const [{ foreign_keys: fkEnabled }] = db.pragma('foreign_keys');
    db.pragma('foreign_keys = OFF');
    try {
      transaction(() => {
        const cols = JOBS_COLUMNS.filter((c) => present.has(c));
        const select = cols.map((c) => (c === 'status' ? "CASE status WHEN 'pending' THEN 'queued' ELSE status END AS status" : c)).join(', ');
        querySync(JOBS_NEW_DDL);
        querySync(`INSERT INTO jobs_new (${cols.join(', ')}) SELECT ${select} FROM jobs`);
        querySync('DROP TABLE jobs');
        querySync('ALTER TABLE jobs_new RENAME TO jobs');
        // schema.sql's own jobs indexes went with the dropped table; the
        // migrated-column ones are recreated by applyJobsIndexMigration.
        querySync('CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at DESC)');
        querySync('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)');
      });
      const violations = db.pragma('foreign_key_check');
      if (violations.length) {
        throw new Error(`jobs rebuild left ${violations.length} foreign key violation(s)`);
      }
      console.log(`[db] Migrated: jobs rebuilt for statuses ${JOB_STATUSES.join(', ')} (issue #118).`);
    } finally {
      db.pragma(`foreign_keys = ${fkEnabled ? 'ON' : 'OFF'}`);
    }
  }
  // root_job_id backfill: top-level rows first, then descend one level per
  // pass until no open-ended child remains (bounded by the dispatch depth).
  const { rowCount: roots } = querySync('UPDATE jobs SET root_job_id = id WHERE root_job_id IS NULL AND parent_job_id IS NULL');
  let filled = roots;
  for (let pass = 0; pass < 8; pass++) {
    const { rowCount } = querySync(
      `UPDATE jobs SET root_job_id = (SELECT p.root_job_id FROM jobs p WHERE p.id = jobs.parent_job_id)
        WHERE root_job_id IS NULL AND parent_job_id IS NOT NULL
          AND (SELECT p.root_job_id FROM jobs p WHERE p.id = jobs.parent_job_id) IS NOT NULL`,
    );
    filled += rowCount;
    if (rowCount === 0) break;
  }
  // Orphans whose parent row is gone (ON DELETE SET NULL) are their own root.
  const { rowCount: orphans } = querySync('UPDATE jobs SET root_job_id = id WHERE root_job_id IS NULL');
  filled += orphans;
  if (filled > 0) console.log(`[db] Migrated: root_job_id backfilled on ${filled} job row(s) (issue #118).`);
}

/**
 * Issue #65: partial unique index over migrated columns. schema.sql cannot
 * carry it — on an existing database exec(schemaSql) runs BEFORE
 * applyColumnMigrations(), and an index over a not-yet-added column would
 * abort the whole schema script. Created here, after the columns exist, on
 * both the fresh and the migrated path.
 */
export function applyKnowledgeIndexMigration() {
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_docs_org_catalog
          ON org_documents(org_id, catalog_item_id) WHERE catalog_item_id IS NOT NULL`);
}

/**
 * Indexes over migrated jobs columns (issue #110 user_id, issue #113 chat_id, issue #118 root_job_id):
 * they cannot live in schema.sql, which runs BEFORE applyColumnMigrations on
 * an upgrade — a CREATE INDEX over a column that does not exist yet aborts the
 * boot (that is how #113 broke `npm run db:seed` on a pre-#113 database).
 * Idempotent; skips partial stub tables that lack the columns.
 */
export function applyJobsIndexMigration() {
  const have = new Set(querySync("SELECT name FROM pragma_table_info('jobs')").rows.map((r) => r.name));
  if (!have.has('created_at')) return; // partial-stub test databases
  if (have.has('user_id')) exec('CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at)');
  if (have.has('chat_id')) exec('CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs(chat_id, created_at DESC)');
  if (have.has('root_job_id')) exec('CREATE INDEX IF NOT EXISTS idx_jobs_root ON jobs(root_job_id)');
}

/** Add any COLUMN_MIGRATIONS entries missing from an existing database. */
export function applyColumnMigrations() {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    const { rows } = querySync(`SELECT name FROM pragma_table_info('${table}')`);
    // No table at all → nothing to migrate (real boots run schema.sql first,
    // so this only happens in partial-stub test databases).
    if (rows.length === 0) continue;
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
  applyModelProfilesProviderMigration();
  applyProjectTypeCheckMigration();
  applyJobsStatusMigration();
  applyKnowledgeIndexMigration();
  applyJobsIndexMigration();
  console.log('[db] Schema applied.');

  // Seed default tenant, agents, tools, and assignments.
  await seed();

  // After seed so the default user row exists before the flag sync.
  syncSuperadmins(config.auth.superadminEmails);
}
