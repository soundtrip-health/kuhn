// Seeding panel (story 025): a recessed panel above the chat transcript that
// visualizes the first-run pipeline as a stage checklist, driven by story
// 015's `stage` events. Replaces the old system-line narration for seeding.
//
// The backend emits stage markers {stage, status:start|done|error, detail,
// agent}. We map the known seeding stages to owner agents and render
// done/running/queued rows with per-agent colored spinners.

import type { AgentEvent } from './api';
import { agentIdentity } from './agents';
import { icon } from './icons';
import { clearSeedingChip, setSeedingChip } from './status';

type StageStatus = 'queued' | 'running' | 'done' | 'error';

interface StageDef {
  id: string;
  label: string;
  owner: string; // agent slug → color + tag
}

// The canonical pipeline order. `seeding` is the overall wrapper (not a row).
// Intake is handled by the setup wizard, not a pipeline stage.
const STAGES: StageDef[] = [
  { id: 'research', label: 'Build bibliography', owner: 'ra' },
  { id: 'skeleton', label: 'Generate skeleton', owner: 'writer' },
];

const status = new Map<string, StageStatus>();
const substatus = new Map<string, string>();
let active = false;

const panel = () => document.getElementById('seeding-panel')!;

export function seedingActive(): boolean {
  return active;
}

/** Reset to all-queued and reveal the panel. */
export function showSeedingPanel(): void {
  active = true;
  status.clear();
  substatus.clear();
  for (const s of STAGES) status.set(s.id, 'queued');
  panel().hidden = false;
  render();
}

/**
 * Apply a stage event. Returns true if the event was consumed by the panel
 * (so the caller can skip the old system-line narration).
 */
export function applyStage(event: AgentEvent): boolean {
  if (!active) return false;
  const id = event.stage ?? '';

  if (id === 'seeding') {
    if (event.status === 'done') completeSeeding();
    return true;
  }
  if (!status.has(id)) {
    // Unknown stage the backend emits — append it as a row so nothing is lost.
    STAGES.push({ id, label: labelize(id), owner: event.agent || 'pm' });
    status.set(id, 'queued');
  }

  if (event.status === 'start') {
    // Starting a stage implies any earlier still-queued stage is done.
    markPriorDone(id);
    status.set(id, 'running');
    if (event.detail) substatus.set(id, event.detail);
  } else if (event.status === 'error') {
    status.set(id, 'error');
    if (event.detail) substatus.set(id, event.detail);
  } else {
    status.set(id, 'done');
    if (event.detail) substatus.set(id, event.detail);
  }
  render();
  return true;
}

/** Mark everything done (pipeline ended) and retire the panel. */
export function completeSeeding(): void {
  if (!active) return;
  for (const s of STAGES) if (status.get(s.id) !== 'error') status.set(s.id, 'done');
  render();
  active = false;
  clearSeedingChip();
  setTimeout(() => { if (!active) panel().hidden = true; }, 1200);
}

function markPriorDone(id: string): void {
  for (const s of STAGES) {
    if (s.id === id) break;
    if (status.get(s.id) === 'queued' || status.get(s.id) === 'running') status.set(s.id, 'done');
  }
}

function labelize(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ');
}

function render(): void {
  const done = STAGES.filter((s) => status.get(s.id) === 'done').length;
  const total = STAGES.length;
  const pct = Math.round((done / total) * 100);
  const remainingMin = Math.max(1, total - done);
  const eta = active && done < total ? ` · ~${remainingMin} min` : '';

  const head = document.createElement('div');
  head.className = 'seeding-head';
  head.innerHTML =
    `<span class="seeding-eyebrow">Seeding project</span>` +
    `<span class="seeding-count">${done} of ${total}${eta}</span>`;

  const track = document.createElement('div');
  track.className = 'seeding-track';
  const fill = document.createElement('div');
  fill.className = 'seeding-fill';
  fill.style.width = `${pct}%`;
  track.append(fill);

  const stages = document.createElement('div');
  stages.className = 'seeding-stages';
  for (const def of STAGES) stages.append(renderStage(def));

  panel().replaceChildren(head, track, stages);
  if (active) setSeedingChip(done, total);
}

function renderStage(def: StageDef): HTMLElement {
  const st = status.get(def.id) ?? 'queued';
  const agent = agentIdentity(def.owner);
  const row = document.createElement('div');
  row.className = `stage is-${st}`;
  row.style.setProperty('--role', `var(${agent.colorVar})`);

  const ic = document.createElement('span');
  ic.className = 'stage-icon';
  if (st === 'done') ic.innerHTML = icon('check', { size: 9, stroke: 3.2 });
  else if (st === 'error') { ic.innerHTML = icon('clock', { size: 10, stroke: 2 }); ic.style.color = 'var(--warn)'; }

  const main = document.createElement('div');
  main.style.flex = '1';
  main.style.minWidth = '0';
  const label = document.createElement('div');
  label.className = 'stage-label';
  label.textContent = def.label;
  if (st === 'running') {
    const tag = document.createElement('span');
    tag.className = 'stage-owner';
    tag.textContent = agent.label;
    label.append(tag);
  }
  const sub = document.createElement('div');
  sub.className = 'stage-sub';
  sub.textContent = subText(def, st, agent.label);

  main.append(label, sub);
  row.append(ic, main);
  return row;
}

function subText(def: StageDef, st: StageStatus, ownerLabel: string): string {
  const detail = substatus.get(def.id);
  if (detail) return detail;
  if (st === 'done') return `Done · ${ownerLabel}`;
  if (st === 'running') return `Working… · ${ownerLabel}`;
  if (st === 'error') return `Failed · ${ownerLabel}`;
  return `Queued · ${ownerLabel}`;
}
