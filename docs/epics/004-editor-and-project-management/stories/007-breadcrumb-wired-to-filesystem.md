# Story 007: Breadcrumb wired to the file system

**Status:** ready
**Epic:** [004 — Editor Upgrade + Project Management](../index.md)
**Estimate:** M

## Goal

Make the top-left breadcrumb reflect the real organization, project, and open
document instead of hardcoded text, and make each segment navigable. This is the
user-visible payoff of the org model (005) and the browser (006): the breadcrumb
always shows where you are and lets you move.

## Acceptance Criteria

- [ ] The breadcrumb (`index.html:23-28`) renders live segments: **org name**
      (from the session/active org), **project name** (active project), and
      **active document** (open file path, from `currentDocumentPath()`).
- [ ] The hardcoded `Okafor Lab` org label and `Phase 2` pill are removed (or the
      pill is repurposed to real project metadata, e.g. project type — decide and
      document).
- [ ] Each segment is navigable: the org segment opens the org's projects, the
      project segment opens its document list / file tree, and the document
      segment focuses/reveals the open file in the tree.
- [ ] The breadcrumb updates live when the open document changes
      (`openDocument` → `setDocument`) or the project/org switches (Story 006),
      staying in sync with the editor sub-header path (`#editor-path`).
- [ ] No hardcoded org/project/document strings remain in `index.html` or
      `main.ts`.

## Notes

- Reuse existing plumbing: `setDocument()` / `#editor-path` (`status.ts`,
  `editor.ts:173-175`) already track the open document; the breadcrumb should
  subscribe to the same state rather than introduce a parallel source.
- The active org/project/document state is defined in Story 006 — this story
  binds the breadcrumb to it; avoid duplicating state.
- Keep the "Column" design language: the breadcrumb is small text with `/`
  separators; navigable segments can be buttons/menus styled to match.
- Depends on Stories 005 and 006.
