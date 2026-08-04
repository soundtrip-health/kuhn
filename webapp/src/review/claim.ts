// Claim + refusal/end screens for the reviewer surface (epic 013 story 002).
// Everything renders into #review-overlay, which is opaque — it doubles as the
// pre-claim shell and as the end-of-session wall (revoked/expired links leave
// no document behind them). All copy is set via textContent: the doc title and
// reviewer names are user-controlled strings.

import type { ReviewMode } from './review-api';

export type RefusalKind =
  | 'expired'
  | 'revoked'
  | 'claimed'
  | 'not_found'
  | 'removed'
  | 'ended'
  | 'error';

/** The three distinct refusal states (story 001 AC) plus the end/edge screens.
 *  `claimed` carries the brief decision-2 wording: links are single-claim and
 *  one browser holds one review session at a time. */
const COPY: Record<RefusalKind, { title: string; lines: string[] }> = {
  expired: {
    title: 'This review link has expired',
    lines: [
      'Review links stop working after their expiry date, and this one has passed it.',
      'If you still need to review, ask the person who sent it to mint a fresh link.',
    ],
  },
  revoked: {
    title: 'This review link was revoked',
    lines: [
      'The document owner has withdrawn this link, which ends its access immediately.',
      'If you still need to review, ask them for a fresh link.',
    ],
  },
  claimed: {
    title: 'This review link is already in use',
    lines: [
      'Review links are personal: the first person to open one claims it, and it stays theirs.',
      'Reviewing another document? Ask for a fresh link — a browser holds one review session at a time, so opening a new link ends the previous one.',
    ],
  },
  not_found: {
    title: 'This review link isn’t recognized',
    lines: ['Check that the full link was copied, or ask the sender for a fresh one.'],
  },
  removed: {
    title: 'This document was removed',
    lines: ['The document this link pointed to no longer exists, so the review has ended.'],
  },
  ended: {
    title: 'This review session has ended',
    lines: ['Reopen your review link to continue, or ask the sender for a fresh one.'],
  },
  error: {
    title: 'Couldn’t reach Kuhn',
    lines: ['Something went wrong loading this review. Refresh the page to try again.'],
  },
};

const MODE_INVITE: Record<ReviewMode, string> = {
  view: 'to read',
  comment: 'to read and comment on',
  edit: 'to edit',
};

/** Mirror of the server's sanitizeReviewerName (db/review-links.js): strip
 *  control characters, collapse whitespace, cap at 80. Null = nothing left. */
export function sanitizeName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return clean.length > 0 ? clean : null;
}

function overlay(): HTMLElement | null {
  return document.getElementById('review-overlay');
}

export function hideOverlay(): void {
  const el = overlay();
  if (!el) return;
  el.hidden = true;
  el.replaceChildren();
}

/** Shared card scaffold: brand row + optional document eyebrow. */
function card(docTitle?: string): { root: HTMLElement; body: HTMLElement } {
  const el = overlay();
  const body = document.createElement('div');
  body.className = 'rv-card';

  const brand = document.createElement('div');
  brand.className = 'brand rv-brand';
  const mark = document.createElement('span');
  mark.className = 'brand-mark';
  mark.setAttribute('aria-hidden', 'true');
  const inner = document.createElement('span');
  inner.className = 'brand-mark-inner';
  mark.append(inner);
  const name = document.createElement('span');
  name.className = 'rv-brand-name';
  name.textContent = 'Kuhn';
  brand.append(mark, name);
  body.append(brand);

  if (docTitle) {
    const eyebrow = document.createElement('p');
    eyebrow.className = 'rv-eyebrow';
    eyebrow.textContent = docTitle;
    body.append(eyebrow);
  }

  if (el) {
    el.replaceChildren(body);
    el.hidden = false;
  }
  return { root: el ?? body, body };
}

/** One of the terminal screens: refusals at claim time, or the wall that
 *  replaces the document when the session ends (revoke/expiry/delete). */
export function showRefusal(kind: RefusalKind, opts: { docTitle?: string } = {}): void {
  const copy = COPY[kind];
  const { body } = card(opts.docTitle);

  const title = document.createElement('h1');
  title.className = 'rv-title';
  title.textContent = copy.title;
  body.append(title);

  for (const line of copy.lines) {
    const p = document.createElement('p');
    p.className = 'rv-line';
    p.textContent = line;
    body.append(p);
  }
  body.dataset.kind = kind;
}

/**
 * The name prompt for an unclaimed link. `onSubmit` runs the claim; it returns
 * an inline error message to show, or null when it has taken over (navigated
 * into the document or swapped to a refusal screen).
 */
export function showClaimScreen(opts: {
  docTitle: string;
  mode: ReviewMode;
  onSubmit: (name: string) => Promise<string | null>;
}): void {
  const { body } = card();

  const eyebrow = document.createElement('p');
  eyebrow.className = 'rv-eyebrow';
  eyebrow.textContent = 'External review';
  body.append(eyebrow);

  const title = document.createElement('h1');
  title.className = 'rv-title';
  title.textContent = opts.docTitle;
  body.append(title);

  const invite = document.createElement('p');
  invite.className = 'rv-line';
  invite.textContent = `You’ve been invited ${MODE_INVITE[opts.mode]} this document. Enter your name to open it.`;
  body.append(invite);

  const form = document.createElement('form');
  form.className = 'rv-claim-form';
  const label = document.createElement('label');
  label.className = 'rv-label';
  label.htmlFor = 'rv-name-input';
  label.textContent = 'Your name';
  const input = document.createElement('input');
  input.id = 'rv-name-input';
  input.className = 'rv-input';
  input.type = 'text';
  input.maxLength = 80;
  input.autocomplete = 'name';
  input.placeholder = 'e.g. Jane Doe';
  const error = document.createElement('p');
  error.className = 'rv-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-accent rv-submit';
  submit.textContent = 'Open document';
  form.append(label, input, error, submit);
  body.append(form);

  const fine = document.createElement('p');
  fine.className = 'rv-fine';
  fine.textContent =
    'Your name appears on the comments and edits you make. This link is personal — the first person to open it claims it.';
  body.append(fine);

  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = false;
  };

  let busy = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const name = sanitizeName(input.value);
    if (name == null) {
      showError('Please enter your name.');
      input.focus();
      return;
    }
    busy = true;
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Opening…';
    void opts.onSubmit(name).then(
      (message) => {
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Open document';
        if (message != null) showError(message);
      },
      () => {
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Open document';
        showError('Couldn’t reach the server — try again.');
      },
    );
  });

  setTimeout(() => input.focus(), 0);
}
