# Kuhn — UI Design Brief

**Status:** delivered — the "Column" direction handoff arrived 2026-06-12 and lives in
[handoff/](handoff/) (tokens, three hi-fi screens, component specs, screenshots).
Implementation is story
[002-025](../epics/002-agent-orchestration-layer/stories/025-ui-design-implementation.md).
**Created:** 2026-06-12
**Audience:** Claude Design (or any designer starting the Kuhn UI)
**Companion:** [claude-design-prompt.md](claude-design-prompt.md) — the kickoff prompt that references this brief

## 1. What Kuhn is

Kuhn is a web application for scientific and technical writing with integrated AI agents.
The agents are the product; the editor is the surface. A user is interviewed by a PM agent,
gets a seeded project (literature, guidance summaries, document skeleton), then writes in a
WYSIWYG markdown editor with AI slash commands, and renders to PDF / exports to Word.

One app, three surfaces, all visible at once on desktop:

1. **Editor** (center, primary) — Milkdown WYSIWYG markdown: headings, citations `[@key]`,
   math, figures, cross-references. Documents are journal articles, clinical protocols,
   grants, SOPs.
2. **Agent chat** (left panel) — conversation with six agents; streaming responses;
   long-running pipeline progress; agent questions back to the user.
3. **File manager** (right panel) — project tree, uploads, previews, file status.

Plus a top bar (app/project name, actions) and a status bar (save state, agent activity,
token usage).

## 2. Who it's for

Protocol authors, grant writers, medical/regulatory writers, academic PIs. **Word/Docs
people, not LaTeX people.** They are domain experts, often senior, working on high-stakes
documents (FDA submissions, NIH grants). Two implications:

- **Familiar, calm, document-centric.** The editor should feel like a serious writing tool
  (Google Docs / Typora / iA Writer territory), not a developer IDE or a chat toy.
- **Trustworthy.** This market asks about data isolation before uploading a protocol. The
  visual language should read as professional and precise — closer to a regulatory-grade
  tool than a startup gradient playground.

## 3. The six agents

Chat messages are tagged by agent role. Each role needs a recognizable identity
(color/icon/label) that stays subordinate to the content:

| Role | Name | Does |
|------|------|------|
| `pm` | PM | Interviews the user, configures the project, dispatches other agents, reports status |
| `writer` | Writer | Drafts and edits document text |
| `ra` | Research | Searches PubMed/bioRxiv, manages references |
| `advisor` | Advisor | Domain/regulatory expertise; ingests uploaded guidance |
| `reviewer` | Reviewer | Critiques sections and full drafts |
| `analyst` | Analyst | Runs Python, generates figures/tables |

## 4. Key flows to design for

### 4a. Project seeding (the first-run experience)

User clicks **Seed project** → PM interviews them in chat (document type, topic, materials,
timeline) → a deterministic pipeline runs: Advisor ingests uploads, Research populates the
bibliography, Writer generates a skeleton. This takes minutes, with multiple agents working
in stages. Needs:

- Interview chat that feels guided (the PM asks structured questions)
- **Pipeline/stage progress** — what stage is running, which agents are active, streamed
  activity ("Research: searching PubMed…")
- **Agent questions with a timeout** — mid-pipeline, an agent may ask the user something;
  the question has a countdown and expires to a default if unanswered (states: pending,
  answered, expired)
- Files appearing in the tree as agents create them
- An empty/new-project state before any of this happens

### 4b. Writing with slash commands

In the editor, typing `/` opens a command menu: `/cite <query>`, `/write <request>`,
`/research`, `/figure`, `/review`, `/ask`, `/status`. Needs:

- Slash command menu (ProseMirror-native popup at the caret)
- `/cite`: inline search results → pick a paper → citation chip inserted, `.bib` updated
- `/write`: writer agent **streams an edit into the document** shown as a suggestion the
  user accepts or rejects (diff-like presentation, in-flow)
- Citation chips `[@smith2024]` rendered as readable inline elements

### 4c. Render & export

Markdown → Typst → PDF preview; Pandoc export to docx/LaTeX. Needs a preview affordance
(pane? overlay? toggle with the editor?) and export actions. Design may propose where this
lives.

### 4d. Review cycles

Reviewer produces critiques as chat messages and as files; PM triages. Mostly reuses chat +
files patterns, but consider how a "report" message differs from a conversational one.

### 4e. Session continuity

Chat history restores on reload. Long jobs survive refresh and re-attach to progress.
The UI should make "you're back, here's where things stand" legible.

## 5. Current state (what exists today)

A functional but undesigned scaffold (`webapp/`): fixed three-pane flex layout, ~190 lines
of CSS, system font stack, a handful of hardcoded colors (`#5e81ac` accent on `#faf9f7`
panels), native form controls, an agent-role `<select>` next to the chat input. Status bar
shows doc name, save state, agent activity, and token count. There is no logo, no type
system, no spacing scale, no dark mode, no component library. **Treat the current look as
placeholder, not precedent.** The information architecture (chat | editor | files) has
worked well in testing and should be the starting point, but the design may propose
refinements (collapse behavior, panel sizing, where preview lives, etc.).

## 6. Constraints

- **Implementation:** Vite + TypeScript, **no UI framework** (no React/Vue). Vanilla DOM +
  CSS. Deliver design as **design tokens (CSS custom properties) + HTML/CSS mockups** that
  can be lifted into the app — not Figma-only artifacts.
- **Editor:** Milkdown (ProseMirror). Themed via CSS; editor typography is part of the
  design (it renders real documents: H1–H4, body, captions, tables, math, code).
- **Desktop-first.** Primary target is a laptop/external display. Graceful behavior down to
  ~1100px (panels collapse); mobile is out of scope.
- **Light mode first**; choose tokens so dark mode is a follow-on, not a rework.
- **Accessibility:** WCAG AA contrast; visible focus states; the chat and command menu are
  keyboard-driven.
- **Long-running content:** chat messages include markdown (tables, code, lists); documents
  are long — typography and density matter more than chrome.

## 7. Deliverables requested (in order)

1. **Design direction** — 2–3 distinct visual directions (name, one-paragraph rationale,
   one mocked key screen each: the full workspace mid-seeding). We pick one.
2. **Foundations** — chosen direction expanded into tokens: color (incl. the six agent role
   identities), type scale (UI + document/editor scales separately), spacing, radii,
   elevation, focus/state conventions. As CSS custom properties.
3. **Core screens** — full-fidelity HTML/CSS mockups:
   - Workspace, steady state (editing a protocol, chat idle, file tree populated)
   - Workspace during seeding (pipeline progress, streaming agent message, a pending
     agent question with countdown)
   - Empty state (new project, pre-seeding)
4. **Component specs** — states and variants for: chat message (per role, streaming,
   error), agent question card (pending/answered/expired), pipeline progress, chat input +
   agent selector, slash command menu, `/cite` picker, `/write` suggestion accept/reject,
   citation chip, file tree rows (new/modified/generated), top bar, status bar, buttons/
   inputs, toasts.
5. **Editor typography spec** — the document canvas: measure, scale, heading hierarchy,
   captions, tables, math/code blocks, citation chips in running text.

Out of scope for now: marketing site, onboarding/auth screens, mobile, dark mode (tokens
should permit it), logo design beyond a simple wordmark treatment.

## 8. Reference material

- `docs/architecture.md` — system architecture, surfaces, slash commands
- `docs/epics/002-agent-orchestration-layer/use-case.md` — full user workflow + an ASCII
  layout sketch of the original concept
- `webapp/index.html` + `webapp/src/style.css` — the current scaffold
- A screenshot of the running app, if available (optional but helpful)
