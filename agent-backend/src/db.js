// SQLite data access (better-sqlite3). The rest of the codebase was written
// against node-postgres, so this module preserves that surface: an async
// `query(text, params)` returning `{ rows, rowCount }`, with Postgres-style
// `$1, $2` placeholders. We translate those to better-sqlite3 named params and
// pick `.all()` (rows) vs `.run()` (changes) by whether the statement returns
// rows — RETURNING is supported (bundled SQLite ≥ 3.35).

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';

const dbPath = config.db.path;
if (dbPath !== ':memory:') {
  mkdirSync(dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// better-sqlite3 binds only number | bigint | string | Buffer | null. Coerce
// the few other shapes callers pass (Date, boolean) and stringify any stray
// object so a bad bind fails loudly upstream rather than here.
function normalizeParam(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}

// `$1, $2` → `@p1, @p2`, with a bind object so a repeated placeholder ($1 used
// twice) resolves once. Positional params arrive as an array, 1-indexed.
function translate(text, params = []) {
  const sql = text.replace(/\$(\d+)/g, (_, n) => `@p${n}`);
  const bind = {};
  (params ?? []).forEach((value, i) => { bind[`p${i + 1}`] = normalizeParam(value); });
  return { sql, bind };
}

/**
 * Synchronous query primitive (better-sqlite3 is synchronous under the hood).
 * Use inside transaction() bodies, which cannot await. Returns the same
 * `{ rows, rowCount }` shape as query().
 */
export function querySync(text, params) {
  const { sql, bind } = translate(text, params);
  const stmt = db.prepare(sql);
  // `.reader` is true for any row-returning statement, including
  // INSERT/UPDATE ... RETURNING.
  if (stmt.reader) {
    const rows = stmt.all(bind);
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(bind);
  return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
}

export async function query(text, params) {
  return querySync(text, params);
}

/** Run a multi-statement SQL script (DDL / seed). No bind params. */
export function exec(sql) {
  db.exec(sql);
}

/** Run `fn` in a synchronous transaction (rolls back if it throws). */
export function transaction(fn) {
  return db.transaction(fn)();
}

export async function checkConnection() {
  try {
    db.prepare('SELECT 1').get();
    return { ok: true, time: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export { db };
