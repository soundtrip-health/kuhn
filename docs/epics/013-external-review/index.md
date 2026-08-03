# Epic 013: External Review via Magic Links

**Status:** ready
**Created:** 2026-08-02
**Issue:** [#48](https://github.com/rfdougherty/kuhn/issues/48)

## Goal

Org members share a single document with an outside reviewer via a magic
link, in one of three modes: **view-only**, **view-and-comment**, or **full
edit**. Reviewers get the Milkdown editor and the margin-comment surface for
that one document — no AI chat, no file manager, no project browser, no org
anything. This is the reviewer-facing counterpart of the collaboration work:
the comment model (008-004), Yjs collab, and the magic-link token discipline
(007-002) all exist; this epic composes them behind a sharply restricted
door.

## Design stance

- **A review link is a scoped credential, not a user.** It authenticates a
  `review_links` row (doc + mode + expiry), not a `users` row — reviewers
  never get memberships, and every org-scoped route stays closed to them.
  The reviewer types a display name on first open so comments and presence
  are attributed.
- **Enforcement is server-side per mode**, at the same level 010-003 puts
  viewer enforcement: REST guards for comment routes, message-level Yjs
  guards for edit (a view-only reviewer's socket updates are dropped, not
  just their UI disabled). 010-003's read-only-room machinery is therefore
  a prerequisite for the view and comment modes.
- **"One-time" from the issue is interpreted as single-reviewer, revocable,
  expiring** — the link binds to the first browser session that claims it
  (subsequent claims refused) rather than dying after one page load, which
  would make real review rounds miserable. Flagged as a decision to confirm.

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Review links & guest sessions](stories/001-review-links-and-sessions.md) — `review_links` table, create/revoke routes, claim flow, scoped guest session middleware | draft | M |
| 002 | [The reviewer surface](stories/002-reviewer-surface.md) — stripped-down doc view: editor + comments only, per-mode enforcement down to the Yjs message level | draft | L |
| 003 | [Link management & attribution](stories/003-link-management-attribution.md) — share dialog on a doc, active-links list with revoke, reviewer actions attributed in comments/presence/file_events | draft | M |

## Sequencing

001 → 002 (the surface needs the session) → 003 (management UI last, once
there's something to manage). 010-003's read-only room enforcement should
land before 002; if it hasn't, 002 builds that message-level guard itself
and 010-003 inherits it.

## Risks

- **Tenancy boundary** — this is the first credential that crosses the org
  wall by design. The guest middleware must be a separate, narrower path
  (doc-scoped allowlist of routes), not a flag on the normal session; review
  accordingly, like storage.js root enforcement.
- **Comment model fit** — comments are attributed to `users` rows today;
  reviewer attribution needs a nullable author + display-name field or
  shadow identity. Decide in 001, before 002 bakes it in.
- **Full-edit mode + agents** — an external edit lands in the same Yjs doc
  the owner's agents edit; pending-edit conflicts with an active reviewer
  session need a test, not an assumption.
