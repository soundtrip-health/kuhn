// Structured logging (STH-51). Every record goes to two sinks:
//   - console (the familiar dev stream), as one compact JSON line
//   - an append-only NDJSON audit file, one per UTC day, under config.log.dir
// The file stream is the durable audit trail for how output artifacts are
// generated: agent job lifecycle, per-turn context-window state, every file
// event (including 'proposed' suggestions, which never reach the DB), and the
// PI's accept/reject decisions. DB tables like file_events are pruned per
// project; these files are never pruned by Kuhn.
// Logging must never break the operation it records: serialization and sink
// failures are swallowed (after one console warning for a dead file sink).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// Optional chaining: tests mock config.js with partial shapes; a missing
// config.log means defaults (info level, no file sink).
const threshold = LEVELS[config.log?.level] ?? LEVELS.info;

let fileSinkBroken = false;
let currentDay = null;
let currentPath = null;

function auditPath(now) {
  const day = now.toISOString().slice(0, 10);
  if (day !== currentDay) {
    mkdirSync(config.log.dir, { recursive: true });
    currentDay = day;
    currentPath = join(config.log.dir, `kuhn-${day}.ndjson`);
  }
  return currentPath;
}

/** Errors don't JSON.stringify usefully; flatten the parts that matter. */
function plain(value) {
  if (value instanceof Error) {
    return {
      message: value.message,
      ...(value.code != null ? { code: value.code } : {}),
      ...(value.status != null ? { status: value.status } : {}),
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  return value;
}

function emit(level, event, fields = {}) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
  const now = new Date();
  const record = { ts: now.toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = plain(value);
  }
  let line;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, event, unserializable: true });
  }
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[method](line);
  if (fileSinkBroken || !config.log?.dir) return;
  try {
    appendFileSync(auditPath(now), line + '\n');
  } catch (err) {
    fileSinkBroken = true;
    console.error(`[logger] audit file sink failed (${err.message}); continuing console-only`);
  }
}

export const log = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
