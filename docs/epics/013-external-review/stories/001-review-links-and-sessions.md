# Story 013-001: Review links & guest sessions

**Status:** done
**Epic:** [013 — External Review via Magic Links](../index.md)
**Estimate:** M

## Goal

The credential layer: an org member mints a magic link scoped to one
document and one mode (view / comment / edit); an outside reviewer opens it
and gets a guest session that can reach exactly that document's routes and
nothing else.

## Sketch

- Schema: `review_links` (id, project_id, path, mode CHECK
  (`view/comment/edit`), token_hash, created_by, expires_at, revoked_at,
  claimed_at, reviewer_name). `review_sessions` mirroring `sessions` but
  referencing `review_links` instead of `users` — hash-only secrets, same
  cookie/HMAC discipline (`kuhn_review_session`, separate cookie name).
- Claim flow: open link → verify token (unexpired, unrevoked) → name prompt
  → create review session, stamp `claimed_at` + `reviewer_name`. Second
  claim while unexpired: refuse with a "link already in use" page (the
  single-reviewer interpretation — confirm at kickoff; a re-share is a new
  link).
- Guest middleware: a distinct resolver in `session.js` that produces a
  `reviewer` principal `{linkId, projectId, path, mode, name}` — **not** a
  `users` row. Route allowlist per mode:
  - view: doc read, Yjs join (read-only), comment list
  - comment: + comment create/reply/resolve-own
  - edit: + Yjs write (message-level gate is 013-002's job)
  - everything else — projects, files listing, chat, agents, citations,
    org routes — refuses regardless of mode.
- Move/delete interaction: link binds to path; a 012-002 `moved` event
  updates `review_links.path` in the same transaction; delete revokes.
- Creation guard: minting requires editor+ membership on the project's org.

## Acceptance Criteria

- [ ] Minted link opens for an anonymous browser, prompts for a name, and
      yields a working session for exactly the target doc.
- [ ] Expired, revoked, and already-claimed links each show a distinct,
      human-readable refusal page.
- [ ] A guest session probing any non-allowlisted route gets 403/404 —
      covered by an explicit route-matrix test (the invariant-bearing test
      of this epic).
- [ ] Only token/session hashes are stored.
- [ ] Mint/claim/revoke events recorded (auth_events if landed).

## Notes

- Viewer-role members (010-003) are unaffected — this path is only for
  people with no account at all.

## As built (2026-08-04)

All ACs met. `auth_events` never landed (010-005), so mint/claim/revoke are
recorded on `review_links` columns + live `review_link` feed events — see the
epic index "As built" for this and the confirmed single-reviewer/any-member/
single-cookie decisions. Claim UPDATE + session INSERT are one transaction
(a crash between them must not burn the link).
