// The file tree's non-DOM model (story 012-001).
//
// Everything here is pure or touches only `localStorage` — no DOM, no `fetch`,
// no import from `./files`. That is deliberate: `files.ts` is the render +
// action layer and this is the state it renders, so 012-004 can stand vitest
// up against this module without a jsdom tree. Keep it that way.
//
// ---------------------------------------------------------------------------
// localStorage convention (set here — read this before adding another key)
// ---------------------------------------------------------------------------
// The only pre-existing webapp keys are the bare scalars `kuhn-files-width`
// (files.ts) and `kuhn-chat-show-all` (chat.ts), both parsed with `parseInt` /
// `=== '1'`, neither of which can throw. This is the webapp's FIRST
// JSON-valued and FIRST project-scoped key, so it sets three rules:
//
//  1. ONE KEY PER PROJECT — `kuhn-tree-state:<projectId>`. Not a single blob
//     holding every project: a blob needs an eviction policy, and a numeric
//     project id enumerates in ascending numeric order (not insertion order),
//     so "drop the first key" provably evicts the LOWEST project id rather
//     than the least recently used. Per-project keys have no ordering to get
//     wrong and no whole-blob rewrite on every toggle.
//  2. GUARD THE READ, NOT JUST THE WRITE. `initTreeState` runs synchronously
//     inside `switchToActiveProject()` before the tree or the editor exist, so
//     a throw out of module state takes the whole app down with no tree, no
//     editor and no error — recoverable only by clearing localStorage by hand.
//     Every read is `try`/`catch` + shape-validated (`Array.isArray`), and any
//     value that is absent, unparseable, foreign or malformed degrades to
//     fresh in-memory state. Every write is `try`/`catch` so a quota or
//     private-mode failure degrades to in-memory state instead of throwing
//     into a render.
//  3. PERSIST THE COLLAPSED SET, NEVER THE SELECTION. Storing *collapsed*
//     paths means a folder this browser has never seen defaults to OPEN,
//     which preserves the pre-012-001 behaviour (`details.open = true`) and
//     means a just-created or just-uploaded-into folder is already open. The
//     selected folder — the upload / create target — is SESSION state and is
//     re-derived per project load: an invisible target restored from last week
//     silently redirects uploads, which is a different risk class from
//     remembering which twisties were closed.

import type { TreeNode } from './api';

// ---- Path helpers -----------------------------------------------------------

/** Text formats that open in the editor as raw text (issue #44); `.md` opens
 * rich. Everything else is treated as binary and previews instead. */
const TEXT_EXTS = ['md', 'txt', 'bib', 'csv', 'tsv', 'json', 'typ', 'tex', 'yaml', 'yml', 'toml', 'xml', 'log'];

export function isEditableText(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && TEXT_EXTS.includes(path.slice(dot + 1).toLowerCase());
}

/**
 * Is `path` `ancestor` itself, or inside it? The canonical subtree predicate —
 * exact match, or a descendant matched on `ancestor + '/'`. The trailing slash
 * is the whole point: without it `'directive.md'` counts as being under
 * `'dir'`. Client mirror of the server's rule (storage.js:209,
 * db/move-paths.js:157).
 *
 * `ancestor` must be a real entry path. An empty `ancestor` returns false even
 * though the project root does contain everything — callers that mean "the
 * root" (drag destinations, move targets) represent it as `''` and must branch
 * on that explicitly. Returning true here would make an accidentally-empty
 * ancestor silently match every path in the project, which on the delete and
 * purge paths destroys state for the whole tree.
 */
