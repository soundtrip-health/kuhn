# Story 011-004: Guidance promotion approval

**Status:** ready
**Epic:** [011 — Multi-Tenant Orgs & Administration](../index.md)
**Estimate:** M

## Goal

Regular users can *suggest* promoting a project file to the org library;
an org admin approves or rejects before it becomes org-wide guidance.
Today promote-from-project (006-004) is direct: any member can push any
project file into the library agents consult — issue #46 makes approval the
gate.

## Sketch

- Schema: `promotion_requests` (id, org_id, project_id, path, suggested_by,
  note, status `pending/approved/rejected`, decided_by, decided_at,
  decision_note).
- Flow:
  - Editor hits "suggest for org library" on a project file → request row +
    event on the feed. The file is *not* copied yet.
  - Owner sees a queue (admin surface): file preview (existing preview
    plumbing), suggester's note → approve or reject with optional note.
  - **Approve copies the file content as of decision time** into the org
    library through the existing promote path (storage copy → ingestion →
    FTS). Copy-on-approve, not copy-on-suggest: the suggester keeps editing
    freely, and the admin approves what they actually reviewed on screen.
  - Reject notifies the suggester (feed event; no email in v1).
- Owners retain direct promote (their approval is implicit). The
  `promotion policy` setting (011-003) can restore direct promote for
  everyone on trusted single-team installs.
- Ordering invariant: nothing touches ingestion (006-002) until approval —
  rejected content must never enter the FTS index.

## Acceptance Criteria

- [ ] With policy `approval-required`, an editor's promote action creates a
      pending request and does not copy or index anything.
- [ ] Owners see the queue with preview + note, and approve/reject; approve
      lands the file in the library with normal ingestion lifecycle events;
      reject records who/why.
- [ ] Editors cannot approve (403 route-level), including their own requests.
- [ ] Suggester sees the outcome on the project feed.
- [ ] With policy `direct`, behavior matches today's promote for editors and
      owners alike.

## Notes

- This is the "library versioning/approval workflow" deferred from Epic 006
  — that epic's deferred-items list should point here once this is ready.
- Re-suggesting after a rejection is allowed (new row, history preserved).
