// Story 008-002: version-history panel. A modal (wizard-style overlay) for
// the open document: version list on the left (from the per-project git
// history), a read-only unified diff on the right (selected version → current
// content), and append-only restore. Backend truth lives in
// agent-backend/src/history.js; this module only renders it.

import { unifiedMergeView } from '@codemirror/merge';
import { markdown as cmMarkdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
  getHistory,
  getHistoryFile,
  readTextFile,
  restoreVersion,
  type HistoryEntry,
} from './api';
import { agentIdentity } from './agents';
import { flushSave } from './editor';
import { icon } from './icons';
import { toast } from './toast';

let overlay: HTMLElement | null = null;
let diffView: EditorView | null = null;
let entries: HistoryEntry[] = [];
let selected: HistoryEntry | null = null;
let panelProjectId = 0;
let panelPath = '';

/** Open the history panel for a document. */
export async function openHistoryPanel(projectId: number, path: string): Promise<void> {
  if (!path) {
    toast('No document open');
    return;
  }
  ensureOverlay();
  panelProjectId = projectId;
  panelPath = path;
  selected = null;
  overlay!.hidden = false;
  renderShell('Loading history…');

  // Persist any pending edits first so "current" in the diff is truthful and
  // the newest listed version reflects what's on screen.
  await flushSave();
  try {
    entries = await getHistory(projectId, path);
  } catch (err) {
    renderShell(`Could not load history: ${(err as Error).message}`);
    return;
  }
  renderList();
  if (entries.length > 0) void select(entries[0]);
}

function closePanel(): void {
  if (overlay) overlay.hidden = true;
  diffView?.destroy();
  diffView = null;
  entries = [];
  selected = null;
}

function ensureOverlay(): void {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'history-panel';
  overlay.className = 'hy-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Version history');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) closePanel();
  });
  document.body.append(overlay);
}

function renderShell(notice?: string): void {
  const card = document.createElement('div');
  card.className = 'hy-card';

  const head = document.createElement('div');
  head.className = 'hy-head';
  head.innerHTML =
    `<span class="panel-eyebrow">History</span>` +
    `<span class="hy-path">${escapeHtml(panelPath)}</span>` +
    `<span class="spacer"></span>`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'preview-close';
  close.title = 'Close history';
  close.setAttribute('aria-label', 'Close history');
  close.innerHTML = '&times;';
  close.addEventListener('click', closePanel);
  head.append(close);

  const body = document.createElement('div');
  body.className = 'hy-body';
  const list = document.createElement('div');
  list.className = 'hy-list';
  list.id = 'hy-list';
  const diff = document.createElement('div');
  diff.className = 'hy-diff';
  diff.id = 'hy-diff';
  if (notice) {
    const n = document.createElement('div');
    n.className = 'hy-notice';
    n.textContent = notice;
    diff.append(n);
  }
  body.append(list, diff);

  const foot = document.createElement('div');
  foot.className = 'hy-foot';
  const hint = document.createElement('span');
  hint.className = 'hy-hint';
  hint.textContent = 'Restoring keeps the current state as a version — nothing is lost.';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.id = 'hy-restore';
  restore.className = 'btn btn-solid btn-sm';
  restore.textContent = 'Restore this version';
  restore.disabled = true;
  restore.addEventListener('click', () => void doRestore());
  foot.append(hint, restore);

  card.append(head, body, foot);
  overlay!.replaceChildren(card);
}

function renderList(): void {
  const list = document.getElementById('hy-list');
  if (!list) return;
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hy-notice';
    empty.textContent = 'No versions yet — versions are recorded as you save and as agents work.';
    list.replaceChildren(empty);
    return;
  }
  const items = entries.map((entry, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'hy-row';
    row.dataset.hash = entry.hash;
    if (entry === selected) row.classList.add('active');

    const who = entry.agent ? agentIdentity(entry.agent).label : entry.authorName;
    const dot = entry.agent
      ? `<span class="hy-dot" style="background: var(${agentIdentity(entry.agent).colorVar})"></span>`
      : entry.external
        ? `<span class="hy-dot" style="background: var(--reviewer)"></span>`
        : '';
    // External-reviewer versions (epic 013): the backend parses the
    // `link-<id>@reviewers.kuhn.local` author and sets `external` — tag them
    // so an outsider's save is never mistaken for a member's.
    const external = entry.external ? `<span class="hy-external">external</span>` : '';
    row.innerHTML =
      `<span class="hy-label">${i === 0 ? '<span class="hy-latest">latest</span>' : ''}${escapeHtml(entry.label)}</span>` +
      `<span class="hy-meta">${dot}${escapeHtml(who)}${external} · ${timeAgo(entry.date)}</span>`;
    row.addEventListener('click', () => void select(entry));
    return row;
  });
  list.replaceChildren(...items);
}

async function select(entry: HistoryEntry): Promise<void> {
  selected = entry;
  renderList();
  const restoreBtn = document.getElementById('hy-restore') as HTMLButtonElement | null;
  if (restoreBtn) restoreBtn.disabled = entry === entries[0]; // latest = nothing to restore
  const diff = document.getElementById('hy-diff');
  if (!diff) return;

  try {
    const [old, current] = await Promise.all([
      getHistoryFile(panelProjectId, panelPath, entry.hash),
      readTextFile(panelProjectId, panelPath).then((t) => t ?? ''),
    ]);
    if (selected !== entry) return; // superseded by a newer selection
    diffView?.destroy();
    diff.replaceChildren();
    diffView = new EditorView({
      parent: diff,
      state: EditorState.create({
        doc: current,
        extensions: [
          unifiedMergeView({ original: old, mergeControls: false, gutter: true }),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          cmMarkdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
        ],
      }),
    });
    if (old === current) {
      const same = document.createElement('div');
      same.className = 'hy-notice';
      same.textContent = 'This version is identical to the current content.';
      diff.prepend(same);
    }
  } catch (err) {
    diff.replaceChildren();
    const n = document.createElement('div');
    n.className = 'hy-notice';
    n.textContent = `Could not load version: ${(err as Error).message}`;
    diff.append(n);
  }
}

async function doRestore(): Promise<void> {
  if (!selected) return;
  const entry = selected;
  try {
    await restoreVersion(panelProjectId, panelPath, entry.hash);
  } catch (err) {
    toast(`Restore failed: ${(err as Error).message}`);
    return;
  }
  closePanel();
  // The restore publishes a file_change; the open (clean — we flushed on
  // open) editor picks the content up live via applyExternalChange.
  toast(`Restored ${panelPath} to ${entry.shortHash} — previous state kept in history`);
}

// ---- helpers ----------------------------------------------------------------

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Wire the subheader History button (called once from main.ts). */
export function initHistoryButton(getContext: () => { projectId: number; path: string }): void {
  const btn = document.getElementById('editor-history-btn');
  btn?.addEventListener('click', () => {
    const { projectId, path } = getContext();
    void openHistoryPanel(projectId, path);
  });
  if (btn) btn.innerHTML = icon('clock', { size: 12, stroke: 1.8 }) + ' History';
}
