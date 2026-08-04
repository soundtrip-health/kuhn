// File panel (story 013 shell, restyled by 025, made functional by story 014,
// made live by story 005-003): render the project tree, upload materials
// (drag-drop + picker), preview non-markdown files, and delete/rename entries
// — all through the story-018 storage API. Badge state is server-backed:
// per-user `unseen` flags on the tree plus the file-activity log hydrate the
// status map on every refresh (so badges survive reload), live `file_change`
// events update it between refreshes, and opening a file marks it seen.
//
// Story 012-001 turns the panel into a real tree: persisted expand/collapse, a
// focusable project-root row that is also the default upload target, folder
// row actions (new folder / move / rename / delete), rolled-up badges on
// collapsed folders, internal drag-and-drop, and the keyboard-safe "Move to…"
// dialog. The non-DOM model lives in `./tree-state`; this module is render +
// actions only.
//
// Three visual channels, deliberately NOT sharing a token, because all three
// can land on one row at once:
//   open document       -> `--accent-soft` FILL   (.file-entry.active)
//   upload/create target-> inset left RULE        (.is-target)
//   drag destination    -> dashed OUTLINE         (.is-drop-target)

import {
  ApiError,
  createFolder,
  deleteFile,
  getCommentCounts,
  getFileActivity,
  getPendingEdits,
  getTree,
  markFileSeen,
  moveFile,
  promoteFileToLibrary,
  uploadFiles,
  type FileActivityEvent,
  type PendingEdit,
  type TreeNode,
} from './api';
import { icon, iconEl, type IconName } from './icons';
import { openMoveDialog, type MoveTarget } from './move-dialog';
import { watchDocIngestion } from './org-library';
import { toast } from './toast';
import {
  baseName,
  dirNodes,
  expandAncestors,
  findNode,
  initTreeState,
  isEditableText,
  isExpanded,
  isUnder,
  joinPath,
  migrateTreeState,
  movedPath,
  parentDir,
  purgeTreeState,
  renamePath,
  rollup,
  selectedDir,
  setExpanded,
  setSelectedDir,
  setTree,
  tree,
  type RollupProbe,
} from './tree-state';
import * as workspace from './workspace';

/** Handlers wired by main.ts (it owns the editor + preview pane). */
export interface FilesHandlers {
  /** Open an editable text file (markdown or plain) in the editor. */
  onOpenMarkdown: (path: string) => void;
  /** Preview a non-markdown file in the preview pane. */
  onPreviewFile: (path: string) => void;
  /** Persist the open document before it is renamed (so edits aren't lost). */
  flushOpenDoc: () => Promise<void> | void;
  /** The open document was deleted — drop it without re-saving. Called with a
   * FOLDER path too (story 012-001), so the handler must match by prefix. */
  dropOpenDoc: (deletedPath: string) => void;
}

/** A file-tree change worth tracking for the status map. */
export interface FileChange {
  path: string;
  kind?: 'create' | 'update' | 'delete' | 'proposed' | 'moved';
  agent?: string;
  /** On kind 'moved' (story 012-002): the OLD path. `path` is always the NEW
   * one, so every other consumer of `path` keeps working unchanged. */
  from?: string;
}

type FileStatusKind = 'new' | 'modified' | 'generated' | 'ingesting' | 'done' | 'suggested';
interface FileStatus {
  status: FileStatusKind;
  originAgent?: string;
  /** The change came through an external review link (epic 013): the badge
   * says "external", not the member/agent guess, and the accessible name
   * carries the reviewer's claimed display name. */
  external?: boolean;
  reviewerName?: string | null;
}

let projectId = 0;
let handlers: FilesHandlers | null = null;
let listenersWired = false;
let activePath = '';
const statusMap = new Map<string, FileStatus>();
/** Org-library ingestion badges for promoted files (story 006-004). Separate
 * from statusMap: it isn't unseen state, so tree re-hydration and mark-seen
 * must not clear it — only the ingestion outcome does. */
const ingestMap = new Map<string, 'ingesting' | 'done'>();
/** Paths with a pending agent suggestion (story 008-001): path → agent slug.
 * Server truth from GET /pending-edits, re-fetched on every tree refresh (any
 * file_change event debounces into one). Separate from statusMap: it isn't
 * unseen state — opening the file must not clear it, only accept/reject do. */
const suggestMap = new Map<string, string | null>();
/** Unresolved margin-comment threads per path (story 008-004): server truth
 * from GET /comments/counts, re-fetched on every tree refresh. Like
 * suggestMap, not unseen state — opening the file must not clear it, only
 * resolving/deleting the threads does. */
const commentMap = new Map<string, number>();
/** Recorded origin agent per path (from the activity log) — outlives badges,
 * so a seen file keeps its agent tint instead of the extension guess. */
const originMap = new Map<string, string>();
/** Throttle mark-seen POSTs: path → last-sent epoch ms. */
const seenSentAt = new Map<string, number>();
let refreshTimer: number | null = null;

/** An inline rename / new-folder input is open somewhere in the tree. Every
 * render does `container.replaceChildren`, which detaches it mid-keystroke, so
 * this gates `refreshTree` ITSELF — nine call sites bypass the debounce
 * (the refresh button, uploadInto, deleteEntry, the rename cancel and commit
 * paths, editor.ts's post-`/cite` refresh, and three in main.ts). */
let inlineEditing = false;
/** A refresh was suppressed while an inline input was open; run it after. */
let refreshDeferred = false;
/** Monotonic refresh sequence. The project-switch guard alone is not enough:
 * two refreshes of the SAME project can overlap (each awaits four fetches),
 * and a stale response no longer just renders stale — `setTree` reconciles the
 * selection and PERSISTS the pruned collapsed set, so a slow first response
 * landing after a fast second one writes a folder the user just created back
 * out of localStorage. Same pattern as `openDocument`'s guard in editor.ts. */
let refreshSeq = 0;
/** Row to focus once the next render lands: a `data-path`, or `''` for the
 * project-root row. Every mutation ends in `refreshTree` → `replaceChildren`,
 * which destroys the focused node and drops focus to <body>; this is how it
 * gets put back. Consumed (and cleared) by `initRovingTabindex`. */
let focusAfterRender: string | null = null;
/** Path being dragged inside the tree; `getData` is unreadable during
 * `dragover` in protected mode, so the value has to be remembered. */
let draggingPath: string | null = null;
let dropRow: HTMLElement | null = null;
let dropUnderRow: HTMLElement | null = null;
/** Per-render counter for the `aria-owns` group ids. */
let groupSeq = 0;

/** Internal move drags carry this type; external uploads carry 'Files'. The
 * two flows are discriminated on it so they can never fight over a highlight. */
const DRAG_TYPE = 'application/x-kuhn-path';
const ROOT_LABEL = 'Project root';
const ROOT_GROUP_ID = 'file-tree-root-group';

const ORIGIN_CLASS: Record<string, string> = {
  pm: 'origin-pm',
  ra: 'origin-ra',
  reviewer: 'origin-reviewer',
  writer: 'origin-writer',
  advisor: 'origin-advisor',
  analyst: 'origin-analyst',
};

// ---- Wiring -----------------------------------------------------------------

