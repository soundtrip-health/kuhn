// File panel (story 013 shell, restyled by 025, made functional by story 014,
// made live by story 005-003): render the project tree, upload materials
// (drag-drop + picker), preview non-markdown files, and delete/rename entries
// — all through the story-018 storage API. Badge state is server-backed:
// per-user `unseen` flags on the tree plus the file-activity log hydrate the
// status map on every refresh (so badges survive reload), live `file_change`
// events update it between refreshes, and opening a file marks it seen.

import {
  deleteFile,
  getFileActivity,
  getTree,
  markFileSeen,
  moveFile,
  promoteFileToLibrary,
  uploadFiles,
  type FileActivityEvent,
  type TreeNode,
} from './api';
import { icon, iconEl, type IconName } from './icons';
import { watchDocIngestion } from './org-library';
import { toast } from './toast';
import * as workspace from './workspace';

/** Handlers wired by main.ts (it owns the editor + preview pane). */
export interface FilesHandlers {
  /** Open a markdown file in the editor. */
  onOpenMarkdown: (path: string) => void;
  /** Preview a non-markdown file in the preview pane. */
  onPreviewFile: (path: string) => void;
  /** Persist the open document before it is renamed (so edits aren't lost). */
  flushOpenDoc: () => Promise<void> | void;
  /** Re-open the document at its new path after a rename. */
  reopenOpenDoc: (to: string) => void;
  /** The open document was deleted — drop it without re-saving. */
  dropOpenDoc: (deletedPath: string) => void;
}

/** A file-tree change worth tracking for the status map. */
export interface FileChange {
  path: string;
  kind?: 'create' | 'update' | 'delete';
  agent?: string;
}

type FileStatusKind = 'new' | 'modified' | 'generated' | 'ingesting' | 'done';
interface FileStatus {
  status: FileStatusKind;
  originAgent?: string;
}

let projectId = 0;
let handlers: FilesHandlers | null = null;
let listenersWired = false;
let activePath = '';
let lastTree: TreeNode[] = [];
const statusMap = new Map<string, FileStatus>();
/** Org-library ingestion badges for promoted files (story 006-004). Separate
 * from statusMap: it isn't unseen state, so tree re-hydration and mark-seen
 * must not clear it — only the ingestion outcome does. */
const ingestMap = new Map<string, 'ingesting' | 'done'>();
/** Recorded origin agent per path (from the activity log) — outlives badges,
 * so a seen file keeps its agent tint instead of the extension guess. */
const originMap = new Map<string, string>();
/** Throttle mark-seen POSTs: path → last-sent epoch ms. */
const seenSentAt = new Map<string, number>();
let refreshTimer: number | null = null;

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
  seenSentAt.clear();
  updateUnseenPill();
  activePath = '';

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

  const tree = document.getElementById('file-tree')!;
  let dragTarget: HTMLElement | null = null;
  const clearDrag = () => {
    tree.classList.remove('drag-over');
    if (dragTarget) {
      dragTarget.classList.remove('drag-over');
      dragTarget = null;
    }
  };

  tree.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    const dir = (e.target as HTMLElement | null)?.closest('[data-dir]') as HTMLElement | null;
    if (dir !== dragTarget) clearDrag();
    if (dir) {
      dir.classList.add('drag-over');
      dragTarget = dir;
    } else {
      tree.classList.add('drag-over');
    }
  });
  tree.addEventListener('dragleave', (e) => {
    if (e.target === tree) clearDrag();
  });
  tree.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const dir = (e.target as HTMLElement | null)?.closest('[data-dir]') as HTMLElement | null;
    clearDrag();
    void uploadInto(e.dataTransfer.files, dir?.dataset.dir ?? panelTargetDir());
  });

  const input = document.getElementById('files-upload-input') as HTMLInputElement | null;
  document.getElementById('files-upload-btn')?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', () => {
    if (input.files?.length) void uploadInto(input.files, panelTargetDir());
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

