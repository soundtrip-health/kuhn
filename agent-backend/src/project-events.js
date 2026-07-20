// Story 005-001: in-process, per-project event hub. Fans agent/job events out
// to any number of live subscribers (the project SSE feed), independent of the
// job-scoped stream that produced them — so a reloaded tab, a collaborator, or
// a background run still reaches every watcher.
//
// Publish sites (keep this list honest):
//   - EventChannel tee on every top-level runAgentTask (runtime.js) — fires at
//     push time, so detached runs (parked on a question, browser gone) still
//     reach the feed. Sub-agent runs (depth > 0) are NOT teed; dispatch_agent
//     forwards their events into the parent channel, which is.
//   - Job-start marker published directly after createJob (runtime.js).
//   - The seed route wraps runSeedPipeline with teeProjectEvents for the
//     pipeline's own stage markers / status-file event (routes/projects.js).
// The WeakSet dedupe below makes overlapping sites safe: an event object is
// published at most once no matter how many paths carry it.

import { config } from './config.js';
import { recordFileEvent } from './db/file-activity.js';
import { commitNow, scheduleCommit } from './history.js';
import { evictRoom } from './yjs-websocket.js';

/** @type {Map<number, Set<(event: object) => void>>} */
const subscribers = new Map();
const seen = new WeakSet();

/**
 * Register a listener for a project's events.
 * @returns {(() => void) | null} unsubscribe, or null if the per-project
 *   subscriber cap is reached (caller should 503).
 */
export function subscribeProjectEvents(projectId, listener) {
  const key = Number(projectId);
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  if (set.size >= config.projectEvents.maxSubscribers) return null;
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) subscribers.delete(key);
  };
}

/**
 * Deliver an event to a project's subscribers, wrapped in a stable envelope
 * ({ ...event, jobId?, ts }). Idempotent per event object: forwarding paths
 * (dispatch_agent → parent channel, seed-route tee) can safely re-offer an
 * event that a tee already published.
 */
export function publishProjectEvent(projectId, event, { jobId, userId } = {}) {
  if (event == null || typeof event !== 'object') return;
  if (seen.has(event)) return;
  seen.add(event);
  // Persist file activity here — the one point every file_change crosses,
  // with or without live subscribers (story 005-002). Failure must never
  // break event delivery or the emitting run. `userId` attributes the event
  // (story 007-001): the acting user for UI mutations, the requesting user
  // for agent runs (supplied by the channel tee).
  if (event.type === 'file_change' && event.path) {
    try {
      recordFileEvent(Number(projectId), {
        path: event.path,
        kind: event.kind,
        agentSlug: event.agent ?? null,
        jobId: event.jobId ?? jobId ?? null,
        userId: userId ?? null,
      });
    } catch (err) {
      console.error('[project-events] Failed to persist file event:', err);
    }
    // Evict any in-memory collab room for this path (story 038): a stale room
    // inside its empty-room grace window would otherwise win over the bytes
    // just written to storage when the file is next opened. This is the same
    // single choke point as the activity log — every delete/upload/agent write
    // crosses it; the editor's own autosave PUT deliberately does not.
    try {
      evictRoom(`project-${Number(projectId)}/${event.path}`, {
        closeConnections: event.kind === 'delete',
      });
    } catch (err) {
      console.error('[project-events] Failed to evict collab room:', err);
    }
    // Version history (story 008-002): coalesce this change into the
    // project's next auto-commit. Same choke-point rationale as above;
    // scheduleCommit never throws.
    scheduleCommit(Number(projectId), { agent: event.agent ?? null, userId: userId ?? null });
  }
  // Agent job boundaries get their own labeled version (story 008-002): a
  // top-level run finishing (or failing) commits whatever it left behind.
  if ((event.type === 'done' || event.type === 'error') && event.jobId != null && event.agent) {
    void commitNow(Number(projectId), {
      agent: event.agent,
      label: `${event.agent} ${event.type === 'done' ? 'finished' : 'stopped'} (job ${event.jobId})`,
    });
  }
  const set = subscribers.get(Number(projectId));
  if (!set || set.size === 0) return;
  const envelope = {
    ...event,
    ...(event.jobId == null && jobId != null ? { jobId } : {}),
    ts: new Date().toISOString(),
  };
  for (const listener of [...set]) {
    try {
      listener(envelope);
    } catch (err) {
      console.error('[project-events] Subscriber threw; dropping event for it:', err);
    }
  }
}

/**
 * Pass-through generator that offers every yielded event to the hub. Used by
 * the seed route for pipeline-level events that never cross a teed channel.
 * `userId` attributes any file_change among them (story 007-001).
 */
export async function* teeProjectEvents(projectId, events, { userId } = {}) {
  for await (const event of events) {
    publishProjectEvent(projectId, event, { userId });
    yield event;
  }
}

/** Test hook: current subscriber count for a project. */
export function projectSubscriberCount(projectId) {
  return subscribers.get(Number(projectId))?.size ?? 0;
}

// ---- Org-scoped hub (story 006-002) -------------------------------------------
// Same fan-out contract, keyed by org instead of project. Used for org-library
// ingestion status (`doc_status` events); no persistence hook and no dedupe —
// org events are published from exactly one site each.

/** @type {Map<number, Set<(event: object) => void>>} */
const orgSubscribers = new Map();

/** @returns {(() => void) | null} unsubscribe, or null when over the cap. */
export function subscribeOrgEvents(orgId, listener) {
  const key = Number(orgId);
  let set = orgSubscribers.get(key);
  if (!set) {
    set = new Set();
    orgSubscribers.set(key, set);
  }
  if (set.size >= config.projectEvents.maxSubscribers) return null;
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) orgSubscribers.delete(key);
  };
}

export function publishOrgEvent(orgId, event) {
  const set = orgSubscribers.get(Number(orgId));
  if (!set || set.size === 0) return;
  const envelope = { ...event, ts: new Date().toISOString() };
  for (const listener of [...set]) {
    try {
      listener(envelope);
    } catch (err) {
      console.error('[project-events] Org subscriber threw; dropping event for it:', err);
    }
  }
}
