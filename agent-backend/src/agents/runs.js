/**
 * Live agent-run registry (story 027). A `detachable` run (the POST
 * /api/agent/task chat path) registers itself here once its job exists, so
 * that when the browser disconnects *while parked on an ask_user question* the
 * run can be left alive — its EventChannel keeps buffering — and a fresh SSE
 * consumer can later re-attach via POST /api/agent/jobs/:id/reconnect.
 *
 * Keyed by jobId. The EventChannel is single-consumer, so `consumerAttached`
 * gates re-attachment: the detaching consumer clears it before returning and
 * the reconnect endpoint refuses (409) while it is set.
 *
 * @typedef {object} RunHandle
 * @property {number} jobId
 * @property {number|string|null} projectId
 * @property {string} role               - agent slug, for discovery
 * @property {import('./events.js').EventChannel} channel
 * @property {Promise<void>|null} pump   - the detached run promise
 * @property {object} state              - runtime task state (sdkQuery, finished, job)
 * @property {boolean} consumerAttached  - guards against double-consume of the channel
 */

const runs = new Map(); // jobId -> RunHandle

/** @param {RunHandle} handle */
export function registerRun(handle) {
  runs.set(handle.jobId, handle);
}

/** @returns {RunHandle | undefined} */
export function getRun(jobId) {
  return runs.get(jobId);
}

export function unregisterRun(jobId) {
  if (jobId != null) runs.delete(jobId);
}

/** Live runs for a project, in insertion order. @returns {RunHandle[]} */
export function listLiveRuns(projectId) {
  const pid = projectId != null ? String(projectId) : null;
  return [...runs.values()].filter((r) => pid == null || String(r.projectId) === pid);
}
