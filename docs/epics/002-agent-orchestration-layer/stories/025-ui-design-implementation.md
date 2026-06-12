# Story 025: UI Design Implementation ("Column")

**Status:** ready
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

- [ ] `kuhn-tokens.css` adopted verbatim; no hardcoded colors/font sizes remain in
      app CSS (grep for `#[0-9a-f]{3,6}` outside the token sheet)
- [ ] All three screens visually match the reference screenshots at 1440px (manual
      side-by-side; pixel-perfect per the handoff's fidelity note)
- [ ] Single-active-agent color rule holds: at most one colored agent in chat and one
      writer spine in the doc at any time; all idle agents render neutral
- [ ] Question card reaches all three states (pending with live countdown, answered,
      expired→default) against the real ask_user flow
- [ ] Editor renders the document scale: serif body 17/1.65 on a 660px measure;
      H1–H3, captions, tables, math, code styled; citation chips match the canonical
      spec and still round-trip `[@key]` markdown
- [ ] Keyboard a11y: slash menu and `/cite` picker fully keyboard-driven; visible
      `--focus-ring` on all interactive chrome; WCAG AA contrast for ink-on-surface
      pairs
- [ ] All existing check scripts pass after the restyle (`smoke`, `collab-check`,
      `cite-check`, `reload-check`, `render-check`) — selectors may be updated, but
      behavior must not regress
- [ ] No regression in panel collapse behavior down to ~1100px (graceful, per brief)

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
