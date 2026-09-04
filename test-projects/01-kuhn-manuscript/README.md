# Test project 1 — Kuhn manuscript ("Scientific writing with AI")

The canonical simple end-to-end test: a **manuscript about Kuhn itself**,
recreated from the ground up. It reproduces the long-lived Test-Org1/Proj1 dev
project, so an experienced tester can compare the fresh run against a known-good
shape: `project.json`, a seeded bibliography + literature summary, a skeleton
`draft/main.md` arguing for structural guarantees in AI-assisted scientific
writing, guidance notes, review memos, and an ELI5 slide deck.

**What it exercises:** setup wizard (with seed-doc uploads) → seeding pipeline
(RA + Advisor research, Writer skeleton) → every agent in chat → `/cite` in the
editor → Reviewer pass → Marp slides → PDF preview and docx/tex export.

## Prerequisites

- Backend + webapp dev servers running; `ANTHROPIC_API_KEY` configured.
- Docker with the render images (`ghcr.io/typst/typst`, `pandoc/core`) and, for
  the slides prompt, the marp image (`kuhn/marp:latest` or `marpteam/marp-cli`).

## Setup

1. **Collect the seed documents** (they come from this repo's own docs):

   ```bash
   ./collect-seed-docs.sh        # writes ./seed-docs-upload/ (4 markdown files)
   ```

2. **Create the org + project** in the project browser (suggested names:
   org `E2E-Org1`, project `Kuhn Manuscript`, type **Manuscript**).

3. **Run the setup wizard** with the answers in [`prompts.md`](prompts.md) §1,
   uploading the four files from `seed-docs-upload/` at the uploads step, and
   choose **launch research + skeleton now** at the final step.

4. Work through the chat/editor prompts in [`prompts.md`](prompts.md) §2–§9 in
   order.

## Pass criteria

- [ ] Seeding completes: "✓ project seeding done"; no stage reports FAILED in `pm/status.md`
- [ ] `project.json` matches the wizard answers (title, research question, deliverables, timeline, 4 source materials)
- [ ] `draft/references.bib` exists with 10–20 entries, **no fabricated entries** (spot-check 3 DOIs/PMIDs resolve to real papers on the stated topics)
- [ ] `research/literature-summary.md` groups the papers by theme and cites only keys present in the .bib
- [ ] `guidance/` contains per-seed-doc summaries + `index.md`
- [ ] `draft/main.md` is a manuscript skeleton about AI-assisted scientific writing / Kuhn; every `[@key]` resolves; unresolved facts are `[TODO: …]` markers, not confident prose
- [ ] Each chat prompt in `prompts.md` produces its stated outcome (files created/edited where listed, chat shows tool events like "📚 ra added citation")
- [ ] `/cite` inserts a chip and a real BibTeX entry; re-citing reuses the key
- [ ] Preview renders a PDF with formatted citations + bibliography; docx/tex export downloads open
- [ ] Slides prompt yields a Marp deck under `slides/` that renders
- [ ] Reload mid-run: transcript restores, resumed sessions continue

## Reference shape

A known-good instance of this project (grown organically since 2026-08) lives in
maintainers' dev checkouts as Test-Org1/Proj1. The fresh run will differ in
wording but should match it in *structure*: `draft/` (main.md, references.bib),
`research/` (summaries, review memos), `guidance/`, `seed_docs/`, `slides/`,
`pm/status.md`.
