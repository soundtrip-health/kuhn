import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, querySync } from '../db.js';
import { seed } from './seed.js';

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
];

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
  console.log('[db] Schema applied.');

  // Seed default tenant, agents, tools, and assignments.
  await seed();
}
