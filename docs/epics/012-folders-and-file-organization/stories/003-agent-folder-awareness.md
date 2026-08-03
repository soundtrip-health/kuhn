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
- [ ] The two bibliography behaviours in the recon notes are decided and
      tested: render-time bib-scatter into rendered-from folders (accept it
      or materialize to one canonical path), and a citation op recreating a
      renamed-away `draft/`.
- [ ] Every gap found is either fixed here or has a filed owner (rule 2 of
      the story-hygiene rules).

## Notes

- This is deliberately a verification story; keep it S by filing anything
  L-sized rather than absorbing it.

### Pre-build recon (2026-08-03) — read before starting

The bibliography gap inherited from [012-001](001-folder-tree-ui.md) is real
but **not the shape 012-001 recorded**. `render.js` does resolve the bib as
`references.bib` next to the source (`bibPathFor`, render.js:28-31) — but both
render and export call `materializeBib` first (render.js:63,116), which
regenerates the full DB-reference export **at that adjacent path**
(db/references.js:219-224). So there are two distinct behaviours, not one
silent break:

1. **References in the DB (the normal path since epic 003):** a moved doc
   renders with its citations intact — but every folder you render from gets
   a full `references.bib` **materialized into it** as a side effect. Those
   writes emit no project event (they go straight through `writeProjectFile`),
   so scattered bib copies appear in the tree only on the next refresh.
   Decide whether bib-scatter is acceptable (it is at least correct) or
   whether render should materialize to one canonical path.
2. **Hand-authored `.bib`, no DB references (imported/legacy projects):**
   `materializeBib` returns false on an empty export, `readIfExists` finds
   nothing next to the moved doc, and citations are silently dropped — the
   originally-described break, narrowed to this case.

Related, found on the same sweep: every citation entry point defaults to
`DEFAULT_BIB_PATH = 'draft/references.bib'` (citations.js:14, upsert/add/
update/remove all take it as the default). `/cite` from a doc in any folder
still writes there — fine — but after `draft/` is renamed or moved, the next
citation op **recreates `draft/`** containing only `references.bib`
(`writeProjectFile` creates parents). Now reachable from the UI; needs at
least a test that characterises the chosen behaviour.

Already verified in code, so the agent-tool AC is a smoke confirmation, not
an investigation: `list_files` returns the real tree as JSON
(runtime.js:581-590); `move_file` emits the 012-002 `moved` event with a
pending-edit pre-check and disk rollback if publish fails (runtime.js:593+).
Render staging is folder-safe by construction — the sandbox mounts the whole
project at `/work` and the intermediate `.typ` is written next to the source
so relative paths resolve (render.js:83-91, sandbox.js:30) — the sibling-
asset AC is confirming Typst path resolution empirically, nothing more.
Library promotion already reduces to `basename()` (org-library.js:49-51).
