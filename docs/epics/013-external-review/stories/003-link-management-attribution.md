# Story 013-003: Link management & attribution

**Status:** ready
**Epic:** [013 — External Review via Magic Links](../index.md)
**Estimate:** M

## Goal

The member-facing half: share a doc from the editor, see and revoke active
links, and see reviewer activity attributed everywhere it lands. Without
this, links minted in 001 are unaccountable.

## Sketch

- **Share dialog** on a document (editor toolbar): choose mode + expiry
  (presets: 7d default, 24h, 30d), mint, copy link. Copy states what the
  reviewer will and won't see, including the full-edit/agent-overlap note
  from 013-002.
- **Active links panel** (per doc, and rolled up per project): reviewer
  name (once claimed), mode, created by, expires, last active; revoke
  button. Editor+ can mint and revoke on docs they can edit; owners can
  revoke anything.
- **Attribution:**
  - Comments by reviewers render name + "external reviewer" tag (the
    nullable-author decision from 013-001 surfaces here).
  - Reviewer edits (edit mode) emit `file_events` attributed to the review
    link (`actor: reviewer:<linkId>` pattern alongside the existing
    user/agent actors) so the feed and 010-005's audit view tell the truth.
  - Version history (008-002) shows reviewer-session saves attributed the
    same way.
- Revocation is immediate: live guest session invalidated (next request
  403s; open Yjs socket closed with a "link revoked" code the reviewer page
  explains).

## Acceptance Criteria

- [ ] Mint-copy-share round trip from the editor in one dialog; link works.
- [ ] Active links visible with claim/activity state; revoke kills a live
      reviewer session within one request/socket cycle.
- [ ] Reviewer comments, edits, and versions are all visibly attributed as
      external, in-app and in the audit/feed surfaces.
- [ ] Feed events fire on mint/claim/revoke so project members see review
      activity without opening the panel.
- [ ] Permission matrix (who mints/revokes) enforced route-level.

## Notes

- Email-sending the link is out of scope v1 (copy-link only) — members
  already have the reviewer's email thread; revisit with the 009-002 mailer
  needs if both want it.
