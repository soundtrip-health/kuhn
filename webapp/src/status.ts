// Status bar + top-bar activity (story 025). The status bar (bottom) carries
// the document path, save state, agent activity, and token usage. The top bar
// shows a single live indicator: a "Saving…"/"Saved" affordance, or — while the
// seeding pipeline runs — a "Seeding · N/M" chip (set by seeding.ts).

import { icon } from './icons';

const el = (id: string) => document.getElementById(id)!;

export type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

let lastSaveState: SaveState = 'saved';
let seedingChip: { done: number; total: number } | null = null;

export function setSaveState(state: SaveState, detail = ''): void {
  lastSaveState = state;
  const labels: Record<SaveState, string> = {
    saved: 'saved',
    saving: 'saving…',
    dirty: 'unsaved changes',
    error: `save failed${detail ? `: ${detail}` : ''}`,
  };
  const node = el('status-save');
  node.textContent = labels[state];
  node.dataset.state = state;
  renderTopbar();
}

/** Show the seeding chip in the top bar (called by the seeding panel). */
export function setSeedingChip(done: number, total: number): void {
  seedingChip = { done, total };
  renderTopbar();
}

export function clearSeedingChip(): void {
  seedingChip = null;
  renderTopbar();
}

function renderTopbar(): void {
  const node = document.getElementById('topbar-activity');
  if (!node) return;

  if (seedingChip) {
    node.hidden = false;
    node.className = 'topbar-activity';
    node.innerHTML =
      `<span class="ring"></span>Seeding · <span class="mono">${seedingChip.done}/${seedingChip.total}</span>`;
    return;
  }
  if (lastSaveState === 'saving' || lastSaveState === 'dirty') {
    node.hidden = false;
    node.className = 'topbar-activity';
    node.innerHTML = `<span class="ring"></span>Saving…`;
  } else if (lastSaveState === 'error') {
    node.hidden = false;
    node.className = 'topbar-activity is-error';
    node.textContent = 'Save failed';
  } else {
    node.hidden = false;
    node.className = 'topbar-activity is-saved';
    node.innerHTML = `${icon('check', { size: 14, stroke: 2.2 })}Saved`;
  }
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
    `${(totalInput + totalOutput).toLocaleString()} tokens`;
}

/** Compact token count: 2_500_000 → "2.5M", 480_000 → "480k". */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * Show the most recent task's budget utilization (weighted tokens) in the
 * status bar. The bar warns as it nears the limit and flags the grace overrun.
 */
export function setBudget(used: number, limit: number): void {
  const node = el('status-budget');
  if (!limit) {
    node.textContent = '';
    return;
  }
  const pct = Math.round((used / limit) * 100);
  node.textContent = `budget ${compactTokens(used)}/${compactTokens(limit)} · ${pct}%`;
  node.dataset.state = pct >= 100 ? 'over' : pct >= 85 ? 'warn' : 'ok';
  node.title = `Last task used ${Math.round(used).toLocaleString()} of ${limit.toLocaleString()} budgeted tokens`;
}

export function setDocument(path: string): void {
  el('status-doc').textContent = path;
}

/** Stamp the build version into the status bar (set once at startup). */
export function setVersion(): void {
  const node = document.getElementById('status-version');
  if (node) {
    node.textContent = `v${__APP_VERSION__} · ${__BUILD_REV__}`;
    node.title = `Kuhn webapp v${__APP_VERSION__} (build ${__BUILD_REV__})`;
  }
}

export function notify(text: string): void {
  const node = el('status-notice');
  node.textContent = text;
  if (text) setTimeout(() => { if (node.textContent === text) node.textContent = ''; }, 8000);
}
