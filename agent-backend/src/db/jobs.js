import { query } from '../db.js';
import { getHistory } from './conversation.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Parse a job row's JSON context column (TEXT in SQLite) to an object. */
function parseJob(row) {
  if (row && typeof row.context === 'string') {
    row.context = JSON.parse(row.context);
  }
  return row;
}

/**
 * Create a job record for an agent task.
 * @param {object} job
 * @param {string} job.role - Agent role slug (pm, writer, ra, ...)
 * @param {number|null} job.projectId
 * @param {string} job.input - User message or dispatch instruction
 * @param {object|null} job.context - Optional editor context (selection, cursor, files)
 * @param {number|null} job.parentJobId - Set when dispatched by another agent
 * @param {number|null} job.userId - Whose request ran this job (story 007-001);
 *   sub-jobs inherit the parent's user
 * @returns {Promise<object>} The inserted job row
 */
export async function createJob({ role, projectId = null, input, context = null, parentJobId = null, userId = null }) {
  const { rows } = await query(
    `INSERT INTO jobs (role, project_id, input, context, parent_job_id, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [role, projectId, input, context ? JSON.stringify(context) : null, parentJobId, userId],
  );
  return parseJob(rows[0]);
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
    `UPDATE jobs SET ${sets.join(', ')}, updated_at = ${NOW}
     WHERE id = $${params.length}
     RETURNING *`,
    params,
  );
  return parseJob(rows[0]);
}

/** @returns {Promise<object|undefined>} */
export async function getJob(jobId) {
  const { rows } = await query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  return parseJob(rows[0]);
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
     WHERE ($1 IS NULL OR project_id = $1)
       AND ($2 IS NULL OR status = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [projectId, status, limit],
  );
  return rows.map(parseJob);
}

/**
 * Full account of a job for audit/debugging (issue #42): the job row, its
 * conversation messages (tool calls, tool results with error flags), and
 * recursively the sub-agent jobs it dispatched. maxDepth bounds recursion well
 * above the runtime's dispatch-depth limit.
 * @returns {Promise<object|undefined>} { ...job, messages, children: [trace] }
 */
export async function getJobTrace(jobId, { maxDepth = 5 } = {}) {
  const job = await getJob(jobId);
  if (!job) return undefined;
  return buildTrace(job, maxDepth);
}

async function buildTrace(job, depth) {
  const messages = job.conversation_id != null
    ? await getHistory(job.conversation_id, { limit: 500 })
    : [];
  if (depth <= 0) return { ...job, messages, children: [] };
  const { rows } = await query(
    'SELECT * FROM jobs WHERE parent_job_id = $1 ORDER BY created_at ASC, id ASC',
    [job.id],
  );
  const children = [];
  for (const row of rows) children.push(await buildTrace(parseJob(row), depth - 1));
  return { ...job, messages, children };
}

/**
 * Mark jobs left in 'pending' or 'running' by a previous process as
 * 'interrupted'. Called once at startup so crashed tasks become resumable
 * records instead of phantom running jobs.
 * @returns {Promise<number>} Number of jobs marked
 */
export async function markOrphanedJobsInterrupted() {
  const { rowCount } = await query(
    `UPDATE jobs SET status = 'interrupted', updated_at = ${NOW}
     WHERE status IN ('pending', 'running')`,
  );
  return rowCount;
}
