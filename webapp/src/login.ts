// Story 007-002: minimal magic-link login screen. Shown when the backend
// answers 401 (real auth mode with no valid session) — a blocking overlay,
// not a route: the app behind it has nothing to show an anonymous user.
// Reuses the project-browser overlay/modal classes. In dev auth mode this
// module resolves silently and the overlay never appears.
//
// STH-35 made the install invite-only, and that shapes the copy here: this
// screen is a sign-in box AND an access-request form, because it cannot know
// which one you need without telling you whether your address has an account.
// Every branch therefore ends on the same confirmation screen.

import { fetchMe, requestLoginLink, logout, type Me } from './api';

let me: Me | null = null;

/** The active auth mode ('dev' until initAuth resolves otherwise). */
export const authMode = (): 'dev' | 'magic-link' => me?.mode ?? 'dev';

/** The signed-in user, once known. */
export const currentUser = (): Me['user'] | null => me?.user ?? null;

/** Human-readable copy for the `?login=` redirect reasons the backend sends:
 *  dead magic links, and invitation redemption failures (epic 011). */
const LOGIN_NOTICES: Record<string, string> = {
  'expired': 'That sign-in link has expired or was already used. Request a fresh one.',
  'no-access': 'That sign-in link is no longer valid because the account it belongs to has no organization. If you think this is a mistake, ask your organization admin to invite you again.',
  'invite-expired': 'That invitation has expired. Ask your organization admin to send a new one.',
  'invite-revoked': 'That invitation was revoked. Ask your organization admin to send a new one.',
  'invite-used': 'That invitation was already used. If that was you, sign in with your email below.',
  'invite-invalid': 'That invitation link is not valid. Check the link, or ask your organization admin to send a new one.',
  'invite-suspended': 'That organization is currently suspended, so the invitation cannot be accepted yet. The link stays valid — try again once the organization is reactivated.',
  'invite-already-member': 'You are already a member of that organization. Sign in with your email below.',
};

/**
 * Resolve the session before the workspace boots. Returns true when the app
 * may proceed (dev mode or a valid cookie); false after putting up the login
 * screen. Also handles the ?login=<reason> redirects (dead magic link,
 * invitation failures) and wires the global 401 listener for sessions that
 * expire mid-use.
 */
export async function initAuth(): Promise<boolean> {
  window.addEventListener('kuhn:unauthorized', () => showLogin());

  const params = new URLSearchParams(window.location.search);
  const reason = params.get('login');
  const notice = reason ? LOGIN_NOTICES[reason] : undefined;
  if (reason) {
    params.delete('login');
    const query = params.toString();
    history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }

  me = await fetchMe().catch(() => null);
  if (me) return true; // already signed in — a dead link/invitation is moot
  showLogin(notice);
  return false;
}

/** Sign out and reload into the login screen. */
export async function signOut(): Promise<void> {
  await logout().catch(() => { /* cookie may already be dead — reload anyway */ });
  window.location.reload();
}

function showLogin(notice?: string): void {
  if (document.getElementById('login-overlay')) return;

  const root = document.createElement('div');
  root.className = 'pb-overlay';
  root.id = 'login-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Sign in');
  document.body.append(root);

  renderEmailStep(root, notice);
}

function shell(root: HTMLElement, title: string): HTMLElement {
  const modal = document.createElement('div');
  modal.className = 'pb-modal om-modal';
  modal.innerHTML =
    `<header class="pb-head"><div>` +
      `<div class="pb-eyebrow">Kuhn</div><h2 class="pb-org"></h2>` +
    `</div></header><div class="om-body"></div>`;
  (modal.querySelector('.pb-org') as HTMLElement).textContent = title;
  root.replaceChildren(modal);
  return modal.querySelector('.om-body') as HTMLElement;
}

function renderEmailStep(root: HTMLElement, notice?: string): void {
  const body = shell(root, 'Sign in');

  const form = document.createElement('form');
  form.className = 'om-form';
  // One field for both audiences. The note is shown to everyone because the
  // form CANNOT know which you are without disclosing it (STH-35) — the
  // backend decides, and only your mailbox learns the answer.
  form.innerHTML =
    `<p class="login-note" hidden></p>` +
    `<label class="om-label" for="login-email">Email</label>` +
    `<input id="login-email" class="pb-input" type="email" required autocomplete="email" placeholder="you@lab.org" />` +
    `<p class="login-hint">Kuhn is invite-only. Members get a sign-in link; everyone else is queued for review.</p>` +
    `<label class="om-label" for="login-intro">Requesting access? Tell us who you are <span class="om-optional">(optional)</span></label>` +
    `<textarea id="login-intro" class="pb-input login-intro" rows="2" maxlength="500" placeholder="Your name, institution, and who invited you"></textarea>` +
    `<p class="login-error" role="alert" hidden></p>` +
    `<div class="om-actions"><button type="submit" class="btn btn-accent">Continue</button></div>`;

  const noticeEl = form.querySelector('.login-note') as HTMLElement;
  if (notice) { noticeEl.textContent = notice; noticeEl.hidden = false; }
  const input = form.querySelector('#login-email') as HTMLInputElement;
  const intro = form.querySelector('#login-intro') as HTMLTextAreaElement;
  const errorEl = form.querySelector('.login-error') as HTMLElement;
  const submit = form.querySelector('button') as HTMLButtonElement;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!email) return;
    submit.disabled = true;
    errorEl.hidden = true;
    requestLoginLink(email, intro.value.trim() || undefined).then(
      () => renderSentStep(root, email),
      (err: Error) => {
        errorEl.textContent = err.message || 'Could not send the link — try again.';
        errorEl.hidden = false;
        submit.disabled = false;
      },
    );
  });

  body.append(form);
  input.focus();
}

/**
 * Deliberately vague (STH-35): the backend answers identically whether it
 * mailed a link, re-sent an invitation, or queued a request, so this screen
 * covers every case rather than leaking which one happened.
 */
function renderSentStep(root: HTMLElement, email: string): void {
  const body = shell(root, 'Check your email');
  const p = document.createElement('p');
  p.className = 'login-sent';
  p.textContent =
    `We've sent a message to ${email}. If you already belong to an organization here, ` +
    `it contains a sign-in link that works once and expires in 15 minutes. ` +
    `If you don't, it confirms that your access request is queued for review.`;
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-ghost';
  back.textContent = 'Use a different email';
  back.addEventListener('click', () => renderEmailStep(root));
  const actions = document.createElement('div');
  actions.className = 'om-actions';
  actions.append(back);
  body.append(p, actions);
}
