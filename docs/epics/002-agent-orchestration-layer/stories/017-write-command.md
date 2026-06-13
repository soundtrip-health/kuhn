# Story 017: Writer Agent + `/write` — Streamed Suggestions with Accept/Reject

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** XL
**Completed:** 2026-06-12

## Goal

Ship the `/write` slash command: the user types `/write <instruction>` in the
editor, the writer agent streams a suggested passage into an in-document
**suggestion block** (writer-purple spine, character streaming, blinking caret),
and the user **accepts** (text merges into the document and persists) or
**rejects** (block disappears). UI per the design handoff
§"`/write` — streamed suggestion" (`docs/design/handoff/README.md`).

This story also owns the story-013 known issue: *agent edits to the open document
don't live-update the editor* (agents write via the storage API, not Yjs; the
status bar currently prompts a reload).

## Background — what exists today

- **Slash registry (story 016).** `webapp/src/slash.ts` exports
  `SlashCommand { name, hint, run(view) }`; commands register in
  `slashCommands()` in `webapp/src/editor.ts` (~line 56) — the comment there
  already reserves the spot for `/write`. The menu deletes the typed `/...` text
  before calling `run(view)`.
- **Agent task stream (stories 011/013).** `webapp/src/api.ts` →
  `runAgentTask({ role, projectId, input, sessionId?, context? }, onEvent, signal?)`
  POSTs `/api/agent/task` and yields SSE `AgentEvent`s:
  `text_delta`, `text`, `file_change`, `citation`, `question`, `question_expired`,
  `done` (with `usage`), `error`. `context` already supports
  `{ selection?, cursor?, files? }`. Aborting the fetch signal cancels the task
  server-side (`agent-backend/src/routes/sse.js` stops the producer on close).
- **Writer role.** Registered in the runtime
  (`agent-backend/src/agents/runtime.js`), tools filtered by DB allowlist, model
  per `agents.model` (story 021). `agents/writer/AGENTS.md` makes the writer the
  *only* agent that edits `draft/main.md` — fine for chat-dispatched work, but
  `/write` needs **compose mode** (return text, don't touch files; see below).
- **Editor/collab.** Milkdown + `@milkdown/plugin-collab` over Yjs; user saves go
  through a debounced `writeTextFile` (`webapp/src/editor.ts:182`).
- **Design.** Handoff README §"`/write`": suggestion block in-flow, `--writer`
  left spine, "WRITER · SUGGESTED EDIT" eyebrow with pulsing dot, char-by-char
  reveal with blinking caret, then an action row — **Accept** (solid `--accent`)
  / **Reject** (ghost) + muted provenance note; accept = fade-and-rise merge +
  toast "Suggestion accepted". Single-active-agent color rule applies. Story 025
  ships the tokens this styling uses — **build 017 on top of 025's tokens.**

## UX flow

1. User types `/write`; the menu row shows an `<arg>` placeholder (per design).
2. On select, a suggestion block appears at the caret with an inline instruction
   input ("What should the writer draft?"). Enter dispatches; Esc cancels and
   removes the block. (The design proto skips the input because it's canned;
   the real app needs the instruction. Keep the input inside the block so the
   flow stays in-document.)
3. While streaming: text accumulates in the block as plain rendered text with the
   writer caret. The block is **not part of the document** yet (see below). Esc or
   a ✕ control aborts the task.
4. On `done`: action row appears. **Accept** inserts the suggested markdown into
   the document at the block's position; **Reject** removes the block.
5. On `error`: block shows the message with Retry / Dismiss.

## Architecture decisions (implement to these unless they prove wrong)

1. **The suggestion lives outside the document until accepted.** Render it as a
   ProseMirror **widget decoration** (own plugin, e.g. `webapp/src/write-suggestion.ts`)
   anchored at the insertion position — *not* as document content. Rationale: the
   doc is Yjs-synced and autosaved; un-accepted suggestion text must not hit
   collaborators, persistence, or undo history. Accept = one transaction that
   inserts real nodes; reject = drop the decoration. Keep the anchor as a mapped
   position so concurrent edits elsewhere don't misplace it.
2. **Stream as text, parse on accept.** During streaming show the raw text
   (cheap, robust against partial markdown). On accept, parse the full string
   with Milkdown's parser (`parserCtx` via `editor.action`) and insert the
   resulting slice in a single transaction. The collab plugin syncs it to Yjs and
   the existing debounced save persists it — do **not** add a separate
   `writeTextFile` call for accepts.
3. **Compose mode for the writer.** The webapp builds the task input from a
   template: instruction + surrounding context (current section heading, ~1–2
   paragraphs around the caret, or the selection) + an explicit contract —
   *"Return only the markdown to insert. Do not edit any files."* Pass structured
   bits in `context` (`files: [currentPath]`, `cursor`, `selection`). Collect the
   suggestion from `text_delta`/`text` events. If the writer still performs file
   writes in practice, tighten at the runtime level (a task-level tool filter in
   `runAgentTask` — the per-role allowlist machinery from story 011 already
   exists) rather than fighting it in the prompt; note what was needed.
4. **Open-document `file_change` handling (013 carry-over).** When a
   `file_change` event targets the currently open path (chat-dispatched writer
   work, seeding): if the editor has no unsaved local edits, reload the content
   from the API into the doc in one transaction; if it does, keep the current
   status-bar prompt rather than clobbering. This replaces the reload dead-end.
5. **Session continuity.** Pass the previous writer `sessionId` (from `done`)
   on subsequent `/write` calls in the same editing session, so follow-ups
   ("make it shorter") keep context. Don't persist it across reloads (chat
   restore, story 020, covers conversational continuity).

