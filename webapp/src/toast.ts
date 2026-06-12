// Toasts (story 025): bottom-center of the editor, ink bg, a --good dot,
// fade-and-rise in, auto-dismiss ~2.6s. Used by /cite insert and export.

const DISMISS_MS = 2600;

function layer(): HTMLElement {
  let el = document.getElementById('toast-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-layer';
    (document.getElementById('editor-pane') ?? document.body).append(el);
  }
  return el;
}

/** Show a transient confirmation toast. */
export function toast(message: string): void {
  const node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('role', 'status');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const text = document.createElement('span');
  text.textContent = message;
  node.append(dot, text);
  layer().append(node);
  setTimeout(() => node.remove(), DISMISS_MS);
}