export function initFiles(activeProjectId: number, h: FilesHandlers): void {
  projectId = activeProjectId;
  handlers = h;
  // Per-project reset (story 006): drop the previous project's status tints and
  // active-row highlight when switching projects. Server state re-hydrates the
  // maps on the first refreshTree (story 005-003).
  statusMap.clear();
  originMap.clear();
  ingestMap.clear();
  suggestMap.clear();
  commentMap.clear();
  seenSentAt.clear();
  updateUnseenPill();
  activePath = '';
  // Per-project collapse state + a fresh session selection (story 012-001).
  initTreeState(activeProjectId);
  inlineEditing = false;
  refreshDeferred = false;
  focusAfterRender = null;
  clearInternalDrag();

  if (listenersWired) return; // tree/upload listeners bind once for the page
  listenersWired = true;

  const treeRoot = document.getElementById('file-tree')!;
  treeRoot.setAttribute('role', 'tree');
  treeRoot.setAttribute('aria-label', 'Project files');
  treeRoot.addEventListener('keydown', onTreeKeydown);
  // Roving tabindex (story 005-004): exactly one treeitem is tabbable.
  treeRoot.addEventListener('focusin', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!item) return;
    treeRoot.querySelectorAll<HTMLElement>('[role="treeitem"][tabindex="0"]')
      .forEach((el) => el.setAttribute('tabindex', '-1'));
    item.setAttribute('tabindex', '0');
  });

  const refreshBtn = document.getElementById('files-refresh-btn');
  if (refreshBtn) {
    refreshBtn.innerHTML = icon('refresh', { size: 13, stroke: 1.8 });
    refreshBtn.addEventListener('click', () => void refreshTree(projectId));
  }

  const newFolderBtn = document.getElementById('files-new-folder-btn');
  if (newFolderBtn) {
    newFolderBtn.innerHTML = icon('folder-plus', { size: 13, stroke: 1.8 });
    newFolderBtn.addEventListener('click', () => void beginNewFolder(targetDir()));
  }

  const treeEl = document.getElementById('file-tree')!;

  // --- external file drops (upload) — unchanged, discriminated on 'Files' ---
  let dragTarget: HTMLElement | null = null;
  const clearDrag = () => {
    treeEl.classList.remove('drag-over');
    if (dragTarget) {
      dragTarget.classList.remove('drag-over');
      dragTarget = null;
    }
  };

  treeEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    const dir = (e.target as HTMLElement | null)?.closest('[data-dir]') as HTMLElement | null;
    if (dir !== dragTarget) clearDrag();
    if (dir) {
      dir.classList.add('drag-over');
      dragTarget = dir;
    } else {
      treeEl.classList.add('drag-over');
    }
  });
  treeEl.addEventListener('dragleave', (e) => {
    if (e.target === treeEl) {
      clearDrag();
      clearDropHighlight();
    }
  });
  treeEl.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const dir = (e.target as HTMLElement | null)?.closest('[data-dir]') as HTMLElement | null;
    clearDrag();
    // Re-validate against the CURRENT tree, like every other write destination
    // (targetDir, onInternalDrop, the move dialog's confirm). purgeTreeState
    // clears a vanished selection but cannot un-render the row, and the
    // re-render is 250ms behind the debounce — so the DOM can still offer a
    // folder a collaborator just deleted, and the upload would recreate it.
    const dropped = dir?.dataset.dir;
    const dest = dropped && (dropped === '' || findNode(dropped)?.type === 'dir')
      ? dropped
      : targetDir();
    void uploadInto(e.dataTransfer.files, dest);
  });

  // --- internal move drags (story 012-001) ---------------------------------
  treeEl.addEventListener('dragstart', onInternalDragStart);
  treeEl.addEventListener('dragover', onInternalDragOver);
  treeEl.addEventListener('drop', onInternalDrop);
  treeEl.addEventListener('dragend', clearInternalDrag);
  // `dragend` fires at the ORIGINAL source node, which a refresh landing
  // mid-drag has already detached — it then never bubbles to the delegated
  // listener above and the drag state (plus every highlight class) leaks.
  // Document-level backstops, and a full reset at the top of every dragstart.
  document.addEventListener('dragend', clearInternalDrag);
  document.addEventListener('drop', clearInternalDrag);

  // Clicking past every row puts the target back on the project root. (The
  // root row itself is the keyboard-reachable path to the same thing.)
  treeEl.addEventListener('click', (e) => {
    if (inlineEditing) return;
    const t = e.target as HTMLElement;
    if (t.closest('summary[role="treeitem"], .file-entry, .file-actions, .file-name-input, .drop-zone')) return;
    selectDir('');
  });

  const input = document.getElementById('files-upload-input') as HTMLInputElement | null;
  document.getElementById('files-upload-btn')?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', () => {
    if (input.files?.length) void uploadInto(input.files, targetDir());
    input.value = '';
  });

  initFilesResizer();
}

// ---- Resizable files panel --------------------------------------------------

const FILES_WIDTH_KEY = 'kuhn-files-width';
const FILES_WIDTH_MIN = 200;
const FILES_WIDTH_MAX = 620;

/** Apply a saved width and wire the drag handle (story: fixed/resizable files). */
function initFilesResizer(): void {
  const panel = document.getElementById('files-panel');
  const handle = document.getElementById('files-resizer');
  if (!panel || !handle) return;

  const apply = (w: number) => panel.style.setProperty('--files-width', `${w}px`);
  const saved = parseInt(localStorage.getItem(FILES_WIDTH_KEY) ?? '', 10);
  if (Number.isFinite(saved)) apply(clampWidth(saved));

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const right = panel.getBoundingClientRect().right;
    handle.classList.add('dragging');
    document.body.classList.add('resizing-pane');
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => apply(clampWidth(right - ev.clientX));
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-pane');
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      const current = Math.round(panel.getBoundingClientRect().width);
      localStorage.setItem(FILES_WIDTH_KEY, String(current));
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function clampWidth(w: number): number {
  return Math.max(FILES_WIDTH_MIN, Math.min(FILES_WIDTH_MAX, w));
}

/** Mark a file row as the open document and re-highlight without refetching. */
export function setActiveFile(path: string): void {
  activePath = path;
  if (path) markSeen(path); // opening a file clears its badge (story 005-003)
  const tree = document.getElementById('file-tree');
  if (!tree) return;
  tree.querySelectorAll('.file-entry.active').forEach((el) => {
    el.classList.remove('active');
    el.setAttribute('aria-selected', 'false');
  });
  const entry = tree.querySelector(`.file-entry[data-path="${cssEscape(path)}"]`);
  entry?.classList.add('active');
  entry?.setAttribute('aria-selected', 'true');
}

/**
 * Refresh the tree from server truth. Resolves `false` when the refresh was
 * DEFERRED (an inline input is open) — callers that await this for its DATA
 * rather than its render must check, or they will read a stale snapshot and
 * decide from it. Callers that only want the repaint can ignore it.
 */
export async function refreshTree(activeProjectId: number): Promise<boolean> {
  projectId = activeProjectId;
  const container = document.getElementById('file-tree')!;
  // An inline input is a child of the tree; rendering would detach it and the
  // half-typed name would be silently eaten (whether `blur` fires on a removed
  // focused element is engine-dependent, so the outcome is non-deterministic).
  // Defer instead — the input's commit/cancel path runs the refresh.
  if (inlineEditing) {
    refreshDeferred = true;
    return false;
  }
  // `#file-tree.is-loading` used to set `pointer-events: none` on the whole
  // container for the duration of four parallel fetches, which removed it from
  // hit-testing and silently killed a drop landing in that window. The CSS is
  // now scoped to the rows; suppressing the dim during a drag keeps even the
  // visual honest.
  const seq = ++refreshSeq;
  const midGesture = draggingPath != null;
  if (!midGesture) container.classList.add('is-loading');
  if (!container.hasChildNodes()) container.replaceChildren(emptyNotice('Loading files…'));
  try {
    // Tree carries per-user unseen flags; the activity log supplies each
    // path's latest kind + origin agent. Together they rebuild the status
    // map from server truth, so badges survive reload (story 005-003).
    // Pending suggestions ride along (story 008-001) — same server-truth rule.
    const [nodes, activity, pending, commentCounts] = await Promise.all([
      getTree(activeProjectId),
      getFileActivity(activeProjectId).catch(() => [] as FileActivityEvent[]),
      getPendingEdits(activeProjectId).catch(() => [] as PendingEdit[]),
      getCommentCounts(activeProjectId).catch(() => ({}) as Record<string, number>),
    ]);
    if (projectId !== activeProjectId) return false; // superseded by a project switch
    if (seq !== refreshSeq) return false; // superseded by a later refresh of this project
    setTree(nodes);
    hydrateStatus(nodes, activity);
    suggestMap.clear();
    for (const edit of pending) {
      suggestMap.set(edit.path, edit.agent);
      if (edit.agent) originMap.set(edit.path, edit.agent);
    }
    commentMap.clear();
    for (const [path, n] of Object.entries(commentCounts)) commentMap.set(path, n);
    // The root <ul> is ALWAYS rendered (even for an empty project): "New
    // folder" needs a group to insert its inline input into, and the
    // project-root row is where the default upload target is shown.
    const frag = document.createDocumentFragment();
    frag.append(renderTree(nodes));
    if (nodes.length === 0) frag.append(emptyState());
    container.replaceChildren(frag);
    initRovingTabindex(container);
    return true;
  } catch (err) {
    const notice = emptyNotice(`Could not load files: ${(err as Error).message}`);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-quiet btn-sm';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => void refreshTree(activeProjectId));
    notice.append(document.createElement('br'), retry);
    container.replaceChildren(notice);
    return false;
  } finally {
    container.classList.remove('is-loading');
    updateUnseenPill();
  }
}

/**
 * Coalesce refreshes driven by live feed events (story 005-003): a burst of
 * agent writes — or the same change arriving via both the job stream and the
 * project feed — triggers one refetch, not one per event.
 */
export function refreshTreeSoon(activeProjectId: number): void {
  if (refreshTimer != null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshTree(activeProjectId);
  }, 250);
}

