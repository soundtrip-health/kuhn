# Story 008-004: Margin comments

**Status:** done (2026-07-20)
**Epic:** [008 — Trust & the Writing Loop](../index.md)
**Estimate:** L

## Goal

Feedback lives in the document, not in chat: anchored comment threads on text
ranges, visible to every collaborator, with the Reviewer filing comments
in-place instead of dumping a critique into the chat panel.

## Sketch

- **Anchoring:** Yjs relative positions serialized into a `comments` table
  (project, path, anchor start/end, author — user id or agent slug, body,
  thread parent, resolved_at). Relative positions survive concurrent edits;
  on decode failure (text deleted) the comment degrades to "orphaned" rather
  than vanishing.
- **Editor:** a decoration marks commented ranges (same plugin approach as
  citation chips); a margin/side panel lists threads for the open document,
  scroll-synced; click-to-focus both ways. Reply, resolve, delete-own.
- **Agent surface:** an `add_comment` tool (path, quoted target text, body)
  granted to the Reviewer (and PM). The backend resolves the quote to a range
  server-side against current content — agents never compute positions.
- **Feed:** comment events on the project feed so other tabs update live;
  unresolved-count badge per document in the file tree.
- Reviewer prompt updated: critique = comments on the text + a short chat
  summary, not a chat essay.

## Acceptance Criteria

- [x] A user can select text and comment; threads support replies and
      resolve; state survives reload and appears in other tabs live.
- [x] Anchors survive concurrent editing around them; deleting the target
      text orphans the thread visibly instead of losing it.
- [x] The Reviewer files comments via `add_comment` with a quoted target; a
      quote that no longer matches is rejected back to the agent.
- [x] Comments render for all collaborators with author identity (agent
      comments carry the agent's color/tag, per the existing identity system).
- [x] Resolved threads leave the margin but remain browsable.

## As built (2026-07-20)

**Anchoring decision — quote + offsets, not persisted Yjs relative
positions.** The sketch's leaning didn't survive contact with the collab
lifecycle: the backend never materializes document text (the Yjs server relays
opaque updates), and rooms are evicted and re-seeded from disk on every real
file change (story 038), which mints fresh CRDT identities — a stored relative
position would decode against nothing after any agent write or suggestion
accept. What shipped instead:

- **Durable anchor** = the exact quoted text + character-offset hints
  (`comments.anchor_quote/start/end`), resolved by ladder: live mapped
  decoration → exact quote (nearest the hint) → whitespace-normalized →
  markdown-stripped → orphaned.
- **Live tracking** = ProseMirror `DecorationSet.map` — remote Yjs edits
  arrive as transactions, so decorations track concurrent edits with no Yjs
  position math (same mechanism as suggestion hunks).
- **Drift writeback**: a doc-change hook re-checks anchors (debounced); edits
  inside a quoted range PATCH the refreshed quote back so the thread
  re-anchors on the next load, and vanished text flips `orphaned` on the
  server (both directions — restored text un-orphans).

**Backend** — `comments` table (threads via `parent_id`, root-only anchors /
resolve state); `db/comments.js` store + `resolveQuote`; REST routes
(`routes/comments.js`) with a project-membership guard (the `authorizeProject`
pattern — stricter than the file routes, since comments are user prose);
`comment` feed events (no `file_change` side effects — no evict/commit);
`add_comment` MCP tool (Reviewer + PM, compose-denied) resolving quotes
against stored bytes and rejecting stale quotes back to the agent; Reviewer
prompt rewritten ("margin comments first", chat = short summary), PM prompt
notes the tool.

**Webapp** — `comments.ts`: decoration plugin + docked panel (threads in
anchor order, reply/resolve/reopen/delete-own, orphan chip, resolved group,
agent color/tag via `agentIdentity`); comment-on-selection lives in Crepe's
selection toolbar (a floating bubble collided with that same toolbar);
click-to-focus both ways; unresolved-count file-tree badge (server truth,
not cleared by mark-seen); source mode shows a read-only gutter marker per
commented line (v1 per the note below).

**Verification** — 19 backend tests (store, quote ladder, HTTP contract,
membership 404s) + token-free `npm run comments-check` (Playwright, isolated
stack): badge/decoration/panel render, reply, resolve, in-editor deletion →
orphan round-trip, toolbar-composer create. 316 backend tests green.

**v1 scope boundaries** (deliberate, not defects): the panel is an ordered
side list, not a scroll-locked margin overlay; agents file root comments only
(no agent replies to existing threads); source-mode gutter markers are
computed at mode entry, read-only. Story 008-003 consumes these anchors for
claim-check verdicts.

## Notes

- This is the natural output surface for 008-003's verdicts and the
  foundation for any future human co-review workflow.
- Positions-in-Yjs means comments work in rich mode; source mode (story 039)
  shows a gutter marker per commented line as a v1.
