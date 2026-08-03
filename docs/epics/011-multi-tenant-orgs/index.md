# Epic 011: Multi-Tenant Orgs & Administration

**Status:** ready
**Created:** 2026-08-02
**Issue:** [#46](https://github.com/rfdougherty/kuhn/issues/46)

## Goal

Turn the org model from "a tenancy scope with access control" into something
an operator can actually run as a multi-tenant product: a **super-admin**
creates orgs and invites their first admins; **org admins** invite members,
configure org settings, and control what becomes org-wide guidance; **regular
users** work in projects and can *suggest* promoting project guidance to the
org library, gated on admin approval.

The substrate mostly exists: `organizations`/`users`/`memberships` (007),
magic-link auth + sessions (007-002/003), the org library with direct
promote-from-project (006-004). What's missing is the authority structure on
top: who may create orgs, who may join them, who approves shared content.

## Relationship to Epic 010

Epic 010 owns the **permission machinery**; this epic owns the **tenant
administration** built on it:

- **010-003 (roles & permissions) is a hard prerequisite.** Its
  owner/editor/viewer model maps onto issue #46's vocabulary as
  *org admin = owner*, *regular user = editor* (viewer additionally serves
  Epic 013's read-only reviewers). No fourth in-org role is introduced here;
  super-admin is a **platform** attribute on `users`, not a membership role.
- 010-003's sketch mentions owner invitations in passing — the full
  invitation flow is owned by **story 002 here**; 010-003 should land only
  the role column + enforcement matrix.
- 010-005's admin view is the natural home for the member/role management UI;
  story 003 here adds the settings tab beside it.

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Super-admin & org lifecycle](stories/001-superadmin-org-lifecycle.md) — platform super-admin role, create/suspend orgs, invite first admin, minimal platform console | draft | M |
| 002 | [Org member invitations](stories/002-member-invitations.md) — admin invites by email with role; pending invites table; redemption via the existing magic-link door | draft | M |
| 003 | [Org settings surface](stories/003-org-settings.md) — name/slug, default role on join, library seeding default, spend-ceiling pointer (009-003) | draft | S |
| 004 | [Guidance promotion approval](stories/004-guidance-promotion-approval.md) — members suggest promotion to the org library; admins approve/reject from a queue; direct promote becomes admin-only | draft | M |

## Sequencing

010-003 first (external prerequisite). Then 001 → 002 (invitations need an
org to invite into and an admin to do the inviting) → 003/004 in either
order. 004 is the only story touching Epic 006's surfaces; it changes
`promote-from-project` behavior, so coordinate its UI copy with the existing
library panel.

## Risks

- **Role-model drift** — three places now name roles (schema `owner/member`,
  010-003's `owner/editor/viewer`, issue #46's `admin/regular`). The 010-003
  migration is the single point where this gets reconciled; this epic must
  not add its own vocabulary.
- **Super-admin blast radius** — a platform role that can enter any org is a
  tenancy-invariant exception. Scope it to org lifecycle + first-admin
  invitation only (no content access), and audit its actions from day one
  (010-005's `auth_events`/admin view).
- **Approval queue vs. library ingestion** — promotion approval must sit
  *before* ingestion (006-002), not after, or rejected docs still hit the
  FTS index.