export async function refreshTree(activeProjectId: number): Promise<void> {
  projectId = activeProjectId;
  const container = document.getElementById('file-tree')!;
  container.classList.add('is-loading');
  if (!container.hasChildNodes()) container.replaceChildren(emptyNotice('Loading files…'));
  try {
    // Tree carries per-user unseen flags; the activity log supplies each
    // path's latest kind + origin agent. Together they rebuild the status
    // map from server truth, so badges survive reload (story 005-003).
    const [tree, activity] = await Promise.all([
      getTree(activeProjectId),
      getFileActivity(activeProjectId).catch(() => [] as FileActivityEvent[]),
    ]);
    if (projectId !== activeProjectId) return; // superseded by a project switch
    lastTree = tree;
    hydrateStatus(tree, activity);
    container.replaceChildren(lastTree.length > 0 ? renderNodes(lastTree) : emptyState());
    initRovingTabindex(container);
  } catch (err) {
    const notice = emptyNotice(`Could not load files: ${(err as Error).message}`);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-quiet btn-sm';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => void refreshTree(activeProjectId));
    notice.append(document.createElement('br'), retry);
    container.replaceChildren(notice);
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
function hydrateStatus(tree: TreeNode[], activity: FileActivityEvent[]): void {
  statusMap.clear();
  originMap.clear();
  // Newest-first log: keep each path's latest event only.
  const latest = new Map<string, FileActivityEvent>();
  for (const ev of activity) {
    if (!latest.has(ev.path)) latest.set(ev.path, ev);
    if (ev.agent_slug && !originMap.has(ev.path)) originMap.set(ev.path, ev.agent_slug);
  }
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'dir') {
        walk(node.children ?? []);
      } else if (node.unseen) {
        const ev = latest.get(node.path);
        statusMap.set(node.path, {
          status: !ev
            ? 'modified' // unseen but the event aged out of the log
            : ev.agent_slug
              ? (ev.kind === 'create' ? 'generated' : 'modified')
              : (ev.kind === 'create' ? 'new' : 'modified'),
          originAgent: ev?.agent_slug ?? (ev ? 'user' : undefined),
        });
      }
    }
  };
  walk(tree);
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
    // Spinner/check belong to the org-library ingest flow (ingestMap), which
    // opening the file doesn't resolve — remove only the unseen badge.
    entry?.querySelectorAll('.file-badge').forEach((el) => el.remove());
    updateUnseenPill();
  }
  const last = seenSentAt.get(path) ?? 0;
  if (Date.now() - last < 3000) return;
  seenSentAt.set(path, Date.now());
  void markFileSeen(projectId, path).catch(() => {
    seenSentAt.delete(path); // let a later open retry
  });
}

/** Unseen-count pill on the topbar Files toggle (story 005-003). */
function updateUnseenPill(): void {
  const toggle = document.getElementById('toggle-files');
  if (!toggle) return;
  let pill = toggle.querySelector<HTMLElement>('.toggle-pill');
  const count = [...statusMap.values()]
    .filter((s) => s.status === 'new' || s.status === 'generated' || s.status === 'modified')
    .length;
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
 * Resolve which document to open for the current project (story 006). Returns
 * `preferred` if it's an existing `.md` in the tree, else the first `.md` found
 * (depth-first), else null. Call after `refreshTree` so `lastTree` is current.
 */
export function findMarkdownPath(preferred?: string): string | null {
  let first: string | null = null;
  let preferredExists = false;
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'dir') walk(node.children ?? []);
      else if (node.path.endsWith('.md')) {
        if (first == null) first = node.path;
        if (node.path === preferred) preferredExists = true;
      }
    }
  };
  walk(lastTree);
  if (preferred && preferredExists) return preferred;
  return first;
}

/**
 * Reveal the open document in the tree (story 007 breadcrumb): make sure the
 * files panel is visible, expand the row's ancestor folders, highlight it, and
 * scroll it into view.
 */