export function isUnder(path: string, ancestor: string): boolean {
  if (!path || !ancestor) return false;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** The containing directory of `path`; `''` at the top level (project root). */
export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** The last segment of `path`. */
export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Build a child path inside `dir`; `dir === ''` means the project root. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The path `path` would have if renamed to `newName` in place (same parent). */
export function renamePath(path: string, newName: string): string {
  return joinPath(parentDir(path), newName);
}

/**
 * Map `path` through a move of `from` → `to`, or null if it isn't affected
 * (story 012-002). Client mirror of the server's subtree predicate: exact
 * match, or a descendant matched on `from + '/'` — the trailing slash is what
 * stops a move of `dir` from dragging `directive.md` along with it.
 */
export function movedPath(path: string, from: string, to: string): string | null {
  if (!path || !from || !to) return null;
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}

// ---- Tree snapshot ----------------------------------------------------------

let lastTree: TreeNode[] = [];

/** A directory in the snapshot, in depth-first tree order. */
export interface DirEntry {
  path: string;
  name: string;
  /** Number of ancestors: 0 for a top-level folder. `aria-level` is depth + 1.
   * A caller that prepends a "Project root" row at depth 0 shifts these by 1. */
  depth: number;
}

/**
 * Adopt a fresh tree snapshot. Also reconciles the state that is keyed by path:
 * a selection whose folder no longer exists falls back to the project root, and
 * collapsed entries for paths that are gone are pruned so the persisted set
 * can't grow without bound. On the first snapshot after `initTreeState`, the
 * session selection is derived (see `selectedDir`).
 */
export function setTree(nodes: TreeNode[]): void {
  lastTree = nodes;
  if (nodes.length === 0) {
    // An empty tree is indistinguishable from a failed/instant-empty refresh;
    // pruning against it would wipe every collapsed entry. Nothing to derive.
    return;
  }
  const dirs = new Set(dirNodes().map((d) => d.path));
  let pruned = false;
  for (const path of [...collapsed]) {
    if (dirs.has(path)) continue;
    collapsed.delete(path);
    pruned = true;
  }
  if (pruned) markDirty();
  if (!selectionDerivedFlag) {
    // Session default, matching the pre-012-001 panel target: `sources/` (where
    // seeding expects user materials) if it exists at the top level, else root.
    selected = nodes.some((n) => n.type === 'dir' && n.name === 'sources') ? 'sources' : '';
    selectionDerivedFlag = true;
  } else if (selected && !dirs.has(selected)) {
    selected = '';
  }
}

/** The current snapshot (the array `setTree` was handed — do not mutate). */
export function tree(): TreeNode[] {
  return lastTree;
}

/** The node at `path`, or null. */
export function findNode(path: string): TreeNode | null {
  if (!path) return null;
  const walk = (nodes: TreeNode[]): TreeNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.type === 'dir' && isUnder(path, node.path)) {
        const hit = walk(node.children ?? []);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(lastTree);
}

/** Every directory in the snapshot, depth-first in tree order. */
export function dirNodes(): DirEntry[] {
  const out: DirEntry[] = [];
  const walk = (nodes: TreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.type !== 'dir') continue;
      out.push({ path: node.path, name: node.name, depth });
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(lastTree, 0);
  return out;
}

/** Depth-first scan over file nodes; returns the first match, else null. */
function findFile(match: (node: TreeNode) => boolean): string | null {
  let hit: string | null = null;
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (hit != null) return;
      if (node.type === 'dir') walk(node.children ?? []);
      else if (match(node)) hit = node.path;
    }
  };
  walk(lastTree);
  return hit;
}

/**
 * Resolve which document to open for the current project (story 006). Returns
 * `preferred` if it's an existing editor-openable file in the tree (the active
 * document can be any text file — issue #44), else the first `.md` found
 * (depth-first), else null. Call after `refreshTree` so the snapshot is current.
 */
export function findMarkdownPath(preferred?: string): string | null {
  if (preferred && findFile((n) => n.path === preferred && isEditableText(n.path)) != null) {
    return preferred;
  }
  return findFile((n) => n.path.endsWith('.md'));
}

