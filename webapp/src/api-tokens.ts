// Personal API tokens — member side (issue #152, sciwriter interchange).
// Opened from the account popover (user-menu.ts). Mints a bearer token for
// the signed-in user (name + expiry preset), shows the raw value exactly once
// (the backend keeps only its hash), and lists the user's live tokens with
// per-token revoke. Same overlay/card idiom as share-links.ts; backend truth
// is agent-backend/src/routes/auth.js (/api/me/tokens).

import { listApiTokens, mintApiToken, revokeApiToken, type ApiToken } from './api';
import { toast } from './toast';

let overlay: HTMLElement | null = null;
let selectedDays = 90;
/** Guards a slow list response landing after the dialog was reopened. */
let listSeq = 0;

const EXPIRY_PRESETS: { label: string; days: number }[] = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
];

const SCOPE_COPY =
  'A token acts as you: the same organizations, roles and attribution as ' +
  'when you are signed in. Scripts send it as an Authorization: Bearer header. ' +
  'It cannot create or revoke other tokens — that needs this screen.';
const USE_COPY =
  'For the sciwriter round trip, set KUHN_URL to this site and KUHN_API_TOKEN ' +
  'to the token in the environment where export_to_kuhn.py runs.';

/** Open the dialog (called from the account popover). */
export function openApiTokensDialog(): void {
  ensureOverlay();
  selectedDays = 90;
  overlay!.hidden = false;
  renderDialog();
  void renderList();
}

function closeDialog(): void {
  if (overlay) overlay.hidden = true;
}

function ensureOverlay(): void {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'api-tokens-dialog';
  overlay.className = 'hy-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'API tokens');
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

  const head = document.createElement('div');
  head.className = 'hy-head';
  head.innerHTML =
    '<span class="panel-eyebrow">API tokens</span>' +
    '<span class="hy-path">for scripts and external tools</span>' +
    '<span class="spacer"></span>';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'preview-close';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close API tokens dialog');
  close.innerHTML = '&times;';
  close.addEventListener('click', closeDialog);
  head.append(close);

  // ---- mint form ----
  const mint = document.createElement('div');
  mint.className = 'sh-mint';

  const nameRow = document.createElement('div');
  nameRow.className = 'sh-row';
  const nameLabel = document.createElement('label');
  nameLabel.className = 'sh-row-label';
  nameLabel.htmlFor = 'tk-name';
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.id = 'tk-name';
  nameInput.className = 'tk-name';
  nameInput.type = 'text';
  nameInput.maxLength = 64;
  nameInput.placeholder = 'e.g. sciwriter on my laptop';
  nameInput.autocomplete = 'off';
  nameRow.append(nameLabel, nameInput);

  const ttlRow = document.createElement('div');
  ttlRow.className = 'sh-row';
  ttlRow.setAttribute('role', 'radiogroup');
  ttlRow.setAttribute('aria-label', 'Expires in');
  const ttlLabel = document.createElement('span');
  ttlLabel.className = 'sh-row-label';
  ttlLabel.textContent = 'Expires in';
  ttlRow.append(ttlLabel);
  for (const preset of EXPIRY_PRESETS) {
    const wrap = document.createElement('label');
    wrap.className = 'sh-radio';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'tk-ttl';
    input.value = String(preset.days);
    input.checked = preset.days === selectedDays;
    input.addEventListener('change', () => {
      if (input.checked) selectedDays = preset.days;
    });
    wrap.append(input, document.createTextNode(` ${preset.label}`));
    ttlRow.append(wrap);
  }

  const scope = document.createElement('p');
  scope.className = 'sh-note';
  scope.textContent = SCOPE_COPY;
  const use = document.createElement('p');
  use.className = 'sh-note';
  use.textContent = USE_COPY;

  const actions = document.createElement('div');
  actions.className = 'sh-mint-actions';
  const mintBtn = document.createElement('button');
  mintBtn.type = 'button';
  mintBtn.className = 'btn btn-solid btn-sm';
  mintBtn.textContent = 'Create token';
  mintBtn.addEventListener('click', () => void doMint(nameInput, mintBtn));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doMint(nameInput, mintBtn);
  });
  actions.append(mintBtn);

  const minted = document.createElement('div');
  minted.className = 'sh-minted';
  minted.id = 'tk-minted';
  minted.hidden = true;

  mint.append(nameRow, ttlRow, scope, use, actions, minted);

  // ---- token list ----
  const tokens = document.createElement('div');
  tokens.className = 'sh-links';
  const listHead = document.createElement('div');
  listHead.className = 'sh-links-head';
  const title = document.createElement('span');
  title.className = 'panel-eyebrow';
  title.textContent = 'Your tokens';
  listHead.append(title);
  const list = document.createElement('div');
  list.className = 'sh-list';
  list.id = 'tk-list';
  tokens.append(listHead, list);

  const body = document.createElement('div');
  body.className = 'sh-body';
  body.append(mint, tokens);

  card.append(head, body);
  overlay!.replaceChildren(card);
  nameInput.focus();
}

