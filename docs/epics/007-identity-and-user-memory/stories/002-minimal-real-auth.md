# Story 002: Minimal real auth

**Status:** done
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

- [x] Login flow: `POST /api/auth/request-link` (email) → single-use,
      short-lived (≤15 min) token emailed (or, in dev, printed to server log)
      → `GET /api/auth/verify?token=…` sets an HttpOnly, SameSite=Lax signed
      session cookie and redirects into the app. `POST /api/auth/logout`
      clears it. — `routes/auth.js`; expired/reused links redirect with
      `?login=expired` so the webapp explains itself.
- [x] Schema: `auth_tokens` (token hash, user email, expires_at, used_at) and
      `sessions` (id, user_id, created_at, expires_at) — **chosen approach:
      DB-backed sessions** (revocable on logout, no replay after secret
      rotation) with an HMAC-signed cookie `<token>.<hmac>` on top: the
      signature rejects forgeries without a DB roundtrip, the DB stores only
      sha256(token) so a leaked database mints nothing (`db/auth.js`).
      Secret from env (`KUHN_SESSION_SECRET`); `assertAuthConfig()` refuses
      startup in non-dev mode without one. Expired rows pruned
      opportunistically on insert.
- [x] `session()` middleware resolves the user from the cookie. The
      `x-kuhn-user` header and dev-user fallback work **only** when
      `KUHN_AUTH_MODE=dev` (the default). `resolveUser`'s
      get-or-create-by-email now happens at verify time, not
      per-request-header.
- [x] First-login experience: a verified email with no membership is attached
      to the default org (current behavior preserved via `resolveUser`) —
      invite-based org join stays deferred.
- [x] Webapp: minimal login screen (`login.ts` — email field + "check your
      email" state) shown at bootstrap and on any 401 (`apiFetch` raises
      `kuhn:unauthorized`); "Sign out (email)" in the breadcrumb org menu,
      hidden in dev mode. Reuses pb/om modal classes — no design system
      additions.
- [x] SSE and multipart endpoints authenticate via the same cookie —
      verified live: both 401 anonymously and work with the cookie
      (EventSource now `withCredentials`; all fetches `credentials:
      'include'`; CORS `credentials: true`). WS note for 003:
      `readSessionCookie()` accepts a raw Cookie header, so the upgrade
      path can reuse it directly.
- [x] Token-free check scripts and vitest run in dev mode unchanged
      (`KUHN_AUTH_MODE` defaults to dev; full suites pass; dev backend
      serves without a cookie).
- [x] Vitest coverage: expired/reused token rejected; cookie tampering
      rejected (bad sig / bad token / unsigned); dev fallback inert when
      `KUHN_AUTH_MODE` ≠ dev; logout revocation; expired session row;
      startup guard. Plus a live browser pass of the full login → app →
      sign-out loop against a magic-link-mode scratch stack.

## Notes

- Files: `session.js` (the swap), new `routes/auth.js`, `db/schema.sql`,
  `config.js` (auth mode, secret, mail transport), small `webapp/src/login.ts`.
- Mail transport: log-to-console in dev; a single SMTP env-var config
  (`KUHN_SMTP_URL`) for real use via nodemailer (zero-dep SMTP client,
  lazy-imported — dev and tests never load it). No mail-provider SDK
  dependency.
- Explicitly out of scope: SSO/OAuth, passwords, invites, roles UI, RLS.
  The architecture's "auth provider choice" question is answered as
  "magic link now, SSO swap point preserved."
