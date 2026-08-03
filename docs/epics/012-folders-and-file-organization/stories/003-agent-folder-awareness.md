# Story 012-003: Agent & render awareness of folders

**Status:** ready
**Epic:** [012 — Folders & File Organization](../index.md)
**Estimate:** S

## Goal

Verify (and where needed, fix) that everything downstream of storage handles
nested paths once users actually create them: agent file tools, render/
export, citations, org-library promote. Storage has always allowed nesting,
so most of this should already work — this story is the sweep that proves
it and closes any gaps.

## Sketch

- **Agent tools:** `list_files` should return a tree (or clearly-delimited
  relative paths) so agents see structure; `move_file` emits the 012-002
  `moved` event; prompts need no change unless the sweep shows agents
  writing to root out of habit (then a one-line nudge in the pm/writer
  prompts).
- **Render/export (`render.js`):** nested doc → Typst/Pandoc in the sandbox
  — relative image/include paths inside moved docs are the likely break;
  test a doc in a folder referencing a sibling asset.
- **Citations:** `.bib` export path and `/cite` insertion for a nested doc.
- **Promote-to-library and uploads:** folder context preserved sensibly
  (library stays flat unless 006 says otherwise — promotion uses basename,
  collisions surfaced).
- Each verified surface gets a colocated test with a nested-path fixture;
  gaps found get fixed here if S-sized, or filed with a pointer if not.

## Acceptance Criteria

- [ ] Agents can list, read, write, and move files in nested folders in a
      real session (smoke-level check), and `list_files` output shows
      structure.
- [ ] Render and export succeed for a document inside a folder, including a
      relative reference to a sibling file.
- [ ] `/cite` and `.bib` export work from a nested document.
- [ ] Every gap found is either fixed here or has a filed owner (rule 2 of
      the story-hygiene rules).

## Notes

- This is deliberately a verification story; keep it S by filing anything
  L-sized rather than absorbing it.
- **Known gap inherited from [012-001](001-folder-tree-ui.md), start here:**
  `render.js` resolves the bibliography as `references.bib` **next to the source
  document**. Now that folders are a first-class UI concept, moving a document
  away from its bib silently drops the bibliography from every rendered PDF and
  Pandoc export — no error, just missing references. This is exactly the
  "relative reference from a nested doc" case in this story's sketch, and it is
  a confirmed break rather than a hypothesis.
