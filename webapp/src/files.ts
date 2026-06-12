// File panel (story 013, restyled for story 025): render the project tree from
// the backend with per-file-type line icons, collapsible folders with a count,
// and origin-agent icon tinting. The backend tree exposes name/path/type today;
// richer per-file status (ingesting/generated badges) needs a small file_change
// payload extension (deferred) — here we infer a light origin tint from the file
// type, and highlight the open document. The empty state shows the upload
// drop-zone visual (functional upload lands with story 014).

import { getTree, type TreeNode } from './api';
import { icon } from './icons';

let onOpenMarkdown: (path: string) => void = () => {};
let activePath = '';

export function onOpenMarkdownFile(handler: (path: string) => void): void {
  onOpenMarkdown = handler;
}

/** Mark a file row as the open document and re-highlight without refetching. */
export function setActiveFile(path: string): void {
  activePath = path;
  const tree = document.getElementById('file-tree');
  if (!tree) return;
  tree.querySelectorAll('.file-entry.active').forEach((el) => el.classList.remove('active'));
  tree.querySelector(`.file-entry[data-path="${cssEscape(path)}"]`)?.classList.add('active');
}

export async function refreshTree(projectId: number): Promise<void> {
  const container = document.getElementById('file-tree')!;
  try {
    const tree = await getTree(projectId);
    container.replaceChildren(tree.length > 0 ? renderNodes(tree) : emptyState());
  } catch (err) {
    container.replaceChildren(emptyNotice(`Could not load files: ${(err as Error).message}`));
  }
}

function emptyNotice(text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'file-empty';
  div.textContent = text;
  return div;
}

/** Empty-state drop zone (design here; functional upload in story 014). */
function emptyState(): DocumentFragment {
  const frag = document.createDocumentFragment();
  const zone = document.createElement('div');
  zone.className = 'drop-zone';
  zone.innerHTML =
    `<div class="dz-icon">${icon('upload', { size: 18, stroke: 1.7 })}</div>` +
    `<div class="dz-title">Upload materials</div>` +
    `<div class="dz-sub">Drop protocols, guidance, prior drafts. The Advisor reads them during seeding.</div>` +
    `<div class="dz-types">PDF · DOCX · TXT · BIB</div>`;
  const hint = document.createElement('div');
  hint.className = 'file-empty';
  hint.style.textAlign = 'center';
  hint.style.marginTop = '16px';
  hint.textContent = 'No files yet.';
  frag.append(zone, hint);
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
      const summary = document.createElement('summary');
      const fileCount = (node.children ?? []).filter((c) => c.type === 'file').length;
      summary.innerHTML = icon('chevron-down', { size: 13, stroke: 2 }).replace('<svg', '<svg class="file-chevron"');
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

function renderFile(node: TreeNode): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-entry';
  button.dataset.path = node.path;
  if (node.path === activePath) button.classList.add('active');

  const origin = originClass(node.name);
  const iconSvg = icon('file-text', { size: 14, stroke: 1.7 }).replace(
    '<svg',
    `<svg class="file-icon${origin ? ` ${origin}` : ''}"`,
  );
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = node.name;

  button.innerHTML = iconSvg;
  button.append(name);

  if (node.path.endsWith('.md')) {
    button.title = `Open ${node.path} in the editor`;
    button.addEventListener('click', () => onOpenMarkdown(node.path));
  } else {
    button.disabled = true;
    button.title = 'Preview arrives with the file manager (story 014)';
  }
  return button;
}

/** Origin-agent icon tint inferred from the file type (no backend status yet). */
function originClass(name: string): string {
  if (name.endsWith('.bib')) return 'origin-ra';
  if (name.endsWith('.pdf')) return 'origin-reviewer';
  if (name.endsWith('.docx')) return 'origin-pm';
  return '';
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