/** Rebuild status/origin maps from server state (tree flags + activity log). */
function hydrateStatus(nodes: TreeNode[], activity: FileActivityEvent[]): void {
  statusMap.clear();
  originMap.clear();
  // Newest-first log: keep each path's latest event only.
  const latest = new Map<string, FileActivityEvent>();
  for (const ev of activity) {
    if (!latest.has(ev.path)) latest.set(ev.path, ev);
    if (ev.agent_slug && !originMap.has(ev.path)) originMap.set(ev.path, ev.agent_slug);
  }
  const walk = (list: TreeNode[]): void => {
    for (const node of list) {
      if (node.type === 'dir') {
        walk(node.children ?? []);
      } else if (node.unseen) {
        const ev = latest.get(node.path);
        // An event carrying a review_link_id was an external reviewer's edit
        // (epic 013) — badge it as such, never as a member or agent change.
        const external = Boolean(ev?.review_link_id);
        statusMap.set(node.path, {
          status: !ev
            ? 'modified' // unseen but the event aged out of the log
            : ev.agent_slug
              ? (ev.kind === 'create' ? 'generated' : 'modified')
              : (ev.kind === 'create' && !external ? 'new' : 'modified'),
          originAgent: ev?.agent_slug ?? (ev && !external ? 'user' : undefined),
          external,
          reviewerName: ev?.reviewer_name ?? null,
        });
      }
    }
  };
  walk(nodes);
}

/**
 * Mark a file seen: clear its badge locally (in place, no refetch), update
 * the unseen pill, and persist per-user seen state (throttled — opening the
 * same file repeatedly sends one POST per few seconds).
 */
export function markSeen(path: string): void {
  if (statusMap.delete(path)) {
    const entry = document
      .getElementById('file-tree')
      ?.querySelector(`.file-entry[data-path="${cssEscape(path)}"]`);
    // Spinner/check belong to the org-library ingest flow (ingestMap), the
    // suggested badge to the pending-edit flow (suggestMap), and the comment
    // count to open threads (commentMap) — opening the file resolves none of
    // them. Remove only the unseen badge.
    entry?.querySelectorAll('.file-badge:not(.is-suggested):not(.is-comment)').forEach((el) => el.remove());
    updateUnseenPill();
    // The row was patched in place with no refetch, so a collapsed ancestor
    // would otherwise keep a stale rolled-up count until the next refresh.
    updateRollups();
  }
  const last = seenSentAt.get(path) ?? 0;
  if (Date.now() - last < 3000) return;
  seenSentAt.set(path, Date.now());
  void markFileSeen(projectId, path).catch(() => {
    seenSentAt.delete(path); // let a later open retry
  });
}

/**
 * The single "this path wants attention" predicate. The topbar pill and the
 * folder rollups MUST share it or the two numbers drift.
 *
 * The pill iterates MAP KEYS while a rollup walks TREE NODES; the gap between
 * the two — a pending edit proposing a file that does not exist on disk yet
 * (`base_missing`), which has no tree node — is closed by feeding the rollup
 * `phantomProposals()` (story 012-005).
 */
function flaggedPath(path: string): boolean {
  const st = statusMap.get(path);
  if (st && (st.status === 'new' || st.status === 'generated' || st.status === 'modified')) return true;
  return suggestMap.has(path);
}

const ROLLUP_PROBE: RollupProbe = {
  flagged: flaggedPath,
  comments: (path) => commentMap.get(path) ?? 0,
};

/** Proposal paths with no file behind them (`pending_edits.base_missing` — a
 * proposal to CREATE a file). No tree node, so the rollup walk cannot see
 * them; passed to rollup() separately so a proposed new file is never
 * invisible behind (or inside) its would-be parent folder (story 012-005). */
function phantomProposals(): string[] {
  return [...suggestMap.keys()].filter((path) => !findNode(path));
}

/** Unseen-count pill on the topbar Files toggle (story 005-003). */
function updateUnseenPill(): void {
  const toggle = document.getElementById('toggle-files');
  if (!toggle) return;
  let pill = toggle.querySelector<HTMLElement>('.toggle-pill');
  const flagged = new Set<string>();
  for (const path of statusMap.keys()) if (flaggedPath(path)) flagged.add(path);
  for (const path of suggestMap.keys()) flagged.add(path); // pending review counts too
  const count = flagged.size;
  if (count === 0) {
    pill?.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement('span');
    pill.className = 'toggle-pill';
    toggle.append(pill);
  }
  pill.textContent = String(count);
  pill.setAttribute('aria-label', `${count} unseen file change${count === 1 ? '' : 's'}`);
}

/**
 * Reveal the open document in the tree (story 007 breadcrumb): make sure the
 * files panel is visible, expand the row's ancestor folders, highlight it, and
 * scroll it into view.
 */
export function revealFile(path: string): void {
  document.getElementById('files-panel')?.classList.remove('collapsed');
  // STATE first, then DOM: setting only `.open` would be undone by the next
  // debounced re-render, which rebuilds every <details> from `isExpanded`.
  expandAncestors(path);
  const entry = document
    .getElementById('file-tree')
    ?.querySelector(`.file-entry[data-path="${cssEscape(path)}"]`);
  if (!entry) return;
  let parent = entry.closest('details') as HTMLDetailsElement | null;
  while (parent) {
    parent.open = true;
    parent = parent.parentElement?.closest('details') as HTMLDetailsElement | null;
  }
  entry.scrollIntoView({ block: 'center' });
  entry.classList.add('reveal-flash');
  setTimeout(() => entry.classList.remove('reveal-flash'), 900);
}

// ---- Status map (story 025 badge data) --------------------------------------

/** Record a `file_change` (or citation) event into the status map. */
export function recordFileChange(change: FileChange): void {
  if (change.kind === 'proposed') {
    // The pending set changed (created, updated, or rejected — the event does
    // not say which); the debounced tree refresh re-fetches server truth. Only
    // the origin tint is worth recording eagerly.
    if (change.agent) originMap.set(change.path, change.agent);
    return;
  }
  if (change.kind === 'moved' && change.from) {
    // A move preserves identity (story 012-002), so re-key every path-keyed
    // map instead of dropping the old path and inventing a new entry. The
    // debounced refresh re-hydrates most of them from server truth moments
    // later; this keeps badges off the wrong row in the meantime and is the
    // only thing that carries the client-only ingestMap across a move.
    migrateStatus(change.from, change.path);
    migrateTreeState(change.from, change.path);
    updateUnseenPill();
    return;
  }
  if (change.kind === 'delete') {
    // Prefix-aware (story 012-001): the route publishes exactly ONE delete
    // event for a folder, so an exact-match delete leaves every descendant's
    // badge inflating the pill — and leaves a vanished folder as the upload
    // target, which the next upload would silently re-create.
    purgeStatus(change.path);
    purgeTreeState(change.path);
  } else {
    statusMap.set(change.path, {
      status: change.agent
        ? (change.kind === 'create' ? 'generated' : 'modified')
        : (change.kind === 'create' ? 'new' : 'modified'),
      originAgent: change.agent,
    });
    if (change.agent) originMap.set(change.path, change.agent);
  }
  updateUnseenPill();
}

function recordUpload(path: string): void {
  statusMap.set(path, { status: 'new', originAgent: 'user' });
  updateUnseenPill();
}

/**
 * Re-key every path-keyed client map through a move of `from` → `to` (story
 * 012-002). Prefix-aware, so a FOLDER move carries all of its descendants —
 * the client mirror of the server's one transactional rewrite. Each map is
 * iterated over a snapshot of its keys so rewritten entries aren't revisited.
 */
function migrateStatus(from: string, to: string): void {
  const rekey = <V>(map: Map<string, V>): void => {
    for (const key of [...map.keys()]) {
      const next = movedPath(key, from, to);
      if (next == null) continue;
      const value = map.get(key) as V;
      map.delete(key);
      map.set(next, value);
    }
  };
  rekey(statusMap);
  rekey(originMap);
  rekey(suggestMap);
  rekey(commentMap);
  rekey(ingestMap);
  // Seen-throttle stamps are worthless at the new path — drop them so the
  // first open there re-POSTs mark-seen rather than being throttled out.
  for (const key of [...seenSentAt.keys()]) {
    if (movedPath(key, from, to) != null) seenSentAt.delete(key);
  }
  const nextActive = movedPath(activePath, from, to);
  if (nextActive != null) activePath = nextActive;
}

/** Prefix-aware sibling of `migrateStatus` for a vanished subtree. Deleting a
 * FOLDER must drop every descendant's entry, not just the folder's own. */
