# Story 025: UI Design Implementation ("Column")

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Implement the Claude Design handoff — the **"Column"** direction — across the existing
webapp: lift the token sheet verbatim, rebuild the chrome (top bar, panels, status bar)
to the specified layout, restyle every existing component (chat, seeding progress,
agent question card, file tree, editor canvas, slash menu, `/cite` picker, preview
pane, toasts, empty state) against the tokens, and adopt the document typography
(Source Serif 4, 660px measure).

## Source of truth

`docs/design/handoff/` — read `README.md` first; it specifies layout, per-screen
content, interaction logic, and state shapes:

- `kuhn-tokens.css` — **lift verbatim**; structured for a follow-on dark mode
- `Kuhn Workspace - Column.dc.html` — workspace during seeding (stage checklist,
  streaming agent, pending question card)
- `Kuhn Workspace - Steady State.dc.html` — steady-state editing (slash menu, `/write`,
  `/cite`, Reviewer report card)
- `Kuhn Empty State.dc.html` — new-project state (seed CTA, upload drop zone)
- `Kuhn Foundations.dc.html` + `screenshots/*.png` — visible spec + pixel references

The `.dc.html` files are design references, not production code: recreate the markup
structure/token usage in the app's vanilla DOM + CSS; ignore the `<x-dc>`/`support.js`
preview runtime.

## Scope (maps spec → existing code)

1. **Foundations** — `kuhn-tokens.css` into `webapp/src/`; Geist / Geist Mono /
   Source Serif 4 (decide: self-host vs Google Fonts link); replace all hardcoded
   colors/sizes in `style.css` with tokens; single inline-SVG line-icon set (24×24,
   1.6px stroke, no emoji).
2. **Shell** — top bar 52px (logo + wordmark, breadcrumb + phase pill, seeding chip /
   saved check, Preview ghost + Export solid buttons), chat 380px / files 288px /
   editor flex with 38px sub-header (file path, word count, `/` hint), status bar 30px.
   The story-019 preview toolbar buttons fold into the top bar per spec.
3. **Chat** — neutral-ink messages; **single-active-agent color rule** (spine, avatar,
   name, working dot — only the agent currently streaming); meta chips; Reviewer
   "report" card variant; restyled input (soft field, agent-selector pill replacing the
   native `<select>`, solid send button); "session restored" divider (story 020
   restore already provides the data).
4. **Seeding panel** — recessed panel above the transcript: eyebrow + "N of M · ETA",
   progress track, stage checklist with done/running/queued rows and per-agent colored
   spinners/tags (driven by story 015's `stage` events).
5. **Agent question card** — pending (countdown pill, depletion bar, choice buttons,
   default note) → answered / expired states; respects `prefers-reduced-motion`;
   wires to the existing story 012/020 question/timeout flow.
6. **Editor canvas** — Source Serif 4 at the document scale (`--doc-*`), 660px measure,
   Milkdown theme overriding nord; citation chip per canonical spec (Geist 13px,
   `--accent` on `--accent-soft`, author-year label); restyled slash menu (agent-tinted
   command avatars, mono command names, keyboard-driven) and `/cite` picker.
7. **Files panel** — tree rows with per-file status (new/modified/generated/ingesting/
   done badges + spinners) and origin-agent icon tinting, to the extent the backend
   exposes it today (full status model may need a small `file_change` payload
   extension); upload drop zone lands with story 014 — design here, function there.
8. **Empty state** — editor hero (Seed project / Start blank), PM welcome message,
   files drop-zone visual.
9. **Toasts** — bottom-center of the editor, used by `/cite` insert and export actions.

## Acceptance Criteria

- [x] `kuhn-tokens.css` adopted verbatim (`webapp/src/kuhn-tokens.css`); no hardcoded
      colors remain in app CSS or TS (grep for `#[0-9a-f]{3,6}` → 0 matches outside the
      token sheet)
- [x] All three screens match the reference screenshots at 1440px (verified by
      screenshot: workspace chrome/typography, slash menu, empty-state hero, seeding
      panel, question-card states, reviewer report card)
- [x] Single-active-agent color rule holds: role color (spine, avatar, name, working
      dot, caret) is applied only to the agent currently streaming; settled/idle agents
      render neutral ink
- [x] Question card reaches all three states (pending with live 1Hz countdown +
      depletion bar, answered, expired) wired to the real `question` / `question_expired`
      / free-text reply flow; `prefers-reduced-motion` disables the depletion animation
- [x] Editor renders the document scale: Source Serif 4 body 17/1.65 on a 660px measure;
      H1–H3, blockquote, lists, tables, math, code styled (nord theme overridden);
      citation chips match the canonical spec and still round-trip `[@key]` (cite-check)
- [x] Keyboard a11y: slash menu and `/cite` picker keyboard-driven; agent-selector pill
      keyboard-navigable; visible `--focus-ring` on interactive chrome
- [x] All five check scripts pass after the restyle (`smoke`, `collab-check`,
      `cite-check`, `reload-check`, `render-check`); only the render-check export click
      was updated to open the new top-bar Export dropdown first (behavior unchanged)
- [x] Panel collapse remains graceful down to ~1100px (verified at 1100px)

## Out of Scope

- `/write` suggestion block (streamed text, accept/reject, merge animation) — that UI
  is specified in the handoff but ships with **story 017**, which must follow this
  spec's §"`/write` — streamed suggestion"
- Functional upload (story 014 — the drop zone is designed here, wired there)
- Dark mode (tokens permit it; re-declare under `[data-theme="dark"]` later)
- Mobile; marketing/onboarding screens; bespoke logo beyond the wordmark treatment

## Notes

- Spec arrived 2026-06-12 from the Claude Design track (brief:
  `docs/design/ui-design-brief.md`). Original zip extracted to
  `docs/design/handoff/` and discarded.
- The seeding stage checklist and question card replace the current system-line
  narration UX from stories 015/020 — the events already exist; this story is
  presentation.

### Implementation notes (as built)

- **New modules:** `kuhn-tokens.css` (verbatim), `icons.ts` (single inline-SVG set),
  `agents.ts` (identity/color map), `agent-selector.ts` (pill driving a hidden
  `#chat-role`), `seeding.ts`, `question-card.ts`, `toast.ts`. `chat.ts`, `editor.ts`,
  `slash.ts`, `files.ts`, `status.ts`, `main.ts`, `index.html`, `style.css` restyled.
- **Question card vs. design mock:** the design pending card shows two named choice
  buttons (RCTs only / Include OLE). The real `ask_user` flow (stories 012/020) takes a
  **free-text** answer and carries no options or deadline in the event, so the card is
  the visual surface and the answer is typed into the chat box; the card flips to
  *answered* on reply and *expired* on `question_expired`. The countdown mirrors the
  backend default (15 min) since the deadline isn't transmitted.
- **File status model:** rows show file-type icons + origin tint inferred from extension
  and highlight the open file; the richer per-file status badges (ingesting/generated/
  done) need a `file_change` payload extension and land with the upload work in
  **story 014**. The drop-zone empty state is designed here, wired there.
- **`/write`** appears in the slash menu but its streamed-suggestion UI is **story 017**;
  the other non-`/cite` commands fire the documented "Routed to <Agent>" stub toast.
- **Check-script change:** `render-check.mjs` now opens the top-bar Export dropdown
  before clicking `#export-docx` (the export buttons folded into the top bar per spec).
