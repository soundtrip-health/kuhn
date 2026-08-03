# Story 011-002: Org member invitations

**Status:** ready
**Epic:** [011 — Multi-Tenant Orgs & Administration](../index.md)
**Estimate:** M

## Goal

Org admins (owners) invite users by email with a chosen role; invitees land
in the org through the existing magic-link door. Today membership rows can
only be created by hand — there is no user-facing way to grow an org.

## Sketch

- Schema: `invitations` (id, org_id, email, role, invited_by, token_hash,
  expires_at, accepted_at, revoked_at). Same hash-only-secret discipline as
  `auth_tokens`.
- Flow: owner submits email + role → invitation row + magic link (reuses the
  mailer/dev-mode-link plumbing from 007-002). Redemption runs the normal
  magic-link verify, `getOrCreateUser`, then converts the invitation into a
  membership with the invited role and marks it accepted. Expired/revoked
  tokens get a clear refusal page.
- Roles offered: owner or editor (viewer too once 010-003 lands — the role
  enum comes from one shared constant, not duplicated here).
- UI: members list in the org admin surface (010-005's access tab is the
  home if it exists; a minimal members panel otherwise) — pending
  invitations shown with revoke; owners only.
- Guards: invitee email that already has a membership → 409 with a friendly
  message; the last-owner-cannot-be-demoted rule (010-003) applies to any
  role-change UI shipped here.

## Acceptance Criteria

- [ ] An owner can invite an email with a role; the invitee redeems the link
      and lands signed-in, inside the org, with that role.
- [ ] Editors cannot see or call the invitation routes (403, not hidden-only).
- [ ] Invitations expire and can be revoked; both states refuse redemption
      with a human-readable page.
- [ ] Only token hashes are stored; a dumped DB cannot mint a join link.
- [ ] Invitation issued/redeemed/revoked events are recorded (auth_events if
      present).

## Notes

- Supersedes the one-line "Invitations" bullet in 010-003's sketch — that
  story keeps role enforcement; this one owns the join flow. Cross-reference
  added there.
- OIDC JIT provisioning (010-004) is a parallel door: domain-mapped users
  auto-join with the org's default role (011-003 setting); invitations are
  for everyone else.