function purgeStatus(prefix: string): void {
  if (!prefix) return;
  const drop = (map: Map<string, unknown>): void => {
    for (const key of [...map.keys()]) if (isUnder(key, prefix)) map.delete(key);
  };
  drop(statusMap);
  drop(originMap);
  drop(suggestMap);
  drop(commentMap);
  drop(ingestMap);
  drop(seenSentAt);
}

// ---- Upload target (the selected folder) ------------------------------------

/**
 * The folder uploads and new folders land in, RE-VALIDATED at action time.
 * The selection is session state, but a collaborator can delete the folder
 * while an upload is being chosen: `writeProjectFile` mkdirs its parent
 * recursively, so a stale target silently re-creates the deleted folder with
 * the upload inside it.
 */
function targetDir(): string {
  const dir = selectedDir();
  if (!dir) return '';
  if (findNode(dir)?.type === 'dir') return dir;
  setSelectedDir('');
  applyTargetClasses();
  return '';
}

function selectDir(path: string): void {
  setSelectedDir(path);
  applyTargetClasses();
}

/** Move the `.is-target` / `aria-current` marker onto the selected row. */
function applyTargetClasses(): void {
  const root = document.getElementById('file-tree');
  if (!root) return;
  root.querySelectorAll<HTMLElement>('.is-target').forEach((el) => {
    el.classList.remove('is-target');
    el.removeAttribute('aria-current');
  });
  const dir = selectedDir();
  const el = dir
    ? root.querySelector<HTMLElement>(`summary[data-path="${cssEscape(dir)}"]`)
    : root.querySelector<HTMLElement>('.file-root');
  if (el) {
    el.classList.add('is-target');
    el.setAttribute('aria-current', 'true');
  }
  labelRoot(root.querySelector<HTMLElement>('.file-root'));
  updateRollups(); // folder aria-labels mention the target state
}

async function uploadInto(fileList: FileList | File[], dir: string): Promise<void> {
  const files = Array.from(fileList);
  if (files.length === 0) return;
  const { uploaded, failed } = await uploadFiles(projectId, files, dir || undefined);
  for (const u of uploaded) recordUpload(u.path);
  await refreshTree(projectId);
  if (uploaded.length > 0) {
    const where = dir ? ` to ${dir}` : '';
    toast(`Uploaded ${uploaded.length} file${uploaded.length === 1 ? '' : 's'}${where}`);
  }
  for (const f of failed) toast(`${f.name}: ${f.error}`);
}

// ---- Manage (delete / rename / move / create) -------------------------------

/** Where focus should land after `path` is deleted: the next surviving sibling,
 * else the previous one, else the parent folder, else the project-root row. */
function neighbourPath(path: string): string {
  const parent = parentDir(path);
  const siblings = parent ? (findNode(parent)?.children ?? []) : tree();
  const sorted = sortNodes(siblings);
  const i = sorted.findIndex((n) => n.path === path);
  const next = i === -1 ? undefined : (sorted[i + 1] ?? sorted[i - 1]);
  return next ? next.path : parent;
}

async function deleteEntry(node: TreeNode): Promise<void> {
  // PREFIX, not equality: deleting a FOLDER that contains the open document
  // must close the editor, or it keeps autosaving to a path that no longer
  // exists — and `writeProjectFile` mkdirs the parent, re-creating the folder.
  const hitsOpenDoc = isUnder(activePath, node.path);
  const scope = node.type === 'dir' ? ' and everything inside it' : '';
  // `deleteProjectEntry` is `rm -r` and an empty folder produces no commit at
  // all (git cannot track one), so this is not undoable from history.
  const openNote = !hitsOpenDoc
    ? ''
    : node.path === activePath
      ? " It's the document you're editing — the editor will close."
      : " The document you're editing is inside it — the editor will close.";
  const message = `Delete "${node.name}"${scope}?${openNote}`;
  // Documented exception (story 005-004): native confirm() is keyboard- and
  // screen-reader-accessible by construction; a styled dialog isn't worth its
  // focus-management surface until one exists elsewhere in the app.
  if (!window.confirm(message)) return;
  const next = neighbourPath(node.path);
  if (hitsOpenDoc) handlers?.dropOpenDoc(node.path); // drop before delete so no save resurrects it
  try {
    await deleteFile(projectId, node.path);
  } catch (err) {
    toast(`Delete failed: ${(err as Error).message}`);
    return;
  }
  purgeStatus(node.path);
  purgeTreeState(node.path);
  focusAfterRender = next;
  await refreshTree(projectId);
}

