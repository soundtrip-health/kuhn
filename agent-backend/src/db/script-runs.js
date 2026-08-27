// Issue #68b: append-only provenance for run_script executions. Synchronous
// (querySync), matching the other db/ modules; recording is non-throwing like
// auth-events — a lost provenance row must never fail the run it records.

import { querySync } from '../db.js';

const TAIL_CHARS = 16 * 1024;

export const tail = (text) => (text && text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text || null);

/**
 * Record one run.
 * @returns {object|null} the inserted row, or null if the insert failed
 */
export function recordScriptRun({
  projectId, jobId = null, orgScriptId = null, scriptVersion = null,
  scriptPath = null, args = [], status, exitCode = null, durationMs = null,
  outputDir = null, stdout = null, stderr = null,
}) {
  try {
    const { rows } = querySync(
      `INSERT INTO script_runs (project_id, job_id, org_script_id, script_version,
                                script_path, args_json, status, exit_code, duration_ms,
                                output_dir, stdout_tail, stderr_tail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [projectId, jobId, orgScriptId, scriptVersion, scriptPath,
        JSON.stringify(args), status, exitCode, durationMs,
        outputDir, tail(stdout), tail(stderr)],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error(`[script-runs] Failed to record run for project ${projectId}: ${err.message}`);
    return null;
  }
}

/** A project's runs, newest first, joined with the org script's slug. */
export function listScriptRuns(projectId, { limit = 50 } = {}) {
  const { rows } = querySync(
    `SELECT r.*, s.slug AS org_script_slug
     FROM script_runs r
     LEFT JOIN org_scripts s ON s.id = r.org_script_id
     WHERE r.project_id = $1
     ORDER BY r.id DESC
     LIMIT $2`,
    [projectId, limit],
  );
  return rows;
}
