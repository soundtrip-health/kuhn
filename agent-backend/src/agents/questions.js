/**
 * Pending ask_user questions, keyed by job id (story 012). The ask_user tool
 * handler blocks on waitForReply(); POST /api/agent/jobs/:id/reply resolves it
 * via deliverReply(). The timeout — and cancelQuestion() on task teardown —
 * guarantee the registry never leaks a waiter when no reply arrives.
 */

const pending = new Map(); // jobId -> { resolve, timer, question, agent }

/**
 * Wait for the user's reply to a question asked by the given job.
 * @param {number} jobId
 * @param {number} timeoutMs
 * @param {object} [meta] - { question, agent } stored so a reconnecting
 *   consumer can re-render the pending question card (story 027).
 * @returns {Promise<string|null>} The reply, or null on timeout/cancellation
 */
export function waitForReply(jobId, timeoutMs, meta = {}) {
  cancelQuestion(jobId); // a job asks one question at a time
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(jobId);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    pending.set(jobId, { resolve, timer, question: meta.question, agent: meta.agent });
  });
}

/**
 * The text and asking agent of a job's currently-pending question, or null.
 * Used to re-emit the question to a reconnecting stream (story 027).
 * @returns {{ question: string, agent: string } | null}
 */
export function getPendingQuestion(jobId) {
  const waiter = pending.get(jobId);
  if (!waiter) return null;
  return { question: waiter.question ?? '', agent: waiter.agent };
}

/**
 * Deliver the user's reply to a waiting job.
 * @returns {boolean} false when the job has no pending question
 */
export function deliverReply(jobId, reply) {
  const waiter = pending.get(jobId);
  if (!waiter) return false;
  pending.delete(jobId);
  clearTimeout(waiter.timer);
  waiter.resolve(reply);
  return true;
}

/** Unblock a pending question without a reply (task cancelled/disconnected). */
export function cancelQuestion(jobId) {
  const waiter = pending.get(jobId);
  if (!waiter) return;
  pending.delete(jobId);
  clearTimeout(waiter.timer);
  waiter.resolve(null);
}

export function hasPendingQuestion(jobId) {
  return pending.has(jobId);
}