/** Shared setup for the two inline inputs (rename, new folder). */
function beginInline(input: HTMLInputElement, row: HTMLElement | null): void {
  inlineEditing = true;
  // A mouse-drag to select text inside the input would otherwise fire
  // `dragstart` on the draggable ancestor row and arm a move mid-edit.
  if (row) row.draggable = false;
  // Tree navigation must not steal the arrows, Home/End, Escape or the
  // single-key row shortcuts while a name is being typed.
  input.addEventListener('keydown', (e) => e.stopPropagation());
  // Inside a <summary>, a click that reaches the summary toggles the
  // disclosure. preventDefault is what cancels that — stopPropagation alone
  // does not. Caret placement happens on mousedown, so this is safe.
  input.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('dragstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

/** Leave inline-editing mode. Returns true if a refresh was suppressed while
 * the input was open (every caller runs one itself, so the flag is cleared). */
function endInline(): boolean {
  inlineEditing = false;
  const deferred = refreshDeferred;
  refreshDeferred = false;
  return deferred;
}

function beginRename(node: TreeNode): void {
  if (inlineEditing) return;
  const root = document.getElementById('file-tree');
  // Folders are <summary role="treeitem">, files a <button class="file-entry">
  // inside a `.file-row`. The old lookup was `.file-entry[data-path]` only, so
  // renaming a folder silently no-opped.
  const item = root?.querySelector<HTMLElement>(`[role="treeitem"][data-path="${cssEscape(node.path)}"]`);
  if (!item) return;
  const host = node.type === 'dir' ? item : item.closest<HTMLElement>('.file-row');
  if (!host) return;

  const wrap = document.createElement('div');
  wrap.className = 'file-row file-row-inline';
  const input = document.createElement('input');
  input.className = 'file-name-input';
  input.value = node.name;
  input.setAttribute('aria-label', `Rename ${node.name}`);
  wrap.append(input);
  host.replaceChildren(wrap);
  beginInline(input, item);
  input.focus();
  // Pre-select the stem for files only — stripping ".2" out of a folder called
  // `v1.2` is a mangling, not a convenience.
  const stem = node.type === 'dir'
    ? node.name.length
    : (node.name.replace(/\.[^.]+$/, '').length || node.name.length);
  input.setSelectionRange(0, stem);

  let settled = false;
  const finish = (commit: boolean): void => {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();
    endInline();
    if (commit && newName && newName !== node.name) {
      void renameEntry(node, newName);
    } else {
      focusAfterRender = node.path;
      void refreshTree(projectId); // rebuild the row cleanly (cancel / no-op)
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

/**
 * Rename = a same-parent move. It keeps its own recovery deliberately:
 * `moveEntry`'s contract is "no DOM recovery — every caller that mutated the
 * DOM before calling must restore it", and `beginRename` has already replaced
 * the whole row (or, for a folder, the whole summary) with a bare input.
 */
async function renameEntry(node: TreeNode, newName: string): Promise<void> {
  const to = renamePath(node.path, newName);
  focusAfterRender = to;
  try {
    await moveEntry(node, to);
  } catch (err) {
    toast(moveErrorMessage(err, node, to));
    focusAfterRender = node.path;
    await refreshTree(projectId);
  }
}

/**
 * Move `node` to `to`. THROWS on failure and performs no DOM recovery — the
 * drag path toasts, the dialog renders the message inline, and `renameEntry`
 * rebuilds the row it destroyed.
 */
async function moveEntry(node: TreeNode, to: string): Promise<void> {
  // Prefix-aware (story 012-002): moving a FOLDER must flush an open
  // DESCENDANT too. The server evicts every Yjs room under the old path, and
  // rooms are memory-only — unflushed keystrokes exist nowhere else.
  if (movedPath(activePath, node.path, to) != null) await handlers?.flushOpenDoc();
  const res = await moveFile(projectId, node.path, to);
  // Re-keys the maps, the collapse set and `activePath`. Deliberately no
  // reopen here: the `moved` feed event is the ONE retarget path (story
  // 012-002) — the server fans it out synchronously before this response
  // returns, so reopening from both sites would race two concurrent opens.
  migrateStatus(res.from, res.to);
  migrateTreeState(res.from, res.to);
  // Open the destination so the moved row is actually visible. Without this a
  // move into a collapsed folder lands `focusAfterRender` on a row that
  // `visibleTreeItems` filters out, and the tree is left with no tab stop.
  expandAncestors(res.to);
  await refreshTree(projectId);
}

/** The three distinguishable move failures, in one place. */
function moveErrorMessage(err: unknown, node: TreeNode, to: string): string {
  if (err instanceof ApiError) {
    // Proposals live only in the DB (pending_edits has UNIQUE(project_id,path)),
    // so storage's destination-exists check cannot see them — the route reports
    // them as a 409 carrying `paths`.
    if (err.status === 409 && err.paths?.length) {
      return `Can't move "${node.name}" there: an agent already has a pending edit at ${err.paths[0]}. Accept or reject it first.`;
    }
    if (err.status === 409) return `Something named "${baseName(to)}" is already in that folder.`;
  }
  return (err as Error).message || `Could not move "${node.name}".`;
}

/** Build the legal destinations and hand them to the (dumb) dialog. */
function openMoveFor(node: TreeNode): void {
  const parent = parentDir(node.path);
  const targets: MoveTarget[] = [];
  // The project-root row sits at depth 0, so real folders start at depth 1.
  if (parent !== '') targets.push({ path: '', label: ROOT_LABEL, depth: 0 });
  for (const dir of dirNodes()) {
    if (isUnder(dir.path, node.path)) continue; // itself and its own subtree
    if (dir.path === parent) continue; // current parent: the server 400s a no-op
    targets.push({ path: dir.path, label: dir.name, depth: dir.depth + 1 });
  }
  if (targets.length === 0) {
    toast(`There is nowhere else to put "${node.name}" — create a folder first.`);
    return;
  }
  openMoveDialog({
    title: `Move “${node.name}”`,
    targets,
    onConfirm: async (dest) => {
      // RE-VALIDATE AT COMMIT TIME. The list was frozen when the dialog opened;
      // another client can delete either end in the meantime, and storage's
      // move mkdirs the destination parent recursively — so a vanished target
      // would be silently re-created rather than reported.
      const live = findNode(node.path);
      if (!live) throw new Error(`"${node.name}" is no longer in the tree.`);
      if (dest && findNode(dest)?.type !== 'dir') {
        throw new Error(`"${dest}" is no longer in the tree.`);
      }
      const to = joinPath(dest, live.name);
      focusAfterRender = to;
      try {
        await moveEntry(live, to);
      } catch (err) {
        throw new Error(moveErrorMessage(err, live, to));
      }
    },
  });
}

/** The `<ul role="group">` a new folder's inline input belongs in. */
function newFolderGroup(dir: string): HTMLUListElement | null {
  const root = document.getElementById('file-tree');
  if (!root) return null;
  if (!dir) return root.querySelector<HTMLUListElement>(`#${ROOT_GROUP_ID}`);
  const summary = root.querySelector<HTMLElement>(`summary[data-path="${cssEscape(dir)}"]`);
  const details = summary?.parentElement as HTMLDetailsElement | null;
  if (!details || details.tagName !== 'DETAILS') return null;
  details.open = true;
  return details.querySelector<HTMLUListElement>(':scope > ul.file-list');
}

async function beginNewFolder(parent: string): Promise<void> {
  if (inlineEditing) return;
  const dir = parent && findNode(parent)?.type === 'dir' ? parent : '';
  if (dir) {
    expandAncestors(dir);
    setExpanded(dir, true);
  }
  let ul = newFolderGroup(dir);
  if (!ul) {
    // The folder is real but not rendered (a collapsed ancestor, or the tree
    // has not landed yet) — one refresh, then give up rather than guess.
    await refreshTree(projectId);
    ul = newFolderGroup(dir);
  }
  if (!ul) {
    toast('Could not find that folder in the tree.');
    return;
  }

  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  // `.file-name-input` is `flex: 1 1 auto` — inert outside a `.file-row`, where
  // it would render at its ~170px intrinsic width instead of filling the row.
  const wrap = document.createElement('div');
  wrap.className = 'file-row file-row-inline';
  const input = document.createElement('input');
  input.className = 'file-name-input';
  input.placeholder = 'New folder name';
  input.setAttribute('aria-label', dir ? `New folder in ${dir}` : 'New folder in the project root');
  wrap.append(input);
  li.append(wrap);
  // Folders sort before files, so the input goes after the last folder — the
  // created folder must appear where you typed it, not jump to the top.
  const firstFile = [...ul.children].find((el) => el.querySelector(':scope > .file-row'));
  ul.insertBefore(li, firstFile ?? null);

  beginInline(input, null);
  input.focus();

  let settled = false;
  const finish = async (commit: boolean): Promise<void> => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    endInline();
    if (!commit || !name) {
      focusAfterRender = dir;
      await refreshTree(projectId);
      return;
    }
    try {
      const res = await createFolder(projectId, joinPath(dir, name));
      setExpanded(res.path, true);
      setSelectedDir(res.path); // you almost always want to put something in it
      focusAfterRender = res.path;
      await refreshTree(projectId);
      if (!res.created) toast(`"${name}" already exists.`);
    } catch (err) {
      toast(
        err instanceof ApiError && err.status === 409
          ? `A file named "${name}" is already there.`
          : `Could not create "${name}": ${(err as Error).message}`,
      );
      focusAfterRender = dir;
      await refreshTree(projectId);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener('blur', () => void finish(true));
}

// ---- Internal drag-and-drop (story 012-001) ---------------------------------
//
// The "Move to…" dialog is the primary, guaranteed path; this is layered on
// top of it and is never the only way to do anything.

/** The destination a pointer over `el` resolves to, plus the rows to light up.
 * `dest === ''` is the project root. */
function dropDestFor(el: HTMLElement | null): {
  dest: string;
  row: HTMLElement | null;
  pointerRow: HTMLElement | null;
} {
  const root = document.getElementById('file-tree');
  const rootRow = root?.querySelector<HTMLElement>('.file-root') ?? null;
  const pointerRow = el?.closest<HTMLElement>('summary[role="treeitem"], .file-entry') ?? null;
  if (!pointerRow || pointerRow.classList.contains('file-root')) {
    return { dest: '', row: rootRow, pointerRow: pointerRow ?? rootRow };
  }
  if (pointerRow.tagName === 'SUMMARY') {
    return { dest: pointerRow.dataset.path ?? '', row: pointerRow, pointerRow };
  }
  // A file row: the destination is its containing folder. The highlight goes on
  // that folder's row — never on the <details> container, which spans the whole
  // subtree and whose summary can be scrolled far out of a 220px panel.
  const dest = parentDir(pointerRow.dataset.path ?? '');
  const row = dest
    ? root?.querySelector<HTMLElement>(`summary[data-path="${cssEscape(dest)}"]`) ?? null
    : rootRow;
  return { dest, row, pointerRow };
}

function canDrop(dest: string, path: string): boolean {
  if (!path) return false;
  if (dest === path) return false; // onto itself
  if (dest && isUnder(dest, path)) return false; // into its own subtree
  if (dest === parentDir(path)) return false; // already there — the server 400s
  if (dest && findNode(dest)?.type !== 'dir') return false;
  return true;
}

function clearDropHighlight(): void {
  dropRow?.classList.remove('is-drop-target');
  dropRow = null;
  dropUnderRow?.classList.remove('is-drop-under', 'is-drop-invalid');
  dropUnderRow = null;
}

function clearInternalDrag(): void {
  clearDropHighlight();
  document
    .getElementById('file-tree')
    ?.querySelectorAll('.is-dragging')
    .forEach((el) => el.classList.remove('is-dragging'));
  draggingPath = null;
}

function onInternalDragStart(e: DragEvent): void {
  clearInternalDrag(); // never inherit state from a drag that ended off-tree
  if (inlineEditing) {
    e.preventDefault();
    return;
  }
  const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(
    'summary[data-path], .file-entry[data-path]',
  );
  const path = row?.dataset.path ?? '';
  if (!row || !path) return;
  e.dataTransfer?.setData(DRAG_TYPE, path);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  draggingPath = path;
  row.classList.add('is-dragging');
}

function onInternalDragOver(e: DragEvent): void {
  if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
  const path = draggingPath;
  if (!path) return;
  const { dest, row, pointerRow } = dropDestFor(e.target as HTMLElement | null);
  const ok = canDrop(dest, path);
  clearDropHighlight();
  if (ok) {
    if (row) {
      row.classList.add('is-drop-target');
      dropRow = row;
    }
    // Always something under the pointer too: the destination row can be
    // scrolled out of view when the pointer is over a deep descendant.
    if (pointerRow && pointerRow !== row) {
      pointerRow.classList.add('is-drop-under');
      dropUnderRow = pointerRow;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  } else {
    // Illegal and no-op destinations are visibly rejected rather than inert.
    if (pointerRow) {
      pointerRow.classList.add('is-drop-invalid');
      dropUnderRow = pointerRow;
    }
    e.dataTransfer.dropEffect = 'none';
  }
}

function onInternalDrop(e: DragEvent): void {
  if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
  e.preventDefault();
  e.stopPropagation();
  const path = draggingPath || e.dataTransfer.getData(DRAG_TYPE);
  const { dest } = dropDestFor(e.target as HTMLElement | null);
  clearInternalDrag();
  if (!path) return;
  // COMMIT-TIME re-validation: another client can delete either end mid-drag,
  // and `moveProjectEntry` mkdirs the destination parent recursively, so a
  // vanished folder would be silently re-created instead of reported.
  const node = findNode(path);
  if (!node) {
    toast(`"${baseName(path)}" is no longer in the tree — nothing was moved.`);
    return;
  }
  if (dest && findNode(dest)?.type !== 'dir') {
    toast(`"${dest}" is no longer in the tree — nothing was moved.`);
    return;
  }
  if (!canDrop(dest, path)) return;
  const to = joinPath(dest, node.name);
  focusAfterRender = to;
  void moveEntry(node, to).catch((err) => {
    toast(moveErrorMessage(err, node, to));
    focusAfterRender = node.path;
    void refreshTree(projectId);
  });
}

// ---- Promote to org library (story 006-004) ----------------------------------

/**
 * Patch a row's ingest badge in place (set, advance, or clear) without a tree
 * refetch; a later re-render reads the same state from ingestMap.
 */
function setIngestBadge(path: string, state: 'ingesting' | 'done' | null): void {
  if (state) ingestMap.set(path, state);
  else ingestMap.delete(path);
  const entry = document
    .getElementById('file-tree')
    ?.querySelector(`.file-entry[data-path="${cssEscape(path)}"]`);
  if (!entry) return;
  entry.querySelectorAll('.file-spinner, .file-done').forEach((el) => el.remove());
  const name = entry.querySelector('.file-name')?.textContent ?? path;
  const st = state ? { status: state } as FileStatus : statusMap.get(path);
  entry.setAttribute('aria-label', st ? `${name}, ${STATUS_TEXT[st.status]}` : name);
  if (!state) return;
  const badge = statusBadge({ status: state });
  if (badge) {
    badge.setAttribute('aria-hidden', 'true');
    entry.append(badge);
  }
}

/** Copy a file into the org library (confirmation names the org), then track
 * its ingestion on the row: spinner while processing, check when searchable. */
async function promoteEntry(node: TreeNode): Promise<void> {
  const org = workspace.activeOrg();
  if (!org) {
    toast('No active organization to add to');
    return;
  }
  // Documented exception (story 005-004): native confirm(), as with delete.
  const ok = window.confirm(
    `Add "${node.name}" to the ${org.name} library?\n\nAgents in every ${org.name} project will be able to search and cite it.`,
  );
  if (!ok) return;

  let document_: Awaited<ReturnType<typeof promoteFileToLibrary>>;
  try {
    document_ = await promoteFileToLibrary(projectId, node.path);
  } catch (err) {
    toast(`Add to library failed: ${(err as Error).message}`);
    return;
  }
  const { document: doc, deduped } = document_;
  if (doc.status === 'ready') {
    toast(deduped ? `Already in the ${org.name} library` : `Added to the ${org.name} library`);
    return;
  }
  toast(`Added to the ${org.name} library — processing…`);
  setIngestBadge(node.path, 'ingesting');
  watchDocIngestion(org.id, doc.id, (status, detail) => {
    if (status === 'ready') {
      setIngestBadge(node.path, 'done');
      window.setTimeout(() => {
        if (ingestMap.get(node.path) === 'done') setIngestBadge(node.path, null);
      }, 6000);
      toast(`${node.name} is now searchable in the ${org.name} library`);
    } else {
      setIngestBadge(node.path, null);
      toast(`Library processing failed for ${node.name}: ${detail || 'unknown error'}`);
    }
  });
}

// ---- Rendering --------------------------------------------------------------

function emptyNotice(text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'file-empty';
  div.textContent = text;
  return div;
}

/** Empty-state drop zone — functional upload target (click or drop). */
function emptyState(): DocumentFragment {
  const frag = document.createDocumentFragment();
  const zone = document.createElement('div');
  zone.className = 'drop-zone';
  zone.innerHTML =
    `<div class="dz-icon">${icon('upload', { size: 18, stroke: 1.7 })}</div>` +
    `<div class="dz-title">Upload materials</div>` +
    `<div class="dz-sub">Drop protocols, guidance, prior drafts. The Advisor reads them during seeding.</div>` +
    `<div class="dz-types">PDF · DOCX · TXT · BIB</div>`;
  zone.addEventListener('click', () =>
    (document.getElementById('files-upload-input') as HTMLInputElement | null)?.click(),
  );
  frag.append(zone);
  return frag;
}

/** Folders first, files after. `Array.prototype.sort` is stable (ES2019), so
 * the server's `localeCompare` order survives inside each group. */
function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1));
}

/**
 * The whole tree, rooted in a real "Project root" treeitem.
 *
 * The root row is not decoration: it is the only keyboard path back to a
 * root upload target, the only place that target is announced, and the drop
 * target for "move this to the top level".
 */
function renderTree(nodes: TreeNode[]): HTMLUListElement {
  groupSeq = 0;
  const ul = document.createElement('ul');
  ul.className = 'file-list';
  ul.setAttribute('role', 'group');
  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  const group = renderNodes(nodes, 2);
  group.id = ROOT_GROUP_ID;
  li.append(rootRow(group.id, nodes.length > 0), group);
  ul.append(li);
  return ul;
}

function labelRoot(btn: HTMLElement | null): void {
  if (!btn) return;
  btn.setAttribute(
    'aria-label',
    btn.classList.contains('is-target') ? `${ROOT_LABEL}, upload target` : ROOT_LABEL,
  );
}

function rootRow(groupId: string, hasChildren: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file-row file-root-row';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'file-entry file-root';
  btn.dataset.dir = ''; // upload / drop destination = the project root
  btn.setAttribute('role', 'treeitem');
  btn.setAttribute('tabindex', '-1');
  btn.setAttribute('aria-level', '1');
  btn.setAttribute('aria-posinset', '1');
  btn.setAttribute('aria-setsize', '1');
  // An empty project has no group to expand — announce the root as a leaf
  // rather than as an expanded parent with nothing under it.
  if (hasChildren) {
    btn.setAttribute('aria-expanded', 'true');
    // The child group is a SIBLING of the treeitem, so the treeitem has to own
    // it explicitly or nothing associates the tree's levels.
    btn.setAttribute('aria-owns', groupId);
  }
  btn.setAttribute('aria-keyshortcuts', 'N');
  btn.title = 'Uploads and new folders land in the selected folder';
  btn.innerHTML = icon('folder', { size: 14, stroke: 1.7 }).replace('<svg', '<svg class="file-icon"');
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = ROOT_LABEL;
  btn.append(name);
  if (selectedDir() === '') {
    btn.classList.add('is-target');
    btn.setAttribute('aria-current', 'true');
  }
  labelRoot(btn);
  btn.addEventListener('click', () => selectDir(''));

  const actions = document.createElement('div');
  actions.className = 'file-actions';
  actions.append(actionButton('folder-plus', 'New folder (N)', () => void beginNewFolder('')));
  row.append(btn, actions);
  return row;
}

function renderNodes(nodes: TreeNode[], level: number): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.className = 'file-list';
  ul.setAttribute('role', 'group');
  const sorted = sortNodes(nodes);
  sorted.forEach((node, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    li.append(
      node.type === 'dir'
        ? renderFolder(node, level, i + 1, sorted.length)
        : renderFile(node, level, i + 1, sorted.length),
    );
    ul.append(li);
  });
  return ul;
}

function renderFolder(
  node: TreeNode,
  level: number,
  posinset: number,
  setsize: number,
): HTMLDetailsElement {
  const details = document.createElement('details');
  details.dataset.dir = node.path; // drop target for directory-scoped uploads

  const summary = document.createElement('summary');
  summary.dataset.path = node.path;
  summary.setAttribute('role', 'treeitem');
  summary.setAttribute('tabindex', '-1');
  summary.setAttribute('aria-level', String(level));
  summary.setAttribute('aria-posinset', String(posinset));
  summary.setAttribute('aria-setsize', String(setsize));
  // Unmodified single keys, deliberately: Ctrl/Cmd+Shift+N is a reserved
  // browser accelerator (new Incognito window) that the page never receives,
  // and Cmd+M is Minimize on macOS. No modifiers means nothing to compute per
  // platform, and nothing advertised here is unbound.
  summary.setAttribute('aria-keyshortcuts', 'N R F2 M Delete Backspace');
  summary.draggable = true;

  const children = node.children ?? [];
  const group = renderNodes(children, level + 1);
  group.id = `ft-group-${++groupSeq}`;

  // ONE value drives both. Assigning `open = false` to a fresh <details> is a
  // no-op that fires NO toggle event, so a hard-coded aria-expanded="true"
  // would announce every restored-collapsed folder as expanded.
  const open = isExpanded(node.path);
  details.open = open;
  // An EMPTY folder is a leaf, and this story makes empty folders common
  // (createProjectDir writes no sentinel and walkTree lists them). Announcing
  // "collapsed" on something with nothing to expand sends a screen-reader user
  // hunting for children that do not exist — omit both attributes entirely
  // rather than setting aria-expanded="false".
  if (children.length > 0) {
    summary.setAttribute('aria-owns', group.id);
    summary.setAttribute('aria-expanded', String(open));
  }

  summary.innerHTML = icon('chevron-down', { size: 13, stroke: 2 }).replace(
    '<svg',
    '<svg class="file-chevron"',
  );
  const label = document.createElement('span');
  label.className = 'file-folder-name';
  label.textContent = node.name;
  const meta = document.createElement('span');
  meta.className = 'file-rollup';
  summary.append(label, meta, fileActions(node));

  if (selectedDir() === node.path) {
    summary.classList.add('is-target');
    summary.setAttribute('aria-current', 'true');
  }
  updateFolderMeta(summary, node, open);

  // Persist from the USER's toggle, never from the render's own. `toggle` is
  // fired from a queued task, so a synchronous "rendering" flag around
  // renderNodes would already be cleared by the time it lands — the reliable
  // discriminator is whether the state actually differs from what this render
  // wrote. (tree-state also coalesces its writes, so this is belt and braces.)
  let renderedOpen = open;
  details.addEventListener('toggle', () => {
    // Only if the folder actually has children — see the leaf rationale above.
    if (summary.hasAttribute('aria-expanded')) {
      summary.setAttribute('aria-expanded', String(details.open));
    }
    updateFolderMeta(summary, findNode(node.path) ?? node, details.open);
    if (details.open === renderedOpen) return;
    renderedOpen = details.open;
    setExpanded(node.path, details.open);
  });

  // Clicking a folder both selects it as the target and toggles it (VS Code).
  summary.addEventListener('click', (e) => {
    if (inlineEditing) return;
    if ((e.target as HTMLElement).closest('.file-actions, .file-name-input')) return;
    selectDir(node.path);
  });

  details.append(summary, group);
  return details;
}

/**
 * Recompute a folder row's counts and accessible name.
 *
 * `.file-count` stays visible in BOTH states — it is visible today for open
 * folders and hiding it would be a regression — but its meaning switches:
 * total descendants while collapsed (nothing invisible), direct children while
 * open (what you can actually see). Only the unseen/comment rollups collapse
 * away, via CSS.
 */
function updateFolderMeta(summary: HTMLElement, node: TreeNode, open: boolean): void {
  const wrap = summary.querySelector<HTMLElement>('.file-rollup');
  if (!wrap) return;
  const total = rollup(node, ROLLUP_PROBE, phantomProposals());
  const direct = (node.children ?? []).filter((c) => c.type === 'file').length;
  const shown = open ? direct : total.files;
  const parts: HTMLElement[] = [];
  if (shown > 0) {
    const count = document.createElement('span');
    count.className = 'file-count';
    count.textContent = String(shown);
    count.setAttribute('aria-hidden', 'true');
    parts.push(count);
  }
  if (total.unseen > 0) {
    const badge = textBadge(String(total.unseen));
    badge.classList.add('is-rollup');
    badge.setAttribute('aria-hidden', 'true');
    parts.push(badge);
  }
  // Phantom proposals have no row of their own, so an OPEN folder — whose
  // children otherwise carry the badges — still shows this one (story
  // 012-005). Collapsed, they are already inside the rollup badge above;
  // `is-rollup` display is state-gated in CSS, so both never show at once.
  if (open && total.phantoms > 0) {
    const badge = textBadge(String(total.phantoms));
    badge.classList.add('is-phantom');
    badge.setAttribute('aria-hidden', 'true');
    parts.push(badge);
  }
  if (total.comments > 0) {
    const badge = textBadge(String(total.comments));
    badge.classList.add('is-comment', 'is-rollup');
    badge.setAttribute('aria-hidden', 'true');
    parts.push(badge);
  }
  wrap.replaceChildren(...parts);

  const bits = [`${node.name} folder`, `${total.files} item${total.files === 1 ? '' : 's'}`];
  if (!open) {
    if (total.unseen > 0) bits.push(`${total.unseen} unseen`);
    if (total.comments > 0) {
      bits.push(`${total.comments} open comment${total.comments === 1 ? '' : 's'}`);
    }
  } else if (total.phantoms > 0) {
    bits.push(`${total.phantoms} proposed new file${total.phantoms === 1 ? '' : 's'}`);
  }
  if (summary.classList.contains('is-target')) bits.push('upload target');
  summary.setAttribute('aria-label', bits.join(', '));
}

/** Recompute every rendered folder's rollup — after an in-place badge patch
 * (markSeen) or a target change, where no re-render runs. */
function updateRollups(): void {
  const root = document.getElementById('file-tree');
  if (!root) return;
  root.querySelectorAll<HTMLElement>('summary[data-path]').forEach((summary) => {
    const node = findNode(summary.dataset.path ?? '');
    if (!node) return;
    const details = summary.parentElement as HTMLDetailsElement | null;
    updateFolderMeta(summary, node, details?.open ?? true);
  });
}

/** Spoken text for a badge state — the treeitem label carries it (005-004). */
const STATUS_TEXT: Record<FileStatusKind, string> = {
  new: 'new upload',
  generated: 'new AI changes',
  modified: 'modified since last viewed',
  ingesting: 'processing',
  done: 'processed',
  suggested: 'suggested changes awaiting review',
};

function renderFile(
  node: TreeNode,
  level: number,
  posinset: number,
  setsize: number,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file-row';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-entry';
  button.dataset.path = node.path;
  button.setAttribute('role', 'treeitem');
  button.setAttribute('tabindex', '-1');
  button.setAttribute('aria-level', String(level));
  button.setAttribute('aria-posinset', String(posinset));
  button.setAttribute('aria-setsize', String(setsize));
  button.setAttribute('aria-keyshortcuts', 'N R F2 M L Delete Backspace');
  button.setAttribute('aria-selected', String(node.path === activePath));
  button.draggable = true;
  if (node.path === activePath) button.classList.add('active');

  // A live org-library ingest badge outranks unseen state (story 006-004);
  // a pending suggestion outranks new/modified (story 008-001).
  const ingest = ingestMap.get(node.path);
  const st: FileStatus | undefined = ingest
    ? { status: ingest }
    : suggestMap.has(node.path)
      ? { status: 'suggested', originAgent: suggestMap.get(node.path) ?? undefined }
      : statusMap.get(node.path);
  // Recorded origin (badge, then activity history) beats the extension guess.
  const originAgent = st?.originAgent ?? originMap.get(node.path);
  const origin = originAgent ? ORIGIN_CLASS[originAgent] ?? '' : originClass(node.name);
  const iconSvg = icon('file-text', { size: 14, stroke: 1.7 }).replace(
    '<svg',
    `<svg class="file-icon${origin ? ` ${origin}` : ''}"`,
  );
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = node.name;

  button.innerHTML = iconSvg;
  button.append(name);
  // Badge visuals are decorative here — the status is spoken via the
  // treeitem's accessible name, not the color/dot alone (story 005-004).
  const commentCount = commentMap.get(node.path) ?? 0;
  const externalText = st?.external
    ? `changed by external reviewer${st.reviewerName ? ` ${st.reviewerName}` : ''}`
    : '';
  const ariaStatus = [
    st ? (externalText || STATUS_TEXT[st.status]) : '',
    commentCount > 0 ? `${commentCount} open comment${commentCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');
  button.setAttribute('aria-label', ariaStatus ? `${node.name}, ${ariaStatus}` : node.name);
  // An external reviewer's change gets an origin badge of its own (epic 013)
  // in place of the member/agent unseen badge.
  const badge = st?.external ? externalBadge(st.reviewerName) : statusBadge(st);
  if (badge) {
    badge.setAttribute('aria-hidden', 'true');
    button.append(badge);
  }
  // Unresolved margin comments ride alongside any status badge (story 008-004).
  if (commentCount > 0) {
    const cb = textBadge(String(commentCount));
    cb.classList.add('is-comment');
    cb.setAttribute('aria-hidden', 'true');
    button.append(cb);
  }

  // Any text-format file opens in the editor (issue #44); only binaries
  // (pdf, images, docx, …) go to the preview pane.
  const isEditable = isEditableText(node.path);
  button.title = isEditable ? `Open ${node.path} in the editor` : `Preview ${node.path}`;
  if (node.mtime) button.title += `\nModified ${new Date(node.mtime).toLocaleString()}`;
  button.addEventListener('click', () => {
    if (inlineEditing) return;
    if (isEditable) {
      handlers?.onOpenMarkdown(node.path); // marks seen via setActiveFile
    } else {
      markSeen(node.path); // previews don't go through setActiveFile
      handlers?.onPreviewFile(node.path);
    }
  });

  row.append(button, fileActions(node));
  return row;
}

function fileActions(node: TreeNode): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'file-actions';
  if (node.type === 'dir') {
    wrap.append(
      actionButton('folder-plus', 'New folder inside (N)', () => void beginNewFolder(node.path)),
      actionButton('corner-up-right', 'Move to… (M)', () => openMoveFor(node)),
      actionButton('pencil', 'Rename (R)', () => beginRename(node)),
      actionButton('trash', 'Delete (Del or Backspace)', () => void deleteEntry(node)),
    );
  } else {
    wrap.append(
      actionButton('book', 'Add to org library (L)', () => void promoteEntry(node)),
      actionButton('corner-up-right', 'Move to… (M)', () => openMoveFor(node)),
      actionButton('pencil', 'Rename (R)', () => beginRename(node)),
      actionButton('trash', 'Delete (Del or Backspace)', () => void deleteEntry(node)),
    );
  }
  return wrap;
}

function actionButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'file-action';
  b.title = title;
  b.setAttribute('aria-label', title);
  // N rows must not inject 4N stops into the Tab order; the single-key row
  // shortcuts are the keyboard path to all of these.
  b.tabIndex = -1;
  b.draggable = false;
  b.innerHTML = icon(name, { size: 13, stroke: 1.7 });
  b.addEventListener('click', (e) => {
    // preventDefault, not just stopPropagation: these buttons now live inside
    // a <summary>, and a click that reaches the summary toggles the disclosure.
    // stopPropagation does not cancel a default action; preventDefault does.
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Per-file status badge, using the visual classes shipped in story 025. */
function statusBadge(st?: FileStatus): Element | null {
  if (!st) return null;
  switch (st.status) {
    case 'new':
      return textBadge('new');
    case 'generated':
      return textBadge('ai');
    case 'suggested': {
      const badge = textBadge('suggested');
      badge.classList.add('is-suggested');
      return badge;
    }
    case 'modified': {
      const badge = document.createElement('span');
      badge.className = 'file-badge is-modified';
      const dot = document.createElement('span');
      dot.className = 'file-dot';
      badge.append(dot);
      return badge;
    }
    case 'ingesting': {
      const spinner = document.createElement('span');
      spinner.className = 'file-spinner';
      return spinner;
    }
    case 'done': {
      const check = iconEl('check', { size: 13, stroke: 2 });
      check.classList.add('file-done');
      return check;
    }
  }
}

function textBadge(label: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'file-badge';
  badge.textContent = label;
  return badge;
}

/** "external" origin badge for changes made through a review link (epic 013).
 * It IS unseen state (markSeen's selector removes plain file-badges), unlike
 * the suggested/comment badges, so opening the file clears it. */
function externalBadge(reviewerName?: string | null): HTMLElement {
  const badge = textBadge('external');
  badge.classList.add('is-external');
  if (reviewerName) badge.title = `Changed by ${reviewerName} (external reviewer)`;
  return badge;
}

/** Origin-agent icon tint inferred from the file type, used until the status
 * map has an explicit originAgent for a path. */
function originClass(name: string): string {
  if (name.endsWith('.bib')) return 'origin-ra';
  if (name.endsWith('.pdf')) return 'origin-reviewer';
  if (name.endsWith('.docx')) return 'origin-pm';
  return '';
}

// ---- Tree keyboard navigation (story 005-004) --------------------------------

/** Treeitems currently rendered and visible (rows inside a closed folder are
 * display:none and drop out via offsetParent). */
function visibleTreeItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .filter((el) => el.offsetParent !== null);
}

/**
 * Exactly one treeitem is tabbable, and — the 012-001 addition — focus is put
 * back where the user left it. Every mutation ends in `replaceChildren`, which
 * detaches the focused node and drops focus to `<body>`; `focusAfterRender`
 * names the row that should get it back.
 */
function initRovingTabindex(root: HTMLElement): void {
  const items = visibleTreeItems(root);
  items.forEach((el) => el.setAttribute('tabindex', '-1'));
  const wanted = focusAfterRender;
  focusAfterRender = null;
  const requested = wanted == null
    ? null
    : wanted === ''
      ? root.querySelector<HTMLElement>('.file-root')
      : root.querySelector<HTMLElement>(`[role="treeitem"][data-path="${cssEscape(wanted)}"]`);
  // The open document still wins the tab entry point; the target folder is the
  // runner-up (the root row is first in DOM order, so an unordered `find` over
  // both classes would always hand it the entry point).
  const fallback =
    items.find((el) => el.classList.contains('active')) ??
    items.find((el) => el.classList.contains('is-target')) ??
    items[0];
  // `requested` is resolved by querySelector, which ignores visibility — a row
  // inside a COLLAPSED folder matches but is not in `items`. Parking the single
  // tab stop there would leave the tree with no reachable entry point at all,
  // so fall back unless the requested row is actually visible.
  const start = requested && items.includes(requested) ? requested : fallback;
  start?.setAttribute('tabindex', '0');
  // Only steal focus when a mutation asked for it. If the requested row is
  // gone (deleted from under us), keep focus inside the tree rather than
  // letting it fall to <body>.
  if (wanted != null) start?.focus();
}

function onTreeKeydown(e: KeyboardEvent): void {
  const root = e.currentTarget as HTMLElement;
  if (inlineEditing) return;
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  const item = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (!item) return;
  const items = visibleTreeItems(root);
  const idx = items.indexOf(item);
  const details = item.tagName === 'SUMMARY' ? (item.parentElement as HTMLDetailsElement) : null;
  const node = item.dataset.path ? findNode(item.dataset.path) : null;

  const focusAt = (i: number): void => {
    items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
  };

  // Row actions on unmodified single keys. Ctrl/Cmd+Shift+N never reaches the
  // page (new Incognito window) and Cmd+M is Minimize on macOS, so a modified
  // chord would have been advertised and dead.
  if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      void beginNewFolder(node ? (node.type === 'dir' ? node.path : parentDir(node.path)) : '');
      return;
    }
    if (node && (e.key === 'r' || e.key === 'R' || e.key === 'F2')) {
      e.preventDefault();
      beginRename(node);
      return;
    }
    if (node && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      openMoveFor(node);
      return;
    }
    // Backspace as well as Delete: on every Mac laptop and the Magic Keyboard
    // the key LABELLED "delete" emits 'Backspace', and fn+delete is the only
    // way to get 'Delete'. The confirm() inside deleteEntry covers the
    // accidental-Backspace risk this opens up.
    if (node && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      void deleteEntry(node);
      return;
    }
    // Promote to the org library. Row action buttons are tabindex=-1, so
    // without a key binding this action was visible on focus but unreachable.
    if (node && node.type === 'file' && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      void promoteEntry(node);
      return;
    }
  }

  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusAt(idx + 1); break;
    case 'ArrowUp': e.preventDefault(); focusAt(idx - 1); break;
    case 'Home': e.preventDefault(); focusAt(0); break;
    case 'End': e.preventDefault(); focusAt(items.length - 1); break;
    case 'ArrowRight':
      e.preventDefault();
      if (details && !details.open) details.open = true;
      else focusAt(idx + 1); // into the (now open) folder, or just onward
      break;
    case 'ArrowLeft': {
      e.preventDefault();
      if (details?.open) {
        details.open = false;
        break;
      }
      // Closed folder or file row: jump to the enclosing folder's summary, or
      // to the project-root row at the top level.
      const parentSummary = (details ?? item).parentElement
        ?.closest('details')
        ?.querySelector<HTMLElement>(':scope > summary[role="treeitem"]');
      (parentSummary ?? root.querySelector<HTMLElement>('.file-root'))?.focus();
      break;
    }
    // Enter/Space activate natively: file rows are <button>, folders <summary>.
  }
}

// Platform CSS.escape (story 005-004) — replaces a hand-rolled escaper that
// only covered quotes/backslashes.
const cssEscape = (value: string): string => CSS.escape(value);
