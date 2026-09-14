/**
 * Tenancy hooks on the job lifecycle (issue #118 stage 1, threat T-28).
 *
 * Org suspension and membership removal used to stop only NEW dispatch; a
 * run already in flight kept mutating files and spending budget until its
 * natural end. Now the responsible route calls cancelTenantJobs: the cancel
 * flag is persisted on every open job of the tenant (so a run this process
 * cannot signal still stops at its next control point), then every live run
 * this process owns is aborted through its RunHandle. Routes import this
 * module, not the runtime — it pulls in no provider code.
 */

import { cancelJobsWhere } from '../db/jobs.js';
import { getRun } from './runs.js';
import { log } from '../logger.js';

/**
 * @param {{ orgId: number, userId?: number|null, projectId?: number|null }} where
 * @param {'suspended'|'removed'|'deleted'} reason
 * @returns {Promise<{ flagged: number, aborted: number }>}
 */
export async function cancelTenantJobs(where, reason) {
  const rows = await cancelJobsWhere(where, reason);
  const roots = new Set(rows.map((r) => r.root_job_id ?? r.id));
  let aborted = 0;
  for (const rootId of roots) {
    const run = getRun(rootId);
    if (run?.cancel && await run.cancel(reason)) aborted += 1;
  }
  if (rows.length > 0 || aborted > 0) {
    log.info('tenant_jobs_cancelled', { ...where, reason, flagged: rows.length, aborted });
  }
  return { flagged: rows.length, aborted };
}
