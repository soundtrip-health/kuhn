# Epic 010: Collaboration & Org Readiness

**Status:** draft
**Created:** 2026-07-19
**Priority:** #3 of the 2026-07 roadmap (008 → 009 → 010)

## Goal

Make multi-user real and make an org pilot deployable. The collab transport
(Yjs, awareness, room auth) and the audit trail (`file_events`) already exist —
this epic puts faces on the former and an admin surface on the latter, hardens
the pieces `docs/data-pipeline.md` had to flag (memory-only rooms, dev-mode
auth, everyone-is-an-editor), and closes the last ingestion gap (scanned PDFs).

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Presence UI](stories/001-presence-ui.md) — collaborator avatars + live cursors; awareness already flows, it just has no face | draft | S |
| 002 | [Server-side Yjs persistence](stories/002-yjs-persistence.md) — rooms survive restarts; retires the seed-grant/eviction machinery of 038/041 | draft | L |
| 003 | [Roles & permissions](stories/003-roles-permissions.md) — owner/editor/viewer on memberships, enforced server-side | draft | L |
| 004 | [SSO (OIDC) login](stories/004-oidc-sso.md) — `KUHN_AUTH_MODE=oidc`, JIT provisioning, sessions unchanged | draft | M |
| 005 | [Audit & admin view](stories/005-audit-admin-view.md) — surface `file_events` + jobs + auth events; filter and export | draft | M |
| 006 | [OCR for scanned PDFs](stories/006-ocr-scanned-pdfs.md) — sandboxed OCR fallback where `pdftotext` finds no text layer (Epic 006 left this failing) | draft | M |

## Sequencing

001 and 006 are independent quick wins. 003 before 004 (roles give SSO users
something to be mapped into) and before 005 (the admin view needs an "admin").
002 is independent but should precede any serious multi-org pilot — it removes
the biggest data-durability caveat.

Two later epics build directly on 003: **Epic 011** (multi-tenant org
administration, issue #46) consumes the role model and owns the invitation
flow 003's sketch mentions in passing, and **Epic 013** (external review,
issue #48) reuses 003's message-level read-only room enforcement for guest
reviewers. That raises 003's priority within this epic. OCR (006) is filed here rather than in
Epic 006 because that epic is closed; its index's deferred-items note still
points forward correctly.
