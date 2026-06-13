// File panel (story 013 shell, restyled by 025, made functional by story 014):
// render the project tree, upload materials (drag-drop + picker), preview
// non-markdown files, and delete/rename entries — all through the story-018
// storage API. A client-side status map (fed by `file_change` events and
// upload activity) drives the per-file origin tint and status badge designed in
// story 025; the badge CSS classes (.file-badge/.file-spinner/.file-done) are
// already shipped, this module supplies their data.

import { deleteFile, getTree, moveFile, uploadFiles, type TreeNode } from './api';
import { icon, iconEl } from './icons';
import { toast } from './toast';

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
let activePath = '';
let lastTree: TreeNode[] = [];
const statusMap = new Map<string, FileStatus>();

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
}

/** Mark a file row as the open document and re-highlight without refetching. */
export function setActiveFile(path: string): void {
  activePath = path;
  const tree = document.getElementById('file-tree');
  if (!tree) return;
  tree.querySelectorAll('.file-entry.active').forEach((el) => el.classList.remove('active'));
  tree.querySelector(`.file-entry[data-path="${cssEscape(path)}"]`)?.classList.add('active');
}

export async function refreshTree(activeProjectId: number): Promise<void> {
  projectId = activeProjectId;
  const container = document.getElementById('file-tree')!;
  try {
    lastTree = await getTree(activeProjectId);
    container.replaceChildren(lastTree.length > 0 ? renderNodes(lastTree) : emptyState());
  } catch (err) {
    container.replaceChildren(emptyNotice(`Could not load files: ${(err as Error).message}`));
  }
}

// ---- Status map (story 025 badge data) --------------------------------------

/** Record a `file_change` (or citation) event into the status map. */
export function recordFileChange(change: FileChange): void {
  if (change.kind === 'delete') {
    statusMap.delete(change.path);
    return;
  }
  statusMap.set(change.path, {
    status: change.kind === 'create' ? 'generated' : 'modified',
    originAgent: change.agent,
  });
}

function recordUpload(path: string): void {
  statusMap.set(path, { status: 'new', originAgent: 'user' });
}

function migrateStatus(from: string, to: string): void {
  const st = statusMap.get(from);
  statusMap.delete(from);
  if (st) statusMap.set(to, st);
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
  for (const node of nodes) {
    const li = document.createElement('li');
    if (node.type === 'dir') {
      const details = document.createElement('details');
      details.open = true;
      details.dataset.dir = node.path; // drop target for directory-scoped uploads
      const summary = document.createElement('summary');
      const fileCount = (node.children ?? []).filter((c) => c.type === 'file').length;
      summary.innerHTML = icon('chevron-down', { size: 13, stroke: 2 }).replace(
        '<svg',
        '<svg class="file-chevron"',
      );
      const label = document.createElement('span');
      label.textContent = node.name;
      summary.append(label);
      if (fileCount > 0) {
        const count = document.createElement('span');
        count.className = 'file-count';
        count.textContent = String(fileCount);
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

function renderFile(node: TreeNode): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file-row';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-entry';
  button.dataset.path = node.path;
  if (node.path === activePath) button.classList.add('active');

  const st = statusMap.get(node.path);
  const origin = st?.originAgent ? ORIGIN_CLASS[st.originAgent] ?? '' : originClass(node.name);
  const iconSvg = icon('file-text', { size: 14, stroke: 1.7 }).replace(
    '<svg',
    `<svg class="file-icon${origin ? ` ${origin}` : ''}"`,
  );
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = node.name;

  button.innerHTML = iconSvg;
  button.append(name);
  const badge = statusBadge(st);
  if (badge) button.append(badge);

  const isMarkdown = node.path.endsWith('.md');
  button.title = isMarkdown ? `Open ${node.path} in the editor` : `Preview ${node.path}`;
  button.addEventListener('click', () => {
    if (isMarkdown) handlers?.onOpenMarkdown(node.path);
    else handlers?.onPreviewFile(node.path);
  });

  row.append(button, fileActions(node));
  return row;
}

function fileActions(node: TreeNode): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'file-actions';
  wrap.append(
    actionButton('pencil', 'Rename', () => beginRename(node)),
    actionButton('trash', 'Delete', () => void deleteEntry(node)),
  );
  return wrap;
}

function actionButton(name: 'pencil' | 'trash', title: string, onClick: () => void): HTMLButtonElement {
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

// ---- Path helpers -----------------------------------------------------------

function joinName(path: string, name: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? name : `${path.slice(0, slash)}/${name}`;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