/**
 * Resolve the project's bibliography (story 012-001): `preferred` if it still
 * exists in the tree, else the first `.bib` found depth-first, else null. This
 * is what un-hardcodes `draft/references.bib` — once `draft/` or the bib itself
 * can be moved from the UI, a hard-coded path silently 404s and every citation
 * chip degrades to "not found in references.bib".
 */
export function findBibPath(preferred?: string): string | null {
  if (preferred && findFile((n) => n.path === preferred) != null) return preferred;
  return findFile((n) => n.path.endsWith('.bib'));
}

// ---- Persisted expand/collapse ----------------------------------------------

const KEY_PREFIX = 'kuhn-tree-state:';
/** Bumped only if the stored shape changes incompatibly; readers accept any
 * value whose `collapsed` validates, so a bump is not itself breaking. */
const STATE_VERSION = 1;

let currentProject = 0;
/** Paths the user has explicitly collapsed. Absence means OPEN — see rule 3. */
let collapsed = new Set<string>();
let dirty = false;
let flushQueued = false;

const storageKey = (projectId: number): string => `${KEY_PREFIX}${projectId}`;

/** Read + validate. Anything absent, unparseable, foreign or malformed yields
 * a fresh empty set rather than throwing (rule 2). */
function loadCollapsed(projectId: number): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
    const value = (parsed as { collapsed?: unknown }).collapsed;
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((p): p is string => typeof p === 'string' && p.length > 0));
  } catch {
    return new Set();
  }
}

function persist(): void {
  dirty = false;
  if (!currentProject) return;
  try {
    if (collapsed.size === 0) localStorage.removeItem(storageKey(currentProject));
    else {
      localStorage.setItem(
        storageKey(currentProject),
        JSON.stringify({ v: STATE_VERSION, collapsed: [...collapsed] }),
      );
    }
  } catch {
    // Quota exceeded, private mode, storage disabled — degrade to in-memory.
  }
}

/**
 * Coalesce writes to one per task. `renderNodes` fires a `toggle` event for
 * every open `<details>` it builds, so a 60-folder project would otherwise do
 * 60 synchronous `setItem` calls per refresh, four times a second during an
 * agent burst — all on the main thread while the tree is being rebuilt.
 */
function markDirty(): void {
  dirty = true;
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    if (dirty) persist();
  });
}

/** Write any pending state immediately. Exists for tests and for teardown. */
export function flushTreeState(): void {
  if (dirty) persist();
}

/**
 * Load the persisted collapse state for a project and reset the session state.
 * Called from `initFiles` on every project switch. Never throws.
 */
export function initTreeState(projectId: number): void {
  flushTreeState();
  currentProject = projectId;
  collapsed = loadCollapsed(projectId);
  dirty = false;
  lastTree = [];
  selected = '';
  selectionDerivedFlag = false;
}

/** Should this folder render open? Unseen folders default to OPEN (rule 3). */
export function isExpanded(path: string): boolean {
  return !collapsed.has(path);
}

export function setExpanded(path: string, open: boolean): void {
  if (!path) return;
  const had = collapsed.has(path);
  if (open) {
    if (!had) return;
    collapsed.delete(path);
  } else {
    if (had) return;
    collapsed.add(path);
  }
  markDirty();
}

/** Expand every folder containing `path` (used by reveal). Does not expand
 * `path` itself — it may be the file being revealed. */
export function expandAncestors(path: string): void {
  let dir = parentDir(path);
  while (dir) {
    setExpanded(dir, true);
    dir = parentDir(dir);
  }
}

// ---- Session selection (the upload / create target) -------------------------

let selected = '';
let selectionDerivedFlag = false;

/** The folder new uploads and new folders land in; `''` is the project root. */
export function selectedDir(): string {
  return selected;
}

/** Set the target folder. `''` selects the project root. Never persisted. */
export function setSelectedDir(path: string): void {
  selected = path;
  selectionDerivedFlag = true;
}

/** Has the session default been derived yet (i.e. has a non-empty tree landed
 * since `initTreeState`)? False means the tree hasn't loaded, so the target
 * shown in the panel header is provisional. */