## Acceptance Criteria

- [x] `/write` appears in the slash menu (writer-tinted avatar, `<arg>`
      placeholder, one-line description) and is fully keyboard-driven
- [x] Instruction input → streamed suggestion block matching the handoff spec
      (spine, eyebrow, char reveal, caret; reduced-motion respected)
- [x] While a suggestion streams, the document itself is unchanged: no Yjs
      update, no autosave fires, undo history clean (verify in the check script
      by inspecting the saved file mid-stream)
- [x] Accept inserts the parsed markdown at the anchor, persists via the normal
      save path, fires the "Suggestion accepted" toast, and survives reload
- [x] Reject and mid-stream Esc/✕ leave no trace; abort cancels the backend task
      via the fetch signal (story-011 SSE-close path). Reject/Esc are covered by
      the scripted check; live abort-cancels-budget verification is in story 022.
- [x] The writer performs no file writes during a `/write` task — enforced at the
      runtime (compose mode withholds `file_write`/`add_citation`/`project_config`),
      not just by the prompt; the check asserts the task is dispatched with
      `compose: true` and that no `file_change` reaches the editor
- [x] `error` events render in-block with Retry; Retry reuses the same instruction
- [x] Status bar/chat reflect the active writer per the single-active-agent rule
      while streaming (status agent line + the `--writer` suggestion spine are the
      only colored elements)
- [x] `file_change` on the open document live-updates a clean editor; a dirty
      editor gets the existing prompt instead (013 known issue closed) — see
      `applyExternalChange` in `editor.ts`; live agent-driven verification in 022
- [x] Token-free scripted check `webapp/scripts/write-check.mjs` driving the flow
      against a stubbed agent stream (accept, reject, mid-stream Esc, error+Retry,
      compose-mode assertion); one deliberate live run is deferred to story 022
- [x] Existing checks (`smoke`, `collab-check`, `cite-check`, `render-check`)
      still pass

## Implementation notes

- **Files:** `webapp/src/write-suggestion.ts` (new — the widget-decoration plugin
  + Suggestion controller), wired in `webapp/src/editor.ts` (`/write` command,
  `writeSuggestionPlugin`, `applyExternalChange`, in-session `writerSession`);
  styles in `webapp/src/style.css` (`.write-suggestion`); `x` icon added to
  `webapp/src/icons.ts`; compose mode in `agent-backend/src/agents/runtime.js`
  (`COMPOSE_DENIED_TOOLS`) + `routes/agent.js`; `compose` added to
  `AgentTaskParams` in `webapp/src/api.ts`; live-update fallback wired in
  `webapp/src/main.ts`.
- **Decision 3 resolved toward the runtime filter.** Rather than rely on the
  prompt contract alone (un-verifiable without a live token run), compose mode is
  enforced structurally by withholding the mutating tools — the prompt still asks,
  the allowlist guarantees. Cheap and makes the "no file writes" criterion true by
  construction.
- **Observation (not owned here):** the empty-state hero (`#editor-hero`) can stay
  up as an opaque overlay even when the document has content, when a warm/stale
  Yjs room desyncs — the story-024 collab-race surface. It does not affect real
  `/write` use (you can't type `/` under the hero), so the scripted check removes
  the hero element before interacting. If it recurs in live use, fold it into the
  story-022 live-verification pass.

## Out of Scope

- `/research`, `/figure`, `/review`, `/ask`, `/status` commands (design shows
  them as stubs; each is its own story when prioritized)
- Selection-aware **rewrite** (replace selected text with the suggestion) —
  stretch; insertion at caret is the deliverable. Leave the `context.selection`
  plumbing in place.
- Multi-suggestion / diff review across the whole document (reviewer adversarial
  loops are epic-deferred)
- Visual tokens/foundations (story 025 — a prerequisite; see Notes)

## Dependencies & risks

- **Depends on story 025** for `--writer`, `--accent`, toast and motion tokens.
  If built in parallel, gate merging behind a rebase on 025; don't reintroduce
  hardcoded colors 025 just removed.
- **Anchor drift:** concurrent edits while streaming can move the insertion
  point — mapped decoration positions handle this, but test typing above the
  block mid-stream (collab-check style).
- **Budget:** `/write` tasks run under `AGENT_TOKEN_BUDGET` weighting
  (story 020). A section-length draft is fine; if the writer recurses into
  subagents unexpectedly, the compose-mode contract is being ignored — see
  decision 3's runtime tightening.
- **Live verification burns quota** — same policy as story 022: scripted/stubbed
  checks in CI; live runs only when bobd triggers them.
