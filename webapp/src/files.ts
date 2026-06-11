// File panel shell (story 013): render the project tree from the backend.
// Upload/preview and richer management land with story 014.

import { getTree, type TreeNode } from './api';

let onOpenMarkdown: (path: string) => void = () => {};

export function onOpenMarkdownFile(handler: (path: string) => void): void {
  onOpenMarkdown = handler;
}

export async function refreshTree(projectId: number): Promise<void> {
  const container = document.getElementById('file-tree')!;
  try {
    const tree = await getTree(projectId);
    container.replaceChildren(
      tree.length > 0 ? renderNodes(tree) : emptyNotice('No files yet.'),
    );
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

function renderNodes(nodes: TreeNode[]): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.className = 'file-list';
  for (const node of nodes) {
    const li = document.createElement('li');
    if (node.type === 'dir') {
      const details = document.createElement('details');
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = node.name;
      details.append(summary, renderNodes(node.children ?? []));
      li.append(details);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-entry';
      button.textContent = node.name;
      if (node.path.endsWith('.md')) {
        button.title = `Open ${node.path} in the editor`;
        button.addEventListener('click', () => onOpenMarkdown(node.path));
      } else {
        button.disabled = true;
        button.title = 'Preview arrives with the file manager (story 014)';
      }
      li.append(button);
    }
    ul.append(li);
  }
  return ul;
}
