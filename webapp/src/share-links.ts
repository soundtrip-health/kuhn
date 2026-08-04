// External review links — member side (epic 013, story 003). The "Share"
// button in the editor sub-header opens a dialog that mints magic links for
// the OPEN document (mode: view / comment / edit; expiry preset), shows the
// URL exactly once (the raw token never comes back from the server again),
// and lists the doc's active links — reviewer name once claimed, mode,
// created by, expiry, last activity — with per-link revoke. An "all links in
// this project" toggle drops the path filter for the project-wide rollup.
// Backend truth lives in agent-backend/src/routes/review-links.js; this
// module only renders it. Feed `review_link` events land here via
// refreshShareLinks() (wired in main.ts) so an open dialog stays live.

import {
  listReviewLinks,
  mintReviewLink,
  revokeReviewLink,
  type ReviewLink,
  type ReviewLinkMode,
} from './api';
import { icon } from './icons';
import { toast } from './toast';

let overlay: HTMLElement | null = null;
let dialogProjectId = 0;
let dialogPath = '';
/** Project-wide rollup toggle ("all links in this project"). */
let showAllLinks = false;
let selectedMode: ReviewLinkMode = 'comment';
let selectedTtlMs = 7 * 24 * 60 * 60 * 1000; // 7d default
/** Guards a slow list response landing after the dialog moved on. */
let listSeq = 0;

const TTL_PRESETS: { label: string; ms: number }[] = [
  { label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

/** What each mode lets the reviewer do — shown in the dialog, kept honest. */
const MODE_COPY: Record<ReviewLinkMode, string> = {
  view: 'Can read the document and its comments. Cannot change anything.',
  comment:
    'Can read the document and add comments and replies. ' +
    'They can resolve or delete only their own threads.',
  edit:
    'Can edit the document directly. Their saves are attributed to them in ' +
    'version history.',
};

/** Fixed copy: exactly what the link exposes, plus the agent-overlap note. */
const SCOPE_COPY =
  'The reviewer gets this one document only — no other project files, chat, ' +
  'agents, or history. The link works for a single reviewer; once claimed it ' +
  'cannot be reused by anyone else.';
const AGENT_OVERLAP_COPY =
  'Kuhn agents may update this document while your reviewer has it open; the ' +
  'reviewer’s editor refreshes to the agent’s version, and reviewer edits not ' +
  'yet saved at that moment are lost — ask reviewers to save before handing ' +
  'the document back.';

/** Wire the sub-header Share button (called once from main.ts). */
export function initShareLinks(getContext: () => { projectId: number; path: string }): void {
  const btn = document.getElementById('editor-share-btn');
  btn?.addEventListener('click', () => {
    const { projectId, path } = getContext();
    if (!projectId || !path) {
      toast('No document open');
      return;
    }
    openShareDialog(projectId, path);
  });
  if (btn) btn.innerHTML = icon('send', { size: 12, stroke: 1.8 }) + ' Share';
}

/** Re-fetch the active-links list if the dialog is open (feed events land here). */
export function refreshShareLinks(): void {
  if (!overlay || overlay.hidden) return;
  void renderLinkList();
}

function openShareDialog(projectId: number, path: string): void {
  ensureOverlay();
  dialogProjectId = projectId;
  dialogPath = path;
  showAllLinks = false;
  selectedMode = 'comment';
  selectedTtlMs = 7 * 24 * 60 * 60 * 1000;
  overlay!.hidden = false;
  renderDialog();
  void renderLinkList();
}

function closeDialog(): void {
  if (overlay) overlay.hidden = true;
}

function ensureOverlay(): void {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'share-dialog';
  overlay.className = 'hy-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Share for external review');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) closeDialog();
  });
  document.body.append(overlay);
}

