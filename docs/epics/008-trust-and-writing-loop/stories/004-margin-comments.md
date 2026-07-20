# Story 008-004: Margin comments

**Status:** draft
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

- [ ] A user can select text and comment; threads support replies and
      resolve; state survives reload and appears in other tabs live.
- [ ] Anchors survive concurrent editing around them; deleting the target
      text orphans the thread visibly instead of losing it.
- [ ] The Reviewer files comments via `add_comment` with a quoted target; a
      quote that no longer matches is rejected back to the agent.
- [ ] Comments render for all collaborators with author identity (agent
      comments carry the agent's color/tag, per the existing identity system).
- [ ] Resolved threads leave the margin but remain browsable.

## Notes

- This is the natural output surface for 008-003's verdicts and the
  foundation for any future human co-review workflow.
- Positions-in-Yjs means comments work in rich mode; source mode (story 039)
  shows a gutter marker per commented line as a v1.
