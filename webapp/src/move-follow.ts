// Story 012-004: the move-follow decision logic, extracted so its
// interleavings can be unit-tested. The hosts (editor.ts, main.ts) import the
// entire Milkdown/collab stack and keep this state module-private, which made
// the 4002 branch untestable in isolation — this module is the same behaviour
// over a narrow host interface, and the hosts are thin adapters onto it. The
// WHY of every rule lives here; the hosts' comments point back.

import { movedPath } from './tree-state';

// ---- Resolving a 4002 close reason (editor.ts followMovedRoom) --------------

/** What resolveMovedRoom needs from the editor. All reads are live — the
 * resolution awaits a network read and must notice the world changing. */
export interface MovedRoomHost {
  projectId(): number;
  currentPath(): string;
  /** Read a project file; null/throw = not readable. */
  readTextFile(projectId: number, path: string): Promise<string | null>;
  cancelPendingSave(): void;
  /** Park the tab: "moved — reload to continue" (editor.ts strandMovedDocument). */
  strand(): void;
  /** Follow the document to its new path (the main.ts leg when wired). */
  retarget(path: string): void | Promise<void>;
}

/**
 * Resolve a 4002 (room moved) close into a retarget. The close reason is the
 * only retarget signal that survives a dropped project feed, so we act on it —
 * but never blindly: a target we cannot read back (a folder's path, a stale or
 * blanked reason) would otherwise be conjured into existence by the next save,
 * so it parks the tab instead.
 *
 * The pending-save debounce is cancelled BEFORE the first await: until the new
 * path is known, a save could only land on the path that just went away.
 */
export async function resolveMovedRoom(host: MovedRoomHost, reason: string): Promise<void> {
  const projectId = host.projectId();
  const from = host.currentPath();
  host.cancelPendingSave();
  const next = reason.trim();
  if (!next || next === from) {
    host.strand();
    return;
  }
  let exists = false;
  try {
    exists = (await host.readTextFile(projectId, next)) != null;
  } catch {
    exists = false;
  }
  // The feed (or another 4002) got there first while we were reading — the
  // world moved on and acting on a stale verdict would fight the winner.
  if (host.projectId() !== projectId || host.currentPath() !== from) return;
  if (!exists) {
    host.strand();
    return;
  }
  await host.retarget(next);
}

// ---- Performing a retarget (editor.ts retargetDocument) ---------------------

/** What performRetarget needs from the editor. */
export interface RetargetHost {
  /** Move the editor's notion of "the open path". Rule 1: called first. */
  setCurrentPath(path: string): void;
  /** Reflect the new path in chrome (status line, breadcrumb). */
  announce(path: string): void;
  /** The unsaved buffer, or null when clean. Read AFTER the path moves. */
  pendingMarkdown(): string | null;
  cancelPendingSave(): void;
  /** The tab knows where its document went — leave the parked state. */
  clearMovedAway(): void;
  /** Persist the buffer now (to the CURRENT path — which rule 1 just moved). */
  flushSave(): Promise<void>;
  /** Full reopen at `path`: fresh Y.Doc, fresh provider, `restore` re-applied
   * over the room's replay once it syncs. */
  reopen(path: string, restore: string | null): Promise<void>;
}

/**
 * Follow the open document to `path` after it moved out from under us. Two
 * rules, both load-bearing:
 *
 * 1. Retarget FIRST, decide clean/dirty SECOND. The autosave debounce can fire
 *    between the fs rename and this signal arriving, so the current path moves
 *    before anything else is evaluated — an in-flight save then lands on the
 *    new path instead of resurrecting the old one.
 * 2. Never leave the tab offline. The 4002 handler disconnected the provider
 *    for good and the reopen is the only site that builds one — it is also
 *    what gives the new room a FRESH Y.Doc (mutating a provider's room name
 *    would carry the stale lineage across: the 2× duplicate-doc merge hazard,
 *    docs/data-pipeline.md).
 *
 * Unsaved edits ride across twice over: flushed to the new path up front, and
 * re-applied over the room's replay via `restore`.
 */
export async function performRetarget(host: RetargetHost, path: string): Promise<void> {
  host.setCurrentPath(path); // rule 1 — before anything reads it
  host.announce(path);
  const pending = host.pendingMarkdown();
  host.cancelPendingSave();
  host.clearMovedAway();
  if (pending != null) await host.flushSave();
  await host.reopen(path, pending);
}

// ---- Deciding what a 'moved' project event means (main.ts) ------------------

export type MovedDocAction =
  | { kind: 'none' }
  /** The event arrived without its old path (a lossy channel) — computing a
   * target would be a guess, so inspect the tree instead (followMoveBlind). */
  | { kind: 'follow-blind' }
  | { kind: 'retarget'; to: string };

/**
 * What a `moved` file event means for the open document. Pure: the prefix
 * arithmetic is the same movedPath every other path-keyed consumer re-keys
 * with, so a folder move retargets a descendant to its OWN new path.
 */
export function movedDocAction(
  open: string | null,
  change: { path: string; from?: string | null },
): MovedDocAction {
  if (!open) return { kind: 'none' };
  if (!change.from) return { kind: 'follow-blind' };
  const next = movedPath(open, change.from, change.path);
  return next != null ? { kind: 'retarget', to: next } : { kind: 'none' };
}