function renderDialog(): void {
  const card = document.createElement('div');
  card.className = 'sh-card';

  // ---- head ----
  const head = document.createElement('div');
  head.className = 'hy-head';
  head.innerHTML =
    `<span class="panel-eyebrow">Share</span>` +
    `<span class="hy-path">${escapeHtml(dialogPath)}</span>` +
    `<span class="spacer"></span>`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'preview-close';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close share dialog');
  close.innerHTML = '&times;';
  close.addEventListener('click', closeDialog);
  head.append(close);

  // ---- mint form ----
  const mint = document.createElement('div');
  mint.className = 'sh-mint';

  const modeRow = radioRow<ReviewLinkMode>(
    'sh-mode',
    'Access',
    (['view', 'comment', 'edit'] as ReviewLinkMode[]).map((m) => ({ label: m, value: m })),
    selectedMode,
    (m) => {
      selectedMode = m;
      updateModeCopy();
    },
  );

  const ttlRow = radioRow<number>(
    'sh-ttl',
    'Expires in',
    TTL_PRESETS.map((p) => ({ label: p.label, value: p.ms })),
    selectedTtlMs,
    (ms) => { selectedTtlMs = ms; },
  );

  const modeCopy = document.createElement('p');
  modeCopy.className = 'sh-note';
  modeCopy.id = 'sh-mode-copy';
  const scopeCopy = document.createElement('p');
  scopeCopy.className = 'sh-note';
  scopeCopy.textContent = SCOPE_COPY;
  const overlapCopy = document.createElement('p');
  overlapCopy.className = 'sh-note sh-note-overlap';
  overlapCopy.textContent = AGENT_OVERLAP_COPY;

  const mintActions = document.createElement('div');
  mintActions.className = 'sh-mint-actions';
  const mintBtn = document.createElement('button');
  mintBtn.type = 'button';
  mintBtn.className = 'btn btn-solid btn-sm';
  mintBtn.textContent = 'Create link';
  mintBtn.addEventListener('click', () => void doMint(mintBtn));
  mintActions.append(mintBtn);

  const minted = document.createElement('div');
  minted.className = 'sh-minted';
  minted.id = 'sh-minted';
  minted.hidden = true;

  mint.append(modeRow, ttlRow, modeCopy, scopeCopy, overlapCopy, mintActions, minted);

  // ---- active links ----
  const links = document.createElement('div');
  links.className = 'sh-links';
  const linksHead = document.createElement('div');
  linksHead.className = 'sh-links-head';
  const title = document.createElement('span');
  title.className = 'panel-eyebrow';
  title.textContent = 'Active links';
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const allLabel = document.createElement('label');
  allLabel.className = 'sh-all-toggle';
  const allBox = document.createElement('input');
  allBox.type = 'checkbox';
  allBox.checked = showAllLinks;
  allBox.addEventListener('change', () => {
    showAllLinks = allBox.checked;
    void renderLinkList();
  });
  allLabel.append(allBox, document.createTextNode(' all links in this project'));
  linksHead.append(title, spacer, allLabel);
  const list = document.createElement('div');
  list.className = 'sh-list';
  list.id = 'sh-list';
  links.append(linksHead, list);

  const body = document.createElement('div');
  body.className = 'sh-body';
  body.append(mint, links);

  card.append(head, body);
  overlay!.replaceChildren(card);
  updateModeCopy();
}

function updateModeCopy(): void {
  const el = document.getElementById('sh-mode-copy');
  if (el) el.textContent = MODE_COPY[selectedMode];
}

/** A labelled radio group; returns the row element. */
function radioRow<T extends string | number>(
  name: string,
  label: string,
  options: { label: string; value: T }[],
  selected: T,
  onChange: (value: T) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sh-row';
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', label);
  const caption = document.createElement('span');
  caption.className = 'sh-row-label';
  caption.textContent = label;
  row.append(caption);
  for (const opt of options) {
    const wrap = document.createElement('label');
    wrap.className = 'sh-radio';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = String(opt.value);
    input.checked = opt.value === selected;
    input.addEventListener('change', () => {
      if (input.checked) onChange(opt.value);
    });
    wrap.append(input, document.createTextNode(` ${opt.label}`));
    row.append(wrap);
  }
  return row;
}

