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
//
// The hub is also the move seam (story 012-002): a `moved` file_change routes
// to applyMove() instead of recordFileEvent, so re-keying every path-keyed
// consumer and announcing the move share one transaction. It is the only kind
// whose persistence failure is NOT swallowed — see the branch below.

import { config } from './config.js';
import { recordFileEvent } from './db/file-activity.js';
import { applyMove } from './db/move-paths.js';
import { revokeLinksUnder } from './db/review-links.js';
import { commitNow, scheduleCommit } from './history.js';
import {
  CLOSE_LINK_REVOKED, CLOSE_ROOM_MOVED,
  closeReviewerConnections, closeReviewerOnlyRoom,
  evictRoom, evictRoomsUnder,
  plantMoveTombstone, clearMoveTombstonesUnder,
} from './yjs-websocket.js';

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
  // Proposed suggestions (story 008-001) are pending-review markers, not real
  // writes: skip the activity log (kind CHECK constraint), the room eviction,
  // and the version-history commit — SSE fan-out only, so open tabs re-fetch
  // their pending-edit badges/decorations.
  if (event.type === 'file_change' && event.path && event.kind !== 'proposed') {
    const pid = Number(projectId);
    // Story 012-002: a move is an identity change, not a write. Its whole DB
    // side is applyMove(), which re-keys every path-keyed consumer AND appends
    // the file_events row in one transaction — so this branch must never also
    // call recordFileEvent, or the announcement would outlive its rewrite.
    // `moved` is the ONE kind whose persistence failure is not swallowed: the
    // fs rename has already committed by the time we get here, so a silently
    // rolled-back applyMove leaves comments/pending edits/seen markers stranded
    // at a path that no longer exists while the feed reports success. The throw
    // propagates to the producer (REST route / agent move_file), the only place
    // that can compensate by renaming back. Every other kind keeps the
    // deliberate swallow: a lost activity row must not break event delivery.
    let movedFrom = null;
    let movedTo = event.path;
    if (event.kind === 'moved') {
      if (typeof event.meta?.from !== 'string' || event.meta.from === '') {
        seen.delete(event);
        throw new Error("[project-events] a 'moved' event requires meta.from (the old path)");
      }
      let applied;
      try {
        applied = applyMove(pid, event.meta.from, event.path, {
          agentSlug: event.agent ?? null,
          jobId: event.jobId ?? jobId ?? null,
          userId: userId ?? null,
        });
      } catch (err) {
        // Nothing was persisted, nothing was evicted, nobody was told: take the
        // event back out of the dedupe set so the producer can retry it.
        seen.delete(event);
        throw err;
      }
      // Prefer the canonical paths the transaction actually operated on over
      // the ones the producer sent (applyMove normalizes './a', 'a//b', 'a/').
      movedFrom = applied?.from ?? event.meta.from;
      movedTo = applied?.to ?? event.path;
    } else {
      try {
        recordFileEvent(pid, {
          path: event.path,
          kind: event.kind,
          agentSlug: event.agent ?? null,
          jobId: event.jobId ?? jobId ?? null,
          userId: userId ?? null,
        });
      } catch (err) {
        console.error('[project-events] Failed to persist file event:', err);
      }
    }
    // Epic 013: a deleted document takes its review links with it — a file
    // delete revokes the links at that path, a folder delete its subtree's,
    // and every revoked credential's live sockets are closed. This is a
    // CREDENTIAL operation, so it does not inherit the deliberate swallow
    // below (a lost activity row is cosmetic; a link that survives its
    // document is a live secret pointing at nothing — or at whatever is
    // created there next). Its own try/catch keeps a revocation failure loud
    // and unmistakable without breaking event delivery, and runs BEFORE the
    // fan-out so no subscriber acts on a delete while its links still work.
    // Moves never come through here: applyMove re-keys review_links.path
    // inside its own transaction.
    if (event.kind === 'delete') {
      try {
        const revoked = revokeLinksUnder(pid, event.path);
        for (const linkId of revoked) {
          closeReviewerConnections(linkId, {
            code: CLOSE_LINK_REVOKED,
            reason: 'Document removed',
          });
        }
      } catch (err) {
        console.error(
          `[project-events] REVIEW LINK REVOCATION FAILED for delete of '${event.path}' `
            + `(project ${pid}) — external review links under this path may still be live `
            + `and must be revoked manually:`,
          err,
        );
      }
    }
    // Evict any in-memory collab room for this path (story 038): a stale room
    // inside its empty-room grace window would otherwise win over the bytes
    // just written to storage when the file is next opened. This is the same
    // single choke point as the activity log — every delete/upload/agent write
    // crosses it; the editor's own autosave PUT deliberately does not.
    // Always AFTER the DB write and BEFORE the fan-out below, so no client can
    // act on the event while its old room is still joinable.
    try {
      if (movedFrom !== null) {
        // Story 012-002: the old room — and, for a folder move, every room
        // under it — is named for a path that no longer exists, so it dies
        // WITH its clients: 4002 plus the new path tells them to re-open there
        // instead of treating the document as deleted.
        // The reason is computed PER ROOM: on a folder move each descendant
        // must be told its own new path, not the folder's. `project-7/dir/a.md`
        // evicted under prefix `project-7/dir` moving to `archive/dir` gets
        // `archive/dir/a.md` — the same prefix arithmetic the SQL rewrite does.
        const oldPrefix = `project-${pid}/${movedFrom}`;
        evictRoomsUnder(oldPrefix, {
          closeConnections: true,
          closeCode: CLOSE_ROOM_MOVED,
          closeReason: (name) => movedTo + name.slice(oldPrefix.length),
        });
        // The destination is evicted the same way, NOT idle-only: a room can be
        // live at a path with no file behind it (the editor seeds a template
        // when the read 404s), and that client would keep its stale content and
        // autosave it over the bytes just moved in — story 038's hazard in
        // reverse. Kicking it makes it re-seed from storage.
        evictRoomsUnder(`project-${pid}/${movedTo}`, {
          closeConnections: true,
          closeCode: CLOSE_ROOM_MOVED,
          closeReason: movedTo,
        });
        // Story 012-004: eviction only reaches rooms that are live right now.
        // The tombstone catches the rest — a non-compliant reconnect, or a
        // descendant room that was idle at eviction time — and bounces them
        // with the same 4002 + new-path verdict. (It also un-tombstones the
        // destination, which makes a move back inside the window joinable.)
        plantMoveTombstone(oldPrefix, movedTo);
      } else {
        evictRoom(`project-${pid}/${event.path}`, {
          closeConnections: event.kind === 'delete',
        });
        // Epic 013 (brief decision 3): a real write landing at a path whose
        // room is held ONLY by reviewers must not diverge silently — and that
        // stale room must not clobber the accepted edit when a reviewer's
        // provider re-syncs. Close those reviewer sockets with the
        // reconnectable refresh code so reconnect re-seeds from storage.
        // No-op when the room has any member connection (their SSE feed
        // reconciles, story 038 semantics) or when evictRoom above already
        // dropped it (delete closed everyone; idle rooms are gone).
        if (event.kind !== 'delete') {
          closeReviewerOnlyRoom(`project-${pid}/${event.path}`);
        }
        // A fresh file event at a tombstoned path proves the path is live
        // again (a new file created at the old name): stop bouncing joins.
        clearMoveTombstonesUnder(`project-${pid}/${event.path}`);
      }
    } catch (err) {
      console.error('[project-events] Failed to evict collab room:', err);
    }
    // Version history (story 008-002): coalesce this change into the
    // project's next auto-commit. Same choke-point rationale as above;
    // scheduleCommit never throws.
    scheduleCommit(pid, { agent: event.agent ?? null, userId: userId ?? null });
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
