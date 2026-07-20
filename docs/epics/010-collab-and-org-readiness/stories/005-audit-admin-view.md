# Story 010-005: Audit & admin view

**Status:** draft
**Epic:** [010 — Collaboration & Org Readiness](../index.md)
**Estimate:** M

## Goal

Surface the audit trail the backend already keeps. `file_events` records who
changed what (user or agent, with job attribution), `jobs` records every agent
run and its spend, and chat transcripts are append-only — but none of it is
visible to an org owner. An admin view turns "trust us, it's logged" into a
screen.

## Sketch

- **Owner-only admin page** (role from 010-003) per org:
  - Activity: `file_events` across the org's projects — filter by project,
    actor (user/agent), kind, date range; CSV export.
  - Agent runs: `jobs` with status, agent, requesting user, duration, token
    spend (joins 009-003's rollups if present).
  - Access: memberships and roles (010-003's management UI can live here).
- **Auth events gap:** logins/logouts/failed verifications are not recorded
  today — add a minimal `auth_events` table (user/email hash, event, ts,
  mode) written from the auth routes, and include it in the view. No IP/UA
  collection without flagging it in the data-pipeline doc.
- Retention: `file_events` self-prunes at 1000/project (config) — the view
  states its window honestly; raising the cap for audit-minded orgs is a
  config note, not new machinery.
- Export is CSV download via the existing authenticated fetch pattern; no
  third-party analytics anywhere.

## Acceptance Criteria

- [ ] An owner sees org-wide file activity with filters and CSV export;
      editors/viewers get 403 on the routes, not just hidden UI.
- [ ] Agent runs are listed with requesting user, agent, status, and token
      spend.
- [ ] Auth events (login link requested/redeemed, logout, refusals) are
      recorded from this story forward and visible.
- [ ] The view states its retention window; `docs/data-pipeline.md` §1
      (tables) and §8 (operator concerns) updated for `auth_events` and the
      admin surface.

## Notes

- Deliberately read-only over existing truth (plus the one new auth table) —
  no new event pipeline. If orgs need longer retention or SIEM export,
  that's a follow-up with its own retention design.