export function revealFile(path: string): void {
  document.getElementById('files-panel')?.classList.remove('collapsed');
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
  if (change.kind === 'delete') {
    statusMap.delete(change.path);
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

function migrateStatus(from: string, to: string): void {
  const st = statusMap.get(from);
  statusMap.delete(from);
  if (st) statusMap.set(to, st);
  const origin = originMap.get(from);
  originMap.delete(from);
  if (origin) originMap.set(to, origin);
  seenSentAt.delete(from);
}

// ---- Upload -----------------------------------------------------------------

/** Default panel-level drop target: `sources/` (where seeding expects user
 * materials) if it exists at the top level, else the project root. */
function panelTargetDir(): string | undefined {
  return lastTree.some((n) => n.type === 'dir' && n.name === 'sources') ? 'sources' : undefined;
}

async function uploadInto(fileList: FileList | File[], dir?: string): Promise<void> {
  const files = Array.from(fileList);
  if (files.length === 0) return;
  const { uploaded, failed } = await uploadFiles(projectId, files, dir);
  for (const u of uploaded) recordUpload(u.path);
  await refreshTree(projectId);
  if (uploaded.length > 0) {
    const where = dir ? ` to ${dir}` : '';
    toast(`Uploaded ${uploaded.length} file${uploaded.length === 1 ? '' : 's'}${where}`);
  }
  for (const f of failed) toast(`${f.name}: ${f.error}`);
}

// ---- Manage (delete / rename) -----------------------------------------------

async function deleteEntry(node: TreeNode): Promise<void> {
  const isOpen = node.path === activePath;
  const message = isOpen
    ? `Delete "${node.name}"? It's the document you're editing — the editor will close.`
    : `Delete "${node.name}"?`;
  // Documented exception (story 005-004): native confirm() is keyboard- and
  // screen-reader-accessible by construction; a styled dialog isn't worth its
  // focus-management surface until one exists elsewhere in the app.
  if (!window.confirm(message)) return;
  if (isOpen) handlers?.dropOpenDoc(node.path); // drop before delete so no save resurrects it
  try {
    await deleteFile(projectId, node.path);
  } catch (err) {
    toast(`Delete failed: ${(err as Error).message}`);
    return;
  }
  statusMap.delete(node.path);
  await refreshTree(projectId);
}

function beginRename(node: TreeNode): void {
  const row = document
    .querySelector(`.file-entry[data-path="${cssEscape(node.path)}"]`)
    ?.closest('.file-row');
  if (!row) return;

  const input = document.createElement('input');
  input.className = 'file-name-input';
  input.value = node.name;
  row.replaceChildren(input);
  input.focus();
  const stem = node.name.replace(/\.[^.]+$/, '').length;
  input.setSelectionRange(0, stem || node.name.length);

  let settled = false;
  const finish = (commit: boolean): void => {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();
    if (commit && newName && newName !== node.name) {
      void renameEntry(node, newName);
    } else {
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

async function renameEntry(node: TreeNode, newName: string): Promise<void> {
  const to = joinName(node.path, newName);
  const isOpen = node.path === activePath;
  if (isOpen) await handlers?.flushOpenDoc(); // persist edits to the old path first
  try {
    await moveFile(projectId, node.path, to);
  } catch (err) {
    toast(`Rename failed: ${(err as Error).message}`);
    await refreshTree(projectId);
    return;
  }
  migrateStatus(node.path, to);
  if (isOpen) {
    activePath = to;
    handlers?.reopenOpenDoc(to);
  }
  await refreshTree(projectId);
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

function renderNodes(nodes: TreeNode[]): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.className = 'file-list';
  ul.setAttribute('role', 'group');
  for (const node of nodes) {
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    if (node.type === 'dir') {
      const details = document.createElement('details');
      details.open = true;
      details.dataset.dir = node.path; // drop target for directory-scoped uploads
      const summary = document.createElement('summary');
      summary.setAttribute('role', 'treeitem');
      summary.setAttribute('aria-expanded', 'true');
      summary.setAttribute('tabindex', '-1');
      details.addEventListener('toggle', () =>
        summary.setAttribute('aria-expanded', String(details.open)),
      );
      const fileCount = (node.children ?? []).filter((c) => c.type === 'file').length;
      summary.innerHTML = icon('chevron-down', { size: 13, stroke: 2 }).replace(
        '<svg',
        '<svg class="file-chevron"',
      );
      const label = document.createElement('span');
      label.className = 'file-folder-name';
      label.textContent = node.name;
      summary.append(label);
      if (fileCount > 0) {
        const count = document.createElement('span');
        count.className = 'file-count';
        count.textContent = String(fileCount);
        count.setAttribute('aria-label', `${fileCount} file${fileCount === 1 ? '' : 's'}`);
        summary.append(count);
      }
      details.append(summary, renderNodes(node.children ?? []));
      li.append(details);
    } else {
      li.append(renderFile(node));
    }
    ul.append(li);
  }
  return ul;
}

/** Spoken text for a badge state — the treeitem label carries it (005-004). */
const STATUS_TEXT: Record<FileStatusKind, string> = {
  new: 'new upload',
  generated: 'new AI changes',
  modified: 'modified since last viewed',
  ingesting: 'processing',
  done: 'processed',
};

function renderFile(node: TreeNode): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file-row';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-entry';
  button.dataset.path = node.path;
  button.setAttribute('role', 'treeitem');
  button.setAttribute('tabindex', '-1');
  button.setAttribute('aria-selected', String(node.path === activePath));
  if (node.path === activePath) button.classList.add('active');

  // A live org-library ingest badge outranks unseen state (story 006-004).
  const ingest = ingestMap.get(node.path);
  const st: FileStatus | undefined = ingest ? { status: ingest } : statusMap.get(node.path);
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
  button.setAttribute('aria-label', st ? `${node.name}, ${STATUS_TEXT[st.status]}` : node.name);
  const badge = statusBadge(st);
  if (badge) {
    badge.setAttribute('aria-hidden', 'true');
    button.append(badge);
  }

  const isMarkdown = node.path.endsWith('.md');
  button.title = isMarkdown ? `Open ${node.path} in the editor` : `Preview ${node.path}`;
  if (node.mtime) button.title += `\nModified ${new Date(node.mtime).toLocaleString()}`;
  button.addEventListener('click', () => {
    if (isMarkdown) {
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
  wrap.append(
    actionButton('book', 'Add to org library', () => void promoteEntry(node)),
    actionButton('pencil', 'Rename', () => beginRename(node)),
    actionButton('trash', 'Delete', () => void deleteEntry(node)),
  );
  return wrap;
}

function actionButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'file-action';
  b.title = title;
  b.innerHTML = icon(name, { size: 13, stroke: 1.7 });
  b.addEventListener('click', (e) => {
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

function initRovingTabindex(root: HTMLElement): void {
  const items = visibleTreeItems(root);
  items.forEach((el) => el.setAttribute('tabindex', '-1'));
  const start = items.find((el) => el.classList.contains('active')) ?? items[0];
  start?.setAttribute('tabindex', '0');
}

function onTreeKeydown(e: KeyboardEvent): void {
  const root = e.currentTarget as HTMLElement;
  const item = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (!item) return;
  const items = visibleTreeItems(root);
  const idx = items.indexOf(item);
  const details = item.tagName === 'SUMMARY' ? (item.parentElement as HTMLDetailsElement) : null;

  const focusAt = (i: number): void => {
    items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
  };

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
      // Closed folder or file row: jump to the enclosing folder's summary.
      (details ?? item).parentElement
        ?.closest('details')
        ?.querySelector<HTMLElement>(':scope > summary[role="treeitem"]')
        ?.focus();
      break;
    }
    // Enter/Space activate natively: file rows are <button>, folders <summary>.
  }
}

// ---- Path helpers -----------------------------------------------------------

function joinName(path: string, name: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? name : `${path.slice(0, slash)}/${name}`;
}

// Platform CSS.escape (story 005-004) — replaces a hand-rolled escaper that
// only covered quotes/backslashes.
const cssEscape = (value: string): string => CSS.escape(value);
