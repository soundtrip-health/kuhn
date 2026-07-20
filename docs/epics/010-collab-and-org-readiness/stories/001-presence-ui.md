# Story 010-001: Presence UI

**Status:** draft
**Epic:** [010 — Collaboration & Org Readiness](../index.md)
**Estimate:** S

## Goal

Collaboration you can see: who is in the project, whose cursor is where.
The data already flows — Yjs awareness is wired through the provider and
milkdown's collab plugin imports `yCursorPlugin` — nothing sets the local
user's identity on it and nothing renders it.

## Sketch

- On document open, set `provider.awareness.setLocalStateField('user',
  { name, color })` from the session user (name from `users.display_name` /
  email local-part; color assigned per-user deterministically from the
  existing agent-palette-adjacent tokens).
- Remote cursors/selections render via the collab plugin's cursor support;
  style the caret + name flag to the design system.
- Topbar: small avatar chips for awareness peers on the open document
  (deduped by user, not tab), with idle fade.
- Dev-mode note: the seeded dev user means two dev tabs show as one user —
  correct behavior, mention it in the story record for testers.

## Acceptance Criteria

- [ ] Two sessions on one document see each other's named, colored cursor
      and selection live.
- [ ] Avatar chips show current peers on the open document; leaving/closing
      removes them (awareness timeout covers crashes).
- [ ] No presence UI renders when alone (zero-noise default).
- [ ] Works in rich mode; source mode (story 039) shows peers in the topbar
      only.

## Notes

- Cheapest story in the roadmap relative to perceived-product impact.
- Per-document peers in the files panel ("who has what open") is a natural
  v2 using the same awareness rooms; not in scope.
