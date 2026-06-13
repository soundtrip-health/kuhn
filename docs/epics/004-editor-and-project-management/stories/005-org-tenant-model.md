# Story 005: Org/tenant data model & API

**Status:** ready
**Epic:** [004 — Editor Upgrade + Project Management](../index.md)
**Estimate:** L

## Goal

Introduce a real organization/tenant model so projects are owned by an
organization and scoped to the signed-in user, replacing the single
`owner_id='default'` placeholder. This is the data + API foundation the
project/document browser (006) and the wired breadcrumb (007) build on. Identity
stays deliberately minimal — enough to resolve a current user → org
memberships — not a full auth provider.

## Acceptance Criteria

- [ ] Idempotent schema migrations in `agent-backend/src/db/schema.sql` add:
      `organizations` (id, name, slug, timestamps), `users` (id, email/handle,
      display name, timestamps), and `memberships` (user_id, org_id, role) —
      following the existing `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD
      COLUMN IF NOT EXISTS` idempotency pattern.
- [ ] `projects` gains an `org_id` FK (`REFERENCES organizations(id)`), added
      idempotently; existing rows are backfilled into a seeded **default
      organization** so no project is orphaned. `owner_id` is retained or
      migrated per the tenancy invariants.
- [ ] A minimal identity/session resolves a "current user" on each request (dev
      login or identity header/selector — **not** SSO). The mechanism is
      documented and swappable when a real auth provider lands.
- [ ] Project queries are org-scoped: `GET /api/projects` returns only the
      current user's org(s) projects; `POST /api/projects` sets `org_id` from the
      session.
- [ ] New endpoints: `GET /api/orgs` (current user's orgs) and `POST /api/orgs`
      (create an org + membership). Optionally `GET /api/orgs/:id/projects`.
- [ ] The storage API is untouched — it is already project-root enforced
      (Story 018); org scoping happens at the DB/query layer, not the filesystem.
- [ ] Server starts cleanly against both a fresh DB and an Epic-002-era DB
      (migration is non-destructive).

## Notes

- Honors `docs/architecture.md` §Multi-Tenancy Invariants: every row stays
  project-scoped and carries a tenant column; single storage API; sandboxed
  execution. This story makes the long-planned org column real.
- Files: `agent-backend/src/db/schema.sql` (tables + migrations),
  `agent-backend/src/db/projects.js` (scoped queries), `routes/projects.js`
  (set `org_id` on create, scope list), plus a small session/identity middleware.
- Deliberately **out of scope:** invites, roles beyond a basic owner/member,
  billing, quotas, password reset, SSO. Architecture open question "Auth
  provider choice when multi-user lands" stays open.
- Row-level security (RLS) is the architecture's eventual path; enforcing scope
  in queries now is acceptable — note RLS as a follow-up if not adopted here.
- Webapp side (the switcher/browser that consumes these endpoints) is Story 006.
