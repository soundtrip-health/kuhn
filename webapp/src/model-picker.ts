// Model pill in the chat composer (issue #134): which model powers the agent
// the user is talking to. The routing rule picks by task difficulty, which
// is right for dispatched sub-tasks but odd for the agent a user addresses
// directly — the PM would otherwise always run on the strongest model, and a
// per-turn choice would defeat prompt caching. So the user pins a model for
// the conversation, per project and agent (localStorage), from the agent's
// routed models — the owner's allowlist, never anything else — and the pin
// travels with each task (`profile`). Hidden when there is nothing to choose
// (one routed model): the status-bar chip already says what is running.

import { getAgentModelOptions, type AgentModelOption, type AgentModelOptions } from './api';
import { icon } from './icons';
import { compactModel } from './status';

const KEY_PREFIX = 'kuhn-model-pick';
const key = (projectId: number, agent: string) => `${KEY_PREFIX}:${projectId}:${agent}`;

/** The pinned profile slug for an agent in a project, or null for the route's own choice. */
export function pinnedProfile(projectId: number, agent: string): string | null {
  try {
    return localStorage.getItem(key(projectId, agent));
  } catch {
    return null;
  }
}

function setPinned(projectId: number, agent: string, slug: string | null): void {
  try {
    if (slug) localStorage.setItem(key(projectId, agent), slug);
    else localStorage.removeItem(key(projectId, agent));
  } catch {
    // Storage unavailable: the pick simply does not persist.
  }
}

/** Forget a pin the server refused (the owner removed that model from the
 * route) — and the cached options, which are evidently stale. */
export function clearPinnedProfile(projectId: number, agent: string): void {
  setPinned(projectId, agent, null);
  cache.delete(`${projectId}:${agent}`);
  void refreshModelPicker();
}

interface Context {
  projectId: () => number;
  agent: () => string;
}

let ctx: Context | null = null;
const cache = new Map<string, AgentModelOptions>();
let requestSeq = 0;

export function initModelPicker(context: Context): void {
  ctx = context;
  const root = document.getElementById('model-picker');
  if (!root) return;
  const button = root.querySelector<HTMLButtonElement>('.model-pill');
  const menu = root.querySelector<HTMLElement>('.agent-menu');
  if (!button || !menu) return;
  const close = (): void => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', (e) => {
    e.preventDefault();
    if (menu.hidden) { renderMenu(menu, close); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); (menu.querySelector('.agent-option.active') as HTMLElement | null)?.focus(); }
    else close();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !root.contains(e.target as Node)) close();
  });
  menu.onkeydown = (e: KeyboardEvent) => {
    const options = [...menu.querySelectorAll<HTMLElement>('.agent-option')];
    const idx = options.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); options[Math.min(idx + 1, options.length - 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); options[Math.max(idx - 1, 0)]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); button.focus(); }
  };
}

/** Drop cached options (a project switch, or the owner changed the routes). */
export function resetModelPicker(): void {
  cache.clear();
}

/** Re-fetch (or reuse) the selected agent's options and redraw the pill.
 * `fresh` bypasses the cache — after a run, in case the owner changed the routes. */
export async function refreshModelPicker({ fresh = false } = {}): Promise<void> {
  const root = document.getElementById('model-picker');
  if (!root || !ctx) return;
  const projectId = ctx.projectId();
  const agent = ctx.agent();
  if (!projectId || !agent) { root.hidden = true; return; }
  const cacheKey = `${projectId}:${agent}`;
  const seq = ++requestSeq;
  let options = fresh ? undefined : cache.get(cacheKey);
  if (!options) {
    try {
      options = await getAgentModelOptions(projectId, agent);
    } catch {
      root.hidden = true; // no chrome for a failed lookup; the route still decides server-side
      return;
    }
    if (seq !== requestSeq) return; // a newer refresh superseded this one
    cache.set(cacheKey, options);
  }
  renderPill(root, options, projectId, agent);
}

function current(options: AgentModelOptions, projectId: number, agent: string): { option: AgentModelOption | null; pinned: boolean } {
  const pin = pinnedProfile(projectId, agent);
  const pinnedOption = pin ? options.options.find((o) => o.profile_slug === pin) ?? null : null;
  if (pinnedOption) return { option: pinnedOption, pinned: true };
  return { option: options.options.find((o) => o.profile_slug === options.default_slug) ?? options.options[options.options.length - 1] ?? null, pinned: false };
}

function renderPill(root: HTMLElement, options: AgentModelOptions, projectId: number, agent: string): void {
  const button = root.querySelector<HTMLButtonElement>('.model-pill');
  if (!button) return;
  // Nothing to choose between → no pill; the status-bar chip names the model.
  if (options.options.length < 2) { root.hidden = true; return; }
  root.hidden = false;
  const { option, pinned } = current(options, projectId, agent);
  const label = option ? compactModel(option.model_id) : 'model';
  button.innerHTML = `${icon('sparkle', { size: 11, stroke: 1.8 })}<span class="model-pill-label">${escape(label)}</span>${icon('chevron-down', { size: 11, stroke: 2 })}`;
  button.title = option
    ? `${option.name} — ${pinned ? 'your choice for this conversation' : 'the route’s default'}. Click to pick which model powers this agent.`
    : 'Pick which model powers this agent';
  button.classList.toggle('is-pinned', pinned);
}

function renderMenu(menu: HTMLElement, close: () => void): void {
  if (!ctx) return;
  const projectId = ctx.projectId();
  const agent = ctx.agent();
  const options = cache.get(`${projectId}:${agent}`);
  if (!options) return;
  const { option: active, pinned } = current(options, projectId, agent);
  const pick = (slug: string | null): void => {
    setPinned(projectId, agent, slug);
    const root = document.getElementById('model-picker');
    if (root) renderPill(root, options, projectId, agent);
    close();
  };
  const rows: HTMLElement[] = [];
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = `agent-option model-option${pinned ? '' : ' active'}`;
  auto.setAttribute('role', 'option');
  auto.innerHTML = `<span class="model-option-name">Route default</span><span class="model-option-meta">${escape(options.default_slug ? compactModel(options.options.find((o) => o.profile_slug === options.default_slug)?.model_id ?? null) : '')} · picked by the ${options.source === 'org' ? 'organization' : options.source} route</span>`;
  auto.addEventListener('click', () => pick(null));
  rows.push(auto);
  for (const o of options.options) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `agent-option model-option${pinned && active?.profile_slug === o.profile_slug ? ' active' : ''}`;
    row.setAttribute('role', 'option');
    row.disabled = !o.enabled;
    const meta = [o.provider ?? '', o.model_id ?? '', o.cost_weight != null ? `cost ×${o.cost_weight}` : ''].filter(Boolean).join(' · ');
    row.innerHTML = `<span class="model-option-name">${escape(o.name)}</span><span class="model-option-meta">${escape(meta)}</span>`;
    row.addEventListener('click', () => pick(o.profile_slug));
    rows.push(row);
  }
  const note = document.createElement('div');
  note.className = 'model-menu-note';
  note.textContent = 'Applies to the agent you are addressing, for this project. Sub-agents it dispatches are routed by task difficulty.';
  menu.replaceChildren(...rows, note);
}

function escape(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