export function selectionDerived(): boolean {
  return selectionDerivedFlag;
}

// ---- Re-keying through moves and deletes ------------------------------------

/** Carry the collapse state and the selection through a move of `from` → `to`.
 * Prefix-aware, so a FOLDER move brings its whole subtree's state with it.
 * Call it wherever `migrateStatus` is called. */
export function migrateTreeState(from: string, to: string): void {
  let changed = false;
  for (const path of [...collapsed]) {
    const next = movedPath(path, from, to);
    if (next == null) continue;
    collapsed.delete(path);
    collapsed.add(next);
    changed = true;
  }
  const nextSelected = movedPath(selected, from, to);
  if (nextSelected != null) selected = nextSelected;
  if (changed) markDirty();
}

/** Drop every bit of state under a vanished path. Call it on every delete leg
 * (local delete, the local `file_change` record, and the remote SSE delete) —
 * `setTree`'s reconciliation only runs when a refresh completes, and the
 * selection is read at action time, so an upload clicked inside that window
 * would silently re-create the deleted folder (`writeProjectFile` mkdirs its
 * parent recursively). */
export function purgeTreeState(prefix: string): void {
  if (!prefix) return;
  let changed = false;
  for (const path of [...collapsed]) {
    if (!isUnder(path, prefix)) continue;
    collapsed.delete(path);
    changed = true;
  }
  if (isUnder(selected, prefix)) selected = '';
  if (changed) markDirty();
}

// ---- Badge rollup -----------------------------------------------------------

/** Aggregate counts for a subtree. */
export interface Rollup {
  /** Descendant FILES (not folders). Phantoms are NOT files — a proposal is
   * not on disk, so it must not inflate the "N items" count. */
  files: number;
  /** Descendant files flagged unseen/suggested by the caller's predicate,
   * PLUS phantom proposals beneath this folder. */
  unseen: number;
  /** Summed unresolved comment threads over descendant files. */
  comments: number;
  /** Phantom proposals beneath this folder (also counted in `unseen`).
   * Reported separately because they have no row of their own: an OPEN
   * folder's children display their own badges, but a phantom's badge on the
   * folder is its only representation in the tree. */
  phantoms: number;
}

/** The caller supplies the two path-keyed lookups so this module stays free of
 * `files.ts`'s status/suggest/comment maps. `flagged` MUST be the same
 * predicate the topbar unseen pill uses, or the pill and the folder badges
 * drift. */
export interface RollupProbe {
  flagged(path: string): boolean;
  comments(path: string): number;
}

/**
 * Sum a subtree's flagged descendants so nothing is invisible while a folder is
 * collapsed (012-001 AC 4). The walk covers tree nodes; `phantoms` covers what
 * the tree cannot — proposals for files that do not exist on disk yet
 * (`pending_edits.base_missing`) have no node, and before story 012-005 they
 * were counted by the `#toggle-files` pill (which iterates map keys) but by no
 * folder, so the two numbers visibly disagreed on one screen. A proposed new
 * file is exactly the thing a user must not miss behind a collapsed folder,
 * so the rollup takes those paths separately and counts the ones beneath it.
 */
export function rollup(node: TreeNode, probe: RollupProbe, phantoms: Iterable<string> = []): Rollup {
  const out: Rollup = { files: 0, unseen: 0, comments: 0, phantoms: 0 };
  const walk = (n: TreeNode): void => {
    if (n.type === 'dir') {
      for (const child of n.children ?? []) walk(child);
      return;
    }
    out.files += 1;
    if (probe.flagged(n.path)) out.unseen += 1;
    out.comments += probe.comments(n.path) || 0;
  };
  walk(node);
  const prefix = node.path ? `${node.path}/` : '';
  for (const p of phantoms) {
    if (p.startsWith(prefix)) {
      out.unseen += 1;
      out.phantoms += 1;
    }
  }
  return out;
}
