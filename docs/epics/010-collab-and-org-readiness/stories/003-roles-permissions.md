# Story 010-003: Roles & permissions

**Status:** draft
**Epic:** [010 — Collaboration & Org Readiness](../index.md)
**Estimate:** L

## Goal

Not everyone in an org is an editor. Add `role` to `memberships`
(owner / editor / viewer) and enforce it server-side on every mutating
surface; today membership alone grants full write everywhere, which no org
pilot will accept.

## Sketch

- Schema: `memberships.role` (default `editor` for existing rows; the seeded
  first user of an org becomes `owner`). Migration note in `schema.sql`
  history.
- **Enforcement matrix** (server-side, alongside the existing membership
  checks — same helpers, one added argument):
  - viewer: read routes, SSE feeds, previews/exports; Yjs rooms join
    read-only (connection accepted, updates from the socket rejected)
  - editor: everything viewers have + file writes, chat/agent dispatch,
    citations, project create
  - owner: + membership management, org settings (ceilings, watch defaults),
    org-library delete, project delete
- Collab: read-only room membership is the subtle piece — enforce at the
  message level in `yjs-websocket.js` (drop sync-step-2/updates from
  viewer sockets), not just in UI.
- Webapp: role-aware UI (hide edit affordances for viewers; the editor opens
  in a read-only mode — Crepe `editable: false` + source mode read-only).
- Invitations: owner invites by email → membership with chosen role
  (magic-link flow already gets them in the door).

## Acceptance Criteria

- [ ] Every mutating route refuses below-threshold roles with 403 (audited
      route-by-route list in the story record); read routes work for viewers.
- [ ] A viewer's editor is visibly read-only, and a hand-rolled websocket
      client with a viewer session cannot mutate a room (test at the message
      level).
- [ ] Owners manage members/roles in an org settings UI; the last owner
      cannot be demoted.
- [ ] Agent dispatch is editor+ (agents mutate files); a viewer can read
      chat history but not send.
- [ ] `docs/data-pipeline.md` tenancy section updated with the role matrix.

## Notes

- Deliberately org-level roles only; per-project overrides are a follow-up
  if a pilot demands them (keep the check helper signature ready for it).
