# Story 013-002: The reviewer surface

**Status:** ready
**Epic:** [013 — External Review via Magic Links](../index.md)
**Estimate:** L

## Goal

What the reviewer actually sees: a minimal page with the document in the
Milkdown editor and the margin-comment rail — no chat, no file tree, no
project chrome — with the link's mode enforced server-side, not just
visually.

## Sketch

- **Webapp:** a dedicated route/entry (e.g. `/review/<token>`) that boots a
  slim bundle: editor + comments + presence, driven by the guest session.
  No nav, a plain header (doc title, reviewer name, mode badge, "powered by"
  footer). Reuses `editor.ts` and the comment UI as modules — if they're
  too entangled with the app shell, the extraction is part of this story.
- **Mode enforcement, both layers:**
  - view: Crepe `editable:false` + read-only source mode; Yjs socket joins
    but its updates are dropped server-side (010-003's message-level guard;
    build it here if 010-003 hasn't landed, it inherits).
  - comment: same read-only doc; comment routes allowlisted; can create
    threads/replies and resolve own threads only.
  - edit: full Yjs write on this room only; still no file/chat/agent routes.
- **Presence:** reviewer appears in awareness with their claimed name and a
  visually distinct "external" treatment so members always know an outsider
  is on the doc.
- **Restriction hygiene:** the guest bundle must not ship member-only API
  calls that 403 into console noise; degrade cleanly (e.g. no unseen-badge
  or feed subscriptions).
- Full-edit + agent overlap: a pending agent edit landing while a reviewer
  holds the doc must merge like any second collaborator; add a test, and
  note the behavior in the share dialog copy (013-003).

## Acceptance Criteria

- [ ] Each mode renders correctly and a hand-rolled websocket/REST client
      holding a view or comment session cannot mutate the doc (message-level
      test, same bar as 010-003).
- [ ] A comment-mode reviewer can thread/reply/resolve-own; cannot resolve
      others' threads or edit the doc.
- [ ] Members see the reviewer in presence, marked external.
- [ ] The reviewer page makes zero requests to non-allowlisted endpoints.
- [ ] Works logged-out in a fresh browser profile (the actual reviewer
      experience), verified in the token-free check scripts.

## Notes

- Mobile-usable is a stretch goal; reviewers open links from email on
  phones. At minimum, don't break rendering at narrow widths.
