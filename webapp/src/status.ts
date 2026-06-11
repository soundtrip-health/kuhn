// Status bar: render/save state, agent activity, token usage.

const el = (id: string) => document.getElementById(id)!;

export type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

export function setSaveState(state: SaveState, detail = ''): void {
  const labels: Record<SaveState, string> = {
    saved: 'saved',
    saving: 'saving…',
    dirty: 'unsaved changes',
    error: `save failed${detail ? `: ${detail}` : ''}`,
  };
  const node = el('status-save');
  node.textContent = labels[state];
  node.dataset.state = state;
}

export function setAgentActivity(text: string): void {
  el('status-agent').textContent = text;
}

let totalInput = 0;
let totalOutput = 0;

export function addTokenUsage(usage: { inputTokens: number; outputTokens: number }): void {
  totalInput += usage.inputTokens;
  totalOutput += usage.outputTokens;
  el('status-tokens').textContent =
    `tokens: ${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out`;
}

export function setDocument(path: string): void {
  el('status-doc').textContent = path;
}

export function notify(text: string): void {
  const node = el('status-notice');
  node.textContent = text;
  if (text) setTimeout(() => { if (node.textContent === text) node.textContent = ''; }, 8000);
}
