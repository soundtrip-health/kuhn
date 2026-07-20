# Story 010-004: SSO (OIDC) login

**Status:** draft
**Epic:** [010 — Collaboration & Org Readiness](../index.md)
**Estimate:** M

## Goal

Orgs sign in with their identity provider: `KUHN_AUTH_MODE=oidc` runs a
standard OpenID Connect code flow against a configured IdP (Okta, Entra,
Google Workspace), with just-in-time user provisioning. Magic-link remains
available; the session model doesn't change.

## Sketch

- Config: issuer URL, client id/secret, allowed email domains → org mapping
  (v1: one IdP, one org, domain-checked). Discovery via
  `.well-known/openid-configuration`.
- Flow: `/api/auth/oidc/login` (state+nonce+PKCE) → IdP → callback verifies
  the ID token, gets-or-creates the user by verified email (same
  `getOrCreateUser` path the magic link uses), auto-joins the mapped org,
  opens a **normal Kuhn session** — the signed `kuhn_session` cookie and
  everything downstream (REST, WS upgrade auth from story 007-003) are
  untouched.
- Role on JIT provision: default from org setting (viewer or editor,
  010-003), never owner.
- Logout stays local (revoke Kuhn session); IdP single-logout is out of
  scope v1.
- Library choice: a maintained OIDC client lib rather than hand-rolled token
  validation; pin and note it.

## Acceptance Criteria

- [ ] With OIDC configured, login round-trips through the IdP and lands a
      working session; magic-link continues to work when left enabled.
- [ ] Only allowed-domain, email-verified identities provision; others get a
      clear refusal page.
- [ ] State/nonce/PKCE enforced; callback rejects replays.
- [ ] JIT users land in the mapped org with the configured default role.
- [ ] `docs/data-pipeline.md` auth section + production checklist updated
      (OIDC option, what claims are stored — still email + display name
      only).

## Notes

- SAML is deliberately out: OIDC covers the target IdPs; revisit only on a
  real prospect requirement.
