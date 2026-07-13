# Story 002: Minimal real auth

**Status:** ready
**Epic:** [007 — Identity & User Memory](../index.md)
**Estimate:** L

## Goal

Replace the spoofable `x-kuhn-user` header with the smallest authentication
that can be trusted: email magic-link login issuing a signed session cookie.
`session.js` was built as the single swap point (`session.js:1-12`,
`schema.sql:44-50`) — this story executes the swap while keeping a dev-mode
escape hatch so local development and the token-free check scripts stay
frictionless.

## Acceptance Criteria

- [ ] Login flow: `POST /api/auth/request-link` (email) → single-use,
      short-lived (≤15 min) token emailed (or, in dev, printed to server log)
      → `GET /api/auth/verify?token=…` sets an HttpOnly, SameSite=Lax signed
      session cookie and redirects into the app. `POST /api/auth/logout`
      clears it.
- [ ] Schema: `auth_tokens` (token hash, user email, expires_at, used_at) and
      `sessions` (id, user_id, created_at, expires_at) — or a stateless
      signed cookie with a server secret; chosen approach documented in this
      story on completion. Secret from env (`KUHN_SESSION_SECRET`), refusing
      to start in non-dev mode without one.
- [ ] `session()` middleware resolves the user from the cookie. The
      `x-kuhn-user` header and dev-user fallback work **only** when
      `KUHN_AUTH_MODE=dev` (default in development, required-off in
      anything else). `resolveUser`'s get-or-create-by-email now happens at
      verify time, not per-request-header.
- [ ] First-login experience: a verified email with no membership is attached
      to the default org (current behavior) — invite-based org join stays
      deferred.
- [ ] Webapp: minimal login screen (email field + "check your email" state)
      shown when an API call returns 401; logout in the org menu. No design
      system additions.
- [ ] SSE and multipart endpoints authenticate via the same cookie (they do
      today via header fallback — verify nothing breaks). WS auth is
      Story 003's problem but the session mechanism chosen here must be
      readable at WS upgrade time (cookie is — note for 003).
- [ ] Token-free check scripts and vitest run in dev mode unchanged.
- [ ] Vitest coverage: expired/reused token rejected; cookie tampering
      rejected; dev fallback inert when `KUHN_AUTH_MODE` ≠ dev.

## Notes

- Files: `session.js` (the swap), new `routes/auth.js`, `db/schema.sql`,
  `config.js` (auth mode, secret, mail transport), small `webapp/src/login.ts`.
- Mail transport: log-to-console in dev; a single SMTP env-var config for
  real use. No mail-provider SDK dependency.
- Explicitly out of scope: SSO/OAuth, passwords, invites, roles UI, RLS.
  The architecture's "auth provider choice" question is answered as
  "magic link now, SSO swap point preserved."