async function doMint(nameInput: HTMLInputElement, btn: HTMLButtonElement): Promise<void> {
  const name = nameInput.value.trim();
  if (!name) {
    toast('Give the token a name so you can recognize it later');
    nameInput.focus();
    return;
  }
  btn.disabled = true;
  try {
    const { token } = await mintApiToken({ name, expiresInDays: selectedDays });
    nameInput.value = '';
    showMintedToken(token);
    void renderList();
  } catch (err) {
    toast(`Could not create the token: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

/** The one place the raw token is ever visible — show it with a Copy button. */
function showMintedToken(token: string): void {
  const minted = document.getElementById('tk-minted');
  if (!minted) return;
  minted.hidden = false;
  minted.replaceChildren();

  const row = document.createElement('div');
  row.className = 'sh-url-row';
  const input = document.createElement('input');
  input.className = 'sh-url';
  input.readOnly = true;
  input.value = token;
  input.setAttribute('aria-label', 'API token');
  input.addEventListener('focus', () => input.select());
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-accent btn-sm';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => void copyToken(token, input, copy));
  row.append(input, copy);

  const hint = document.createElement('div');
  hint.className = 'sh-note sh-once';
  hint.textContent = 'This token is shown once — copy it now. Kuhn keeps only a hash of it.';
  minted.append(row, hint);
  input.focus();
  input.select();
}

async function copyToken(token: string, input: HTMLInputElement, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(token);
  } catch {
    input.focus();
    input.select();
    toast('Press ⌘C / Ctrl+C to copy the selected token');
    return;
  }
  const prev = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = prev; }, 1600);
}

async function renderList(): Promise<void> {
  const list = document.getElementById('tk-list');
  if (!list) return;
  const seq = ++listSeq;
  let tokens: ApiToken[];
  try {
    tokens = await listApiTokens();
  } catch (err) {
    if (seq !== listSeq) return;
    list.replaceChildren(notice(`Could not load tokens: ${(err as Error).message}`));
    return;
  }
  if (seq !== listSeq) return;
  if (tokens.length === 0) {
    list.replaceChildren(notice('No tokens yet.'));
    return;
  }
  list.replaceChildren(...tokens.map(tokenRow));
}

function tokenRow(token: ApiToken): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sh-link-row';

  const main = document.createElement('div');
  main.className = 'sh-link-main';
  const who = document.createElement('span');
  who.className = 'sh-link-who';
  who.textContent = token.name;
  main.append(who);
  const expired = new Date(token.expiresAt).getTime() <= Date.now();
  if (expired) {
    const badge = document.createElement('span');
    badge.className = 'tk-expired';
    badge.textContent = 'expired';
    main.append(badge);
  }

  const meta = document.createElement('div');
  meta.className = 'sh-link-meta';
  meta.textContent = [
    `created ${timeAgo(token.createdAt)}`,
    expired ? `expired ${timeAgo(token.expiresAt)}` : `expires ${timeUntil(token.expiresAt)}`,
    token.lastUsedAt ? `last used ${timeAgo(token.lastUsedAt)}` : 'never used',
  ].join(' · ');

  const revoke = document.createElement('button');
  revoke.type = 'button';
  revoke.className = 'btn btn-ghost btn-sm sh-revoke';
  revoke.textContent = expired ? 'Remove' : 'Revoke';
  revoke.title = expired
    ? 'Remove this expired token from the list'
    : 'Revoke this token — anything using it is signed out immediately';
  revoke.addEventListener('click', () => void doRevoke(token, expired, revoke));

  const text = document.createElement('div');
  text.className = 'sh-link-text';
  text.append(main, meta);
  row.append(text, revoke);
  return row;
}

async function doRevoke(token: ApiToken, expired: boolean, btn: HTMLButtonElement): Promise<void> {
  // Documented exception (story 005-004): native confirm(), as with delete.
  if (!expired && !window.confirm(`Revoke the token "${token.name}"? Scripts using it stop working immediately.`)) return;
  btn.disabled = true;
  try {
    await revokeApiToken(token.id);
    toast(expired ? `Removed "${token.name}"` : `Token "${token.name}" revoked`);
  } catch (err) {
    toast(`Could not revoke: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
  }
  void renderList();
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
