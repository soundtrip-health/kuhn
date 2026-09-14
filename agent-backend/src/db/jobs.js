import { query } from '../db.js';
import { getHistory } from './conversation.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Parse a job row's JSON columns (TEXT in SQLite) to objects. */
function parseJob(row) {
  if (row && typeof row.context === 'string') {
    row.context = JSON.parse(row.context);
  }
  if (row && typeof row.continuation === 'string') {
    row.continuation = JSON.parse(row.continuation);
  }
  if (row && typeof row.pause === 'string') {
    row.pause = JSON.parse(row.pause);
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
 * @param {string|null} [job.provider] - Effective runtime provider (STH-47)
 * @param {string|null} [job.model] - Effective runtime model (STH-47)
 * @param {object|null} [job.continuation] - Canonical continuation envelope (STH-47)
 * @param {number|null} [job.chatId] - The chat this top-level run belongs to
 *   (issue #113); null for sub-agent, compose and seeding runs
 * @returns {Promise<object>} The inserted job row
 */
export async function createJob({ role, projectId = null, input, context = null, parentJobId = null, userId = null, provider = null, model = null, continuation = null, chatId = null, rootJobId = null, deadlineAt = null }) {
  const { rows } = await query(
    `INSERT INTO jobs (role, project_id, input, context, parent_job_id, user_id, provider, model, continuation, chat_id, root_job_id, deadline_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [role, projectId, input, context ? JSON.stringify(context) : null, parentJobId, userId, provider, model, continuation ? JSON.stringify(continuation) : null, chatId, rootJobId, deadlineAt],
  );
  const job = parseJob(rows[0]);
  if (job && rootJobId == null) {
    // A top-level job is its own root (issue #118): one row to query the
    // tree by, one row that carries the tree's budget.
    const { rows: rooted } = await query(
      'UPDATE jobs SET root_job_id = id WHERE id = $1 RETURNING *',
      [job.id],
    );
    return parseJob(rooted[0] ?? { ...job, root_job_id: job.id });
  }
  return job;
}

/** Job states that are not terminal (issue #118). */
export const OPEN_JOB_STATUSES = ['queued', 'running', 'waiting_for_user', 'retry_wait'];
const OPEN_LIST = OPEN_JOB_STATUSES.map((st) => `'${st}'`).join(', ');

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
 * @param {string|null} [fields.provider] - Effective runtime provider (STH-47)
 * @param {string|null} [fields.model] - Effective runtime model (STH-47)
 * @param {object|null} [fields.continuation] - Canonical continuation envelope (STH-47)
 * @param {number} [fields.contextTokens] - last turn's prompt size (STH-52 meter)
 * @param {string|null} [fields.handoff] - hand-off note written at a budget pause (issue #110)
 * @param {{ scope: string, period?: string, resetsAt?: string }|null} [fields.pause] - which budget paused the run (issue #129)
 * @param {number} [fields.weightedTokens] - cost-weighted tokens for the org budget ledger (issue #110)
 * @param {string|null} [fields.profile] - the model profile the route selected (issue #107)
 * @param {string|null} [fields.endpoint] - the provider endpoint the job egressed to (issue #112)
 * @param {number|null} [fields.difficulty] - the 0..1 difficulty the route was resolved for (issue #107)
 * @param {'org'|'deployment'|null} [fields.routeSource] - what picked the profile: an org route or the deployment default
 * @param {string|null} [fields.cancelReason] - why the run was (or is being) cancelled (issue #118)
 * @param {string|null} [fields.cancelRequestedAt] - when the cancel flag was raised
 * @param {string|null} [fields.workerId] - the process that ran the job
 * @param {number} [fields.attempt] - how many times the job has been (re)claimed
 * @param {number} [fields.budgetUsed] - weighted budget consumed by the tree (root row)
 * @param {string|null} [fields.waitingSince] - set while waiting_for_user
 * @param {string|null} [fields.wakeAt] - when a retry_wait job retries
 * @param {string|null} [fields.deadlineAt] - wall-clock bound of the run
 * @param {string|null} [fields.leaseUntil]
 * @param {string|null} [fields.heartbeatAt]
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
    provider: 'provider',
    model: 'model',
    continuation: 'continuation',
    contextTokens: 'context_tokens',
    handoff: 'handoff',
    pause: 'pause',
    weightedTokens: 'weighted_tokens',
    profile: 'profile',
    endpoint: 'endpoint',
    difficulty: 'difficulty',
    routeSource: 'route_source',
    cancelReason: 'cancel_reason',
    cancelRequestedAt: 'cancel_requested_at',
    workerId: 'worker_id',
    attempt: 'attempt',
    budgetUsed: 'budget_used',
    waitingSince: 'waiting_since',
    wakeAt: 'wake_at',
    deadlineAt: 'deadline_at',
    leaseUntil: 'lease_until',
    heartbeatAt: 'heartbeat_at',
  };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] !== undefined) {
      params.push((column === 'continuation' || column === 'pause') && fields[key] != null ? JSON.stringify(fields[key]) : fields[key]);
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
     WHERE status IN (${OPEN_LIST})`,
  );
  return rowCount;
}

// ---- Persisted cancellation (issue #118 stage 1) ----------------------------
//
// Control is persisted first, signalled second: the flag lands on every open
// row of the tree, then whoever owns the run in-process aborts it. A run
// consults the flag at its control points (runtime.js createRunGate), so a
// cancel that arrives while the process cannot be signalled (another
// worker, a restart) is still honoured at the next turn or tool call.

/**
 * Raise the cancel flag on every open job of a tree. The first reason wins.
 * @param {number} rootJobId
 * @param {'user'|'suspended'|'removed'|'deleted'|'deadline'|'parent'|'disconnect'|'shutdown'} reason
 * @returns {Promise<number>} rows flagged
 */
export async function requestJobCancel(rootJobId, reason) {
  const { rowCount } = await query(
    `UPDATE jobs SET cancel_requested_at = ${NOW}, cancel_reason = COALESCE(cancel_reason, $2), updated_at = ${NOW}
     WHERE (root_job_id = $1 OR id = $1) AND status IN (${OPEN_LIST}) AND cancel_requested_at IS NULL`,
    [rootJobId, reason],
  );
  return rowCount;
}

/**
 * Raise the cancel flag on a tenant's open jobs: every job of an org, or of
 * one member within it (membership removal). Returns the affected rows so
 * the caller can abort the ones this process owns (agents/tenancy.js).
 * @param {{ orgId: number, userId?: number|null, projectId?: number|null }} where
 * @param {'suspended'|'removed'|'deleted'} reason
 * @returns {Promise<Array<{ id: number, root_job_id: number|null, project_id: number|null }>>}
 */
export async function cancelJobsWhere({ orgId, userId = null, projectId = null }, reason) {
  const { rows } = await query(
    `UPDATE jobs SET cancel_requested_at = ${NOW}, cancel_reason = COALESCE(cancel_reason, $1), updated_at = ${NOW}
     WHERE status IN (${OPEN_LIST}) AND cancel_requested_at IS NULL
       AND project_id IN (SELECT id FROM projects WHERE org_id = $2 AND ($4 IS NULL OR id = $4))
       AND ($3 IS NULL OR user_id = $3)
     RETURNING id, root_job_id, project_id`,
    [reason, orgId, userId, projectId],
  );
  return rows;
}

/**
 * The persisted cancel flag of a job, for the run's control points.
 * @returns {Promise<{ requestedAt: string, reason: string|null } | null>}
 */
export async function getCancelRequest(jobId) {
  const { rows } = await query('SELECT cancel_requested_at, cancel_reason FROM jobs WHERE id = $1', [jobId]);
  const row = rows[0];
  if (!row?.cancel_requested_at) return null;
  return { requestedAt: row.cancel_requested_at, reason: row.cancel_reason ?? null };
}
