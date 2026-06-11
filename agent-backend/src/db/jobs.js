import { query } from '../db.js';

/**
 * Create a job record for an agent task.
 * @param {object} job
 * @param {string} job.role - Agent role slug (pm, writer, ra, ...)
 * @param {number|null} job.projectId
 * @param {string} job.input - User message or dispatch instruction
 * @param {object|null} job.context - Optional editor context (selection, cursor, files)
 * @param {number|null} job.parentJobId - Set when dispatched by another agent
 * @returns {Promise<object>} The inserted job row
 */
export async function createJob({ role, projectId = null, input, context = null, parentJobId = null }) {
  const { rows } = await query(
    `INSERT INTO jobs (role, project_id, input, context, parent_job_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [role, projectId, input, context ? JSON.stringify(context) : null, parentJobId],
  );
  return rows[0];
}

/**
 * Update mutable job fields. Only provided keys are changed.
 * @param {number} jobId
 * @param {object} fields
 * @param {string} [fields.status]
 * @param {number} [fields.conversationId]
 * @param {string} [fields.sessionId]
 * @param {string} [fields.error]
 * @param {number} [fields.inputTokens]
 * @param {number} [fields.outputTokens]
 * @returns {Promise<object|undefined>} The updated job row
 */
export async function updateJob(jobId, fields) {
  const columns = {
    status: 'status',
    conversationId: 'conversation_id',
    sessionId: 'session_id',
    error: 'error',
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
  };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (sets.length === 0) return getJob(jobId);
  params.push(jobId);
  const { rows } = await query(
    `UPDATE jobs SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length}
     RETURNING *`,
    params,
  );
  return rows[0];
}

/** @returns {Promise<object|undefined>} */
export async function getJob(jobId) {
  const { rows } = await query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  return rows[0];
}

/**
 * List jobs, newest first, optionally filtered by project and/or status.
 * @param {object} [opts]
 * @param {number} [opts.projectId]
 * @param {string} [opts.status]
 * @param {number} [opts.limit=50]
 * @returns {Promise<object[]>}
 */
export async function listJobs({ projectId = null, status = null, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT * FROM jobs
     WHERE ($1::integer IS NULL OR project_id = $1)
       AND ($2::varchar IS NULL OR status = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [projectId, status, limit],
  );
  return rows;
}

/**
 * Mark jobs left in 'pending' or 'running' by a previous process as
 * 'interrupted'. Called once at startup so crashed tasks become resumable
 * records instead of phantom running jobs.
 * @returns {Promise<number>} Number of jobs marked
 */
export async function markOrphanedJobsInterrupted() {
  const { rowCount } = await query(
    `UPDATE jobs SET status = 'interrupted', updated_at = now()
     WHERE status IN ('pending', 'running')`,
  );
  return rowCount;
}
