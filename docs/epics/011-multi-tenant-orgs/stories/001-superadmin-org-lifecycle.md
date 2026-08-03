# Story 011-001: Super-admin & org lifecycle

**Status:** ready
**Epic:** [011 — Multi-Tenant Orgs & Administration](../index.md)
**Estimate:** M

## Goal

Someone has to create orgs, and it can't be "any signed-in user" (today
`POST /api/orgs` is open to any member — fine for a single-team install,
wrong for multi-tenant). Add a platform **super-admin** who creates orgs,
invites their first admin, and can suspend an org — and close org creation
to everyone else.

## Sketch

- Schema: `users.is_superadmin INTEGER NOT NULL DEFAULT 0`. Bootstrapped
  from `KUHN_SUPERADMIN_EMAILS` (comma-separated) at startup in `db/init.js`
  — env is the source of truth so a compromised DB row can't self-promote a
  new super-admin silently; flag flips both ways on boot.
- Routes (`routes/orgs.js`): org create/rename/suspend become
  super-admin-only; `organizations.status` (`active`/`suspended`) — suspended
  orgs 403 on every org-scoped route via the same membership-guard helpers.
- First admin: creating an org takes an admin email → issues an invitation
  (the 011-002 machinery; until that lands, direct owner-membership creation
  for an existing user is the interim).
- Console: a minimal super-admin page (org list, member counts, created,
  status, "create org" form). No content access — a super-admin who is not a
  member of an org cannot read its projects, files, or library; the tenancy
  guards do not special-case the flag.
- Existing single-org installs: the org-creation modal (006-004) stays for
  super-admins, disappears for everyone else; document the
  `KUHN_SUPERADMIN_EMAILS` requirement in the production checklist.

## Acceptance Criteria

- [ ] Only super-admins can create, rename, or suspend orgs; other users get
      403 and no longer see org-creation UI.
- [ ] Super-admin status comes from env at boot; removing an email from
      `KUHN_SUPERADMIN_EMAILS` demotes on next restart.
- [ ] A suspended org's routes all refuse (403) for its members; unsuspending
      restores access with no data loss.
- [ ] A super-admin without a membership cannot read any org-scoped content
      (test explicitly — this is the invariant-bearing criterion).
- [ ] Super-admin actions (org created/suspended, first-admin invited) are
      recorded (into `auth_events` if 010-005 has landed, else `file_events`-style
      table stub noted for it).

## Notes

- Deliberately no super-admin impersonation or content access; if a pilot
  needs support access into an org, that's an explicit invited membership.