async function doMint(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const { url } = await mintReviewLink(dialogProjectId, {
      path: dialogPath,
      mode: selectedMode,
      ttlMs: selectedTtlMs,
    });
    showMintedUrl(url);
    void renderLinkList();
  } catch (err) {
    toast(`Could not create the link: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

/** The one place the raw URL is ever visible — show it with a Copy button. */
function showMintedUrl(url: string): void {
  const minted = document.getElementById('sh-minted');
  if (!minted) return;
  minted.hidden = false;
  minted.replaceChildren();

  const row = document.createElement('div');
  row.className = 'sh-url-row';
  const input = document.createElement('input');
  input.className = 'sh-url';
  input.readOnly = true;
  input.value = url;
  input.setAttribute('aria-label', 'Review link URL');
  input.addEventListener('focus', () => input.select());
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-accent btn-sm';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => void copyUrl(url, input, copy));
  row.append(input, copy);

  const hint = document.createElement('div');
  hint.className = 'sh-note sh-once';
  hint.textContent = 'This link is shown once — copy it now and send it to your reviewer.';
  minted.append(row, hint);
  input.focus();
  input.select();
}

async function copyUrl(url: string, input: HTMLInputElement, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Clipboard API can be unavailable (permissions, http) — fall back to
    // selecting the text so a manual ⌘C still works, and say so.
    input.focus();
    input.select();
    toast('Press ⌘C / Ctrl+C to copy the selected link');
    return;
  }
  const prev = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = prev; }, 1600);
}

async function renderLinkList(): Promise<void> {
  const list = document.getElementById('sh-list');
  if (!list) return;
  const seq = ++listSeq;
  const projectId = dialogProjectId;
  let links: ReviewLink[];
  try {
    links = await listReviewLinks(projectId, showAllLinks ? {} : { path: dialogPath });
  } catch (err) {
    if (seq !== listSeq) return;
    list.replaceChildren(notice(`Could not load links: ${(err as Error).message}`));
    return;
  }
  if (seq !== listSeq || projectId !== dialogProjectId) return; // superseded
  if (links.length === 0) {
    list.replaceChildren(notice(
      showAllLinks ? 'No active links in this project.' : 'No active links for this document.',
    ));
    return;
  }
  list.replaceChildren(...links.map(linkRow));
}

function linkRow(link: ReviewLink): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sh-link-row';

  const main = document.createElement('div');
  main.className = 'sh-link-main';
  const who = document.createElement('span');
  who.className = 'sh-link-who';
  who.textContent = link.reviewerName ?? 'Unclaimed';
  if (!link.reviewerName) who.classList.add('sh-unclaimed');
  const mode = document.createElement('span');
  mode.className = 'sh-mode-badge';
  mode.textContent = link.mode;
  main.append(who, mode);
  if (showAllLinks) {
    const path = document.createElement('span');
    path.className = 'hy-path';
    path.textContent = link.path;
    main.append(path);
  }

  const meta = document.createElement('div');
  meta.className = 'sh-link-meta';
  const expired = new Date(link.expiresAt).getTime() <= Date.now();
  const bits = [
    link.createdByName ? `created by ${link.createdByName}` : 'created',
    expired ? 'expired' : `expires ${timeUntil(link.expiresAt)}`,
    link.lastActiveAt ? `last active ${timeAgo(link.lastActiveAt)}` : 'never used',
  ];
  meta.textContent = bits.join(' · ');

  const revoke = document.createElement('button');
  revoke.type = 'button';
  revoke.className = 'btn btn-ghost btn-sm sh-revoke';
  revoke.textContent = 'Revoke';
  revoke.title = 'Revoke this link — the reviewer loses access immediately';
  revoke.addEventListener('click', () => void doRevoke(link, revoke));

  const text = document.createElement('div');
  text.className = 'sh-link-text';
  text.append(main, meta);
  row.append(text, revoke);
  return row;
}

async function doRevoke(link: ReviewLink, btn: HTMLButtonElement): Promise<void> {
  // Documented exception (story 005-004): native confirm(), as with delete.
  const who = link.reviewerName ? ` — ${link.reviewerName} loses access immediately` : '';
  if (!window.confirm(`Revoke this ${link.mode} link for ${link.path}?${who}`)) return;
  btn.disabled = true;
  try {
    await revokeReviewLink(dialogProjectId, link.id);
    toast(`Review link for ${link.path} revoked`);
  } catch (err) {
    toast(`Could not revoke: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
  }
  void renderLinkList();
}

// ---- helpers ----------------------------------------------------------------

function notice(text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'hy-notice';
  div.textContent = text;
  return div;
}

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

function timeUntil(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const s = (then - Date.now()) / 1000;
  if (s <= 0) return 'now';
  if (s < 3600) return `in ${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
