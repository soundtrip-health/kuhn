# Handoff: Kuhn — Agent Writing Workspace ("Column" direction)

## Overview
Kuhn is a web app for scientific and technical writing (clinical protocols, NIH grants, FDA
submissions) with a team of integrated AI agents. The workspace is **one screen, three
surfaces**: agent **chat** (left), a WYSIWYG markdown **editor** (center, primary), and a
**file manager** (right), framed by a top bar and a status bar.

This bundle delivers the chosen visual direction — **"Column"** (calm, light, document-first)
— as design tokens plus three full-fidelity screens: the workspace **during seeding**, the
workspace in **steady state**, and the **empty / new-project** state.

## About the Design Files
The `.dc.html` files in this bundle are **design references created in HTML** — prototypes
that show the intended look and behavior. They are **not production code to copy directly.**

The implementation target is **Vite + TypeScript with no UI framework** (vanilla DOM + CSS),
and the editor is **Milkdown (ProseMirror)** themed via CSS. Your task is to **recreate these
designs in that environment** using its patterns — lift `kuhn-tokens.css` verbatim, then build
the DOM/CSS against those tokens. Do not ship the HTML prototypes as-is (they use a small
client-side render runtime, `support.js`, purely so the mockups are interactive; that runtime
is not part of the product).

> The prototypes were authored as "Design Components" — ignore the `<x-dc>`, `support.js`, and
> `data-props` scaffolding. The meaningful artifacts are the **markup structure, inline styles,
> token usage, and the documented interaction logic** below.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, radii, and interactions. Recreate the UI
pixel-perfectly using the exact token values in `kuhn-tokens.css`. All three screens are
designed at **1440 × 940** (desktop-first; graceful collapse down to ~1100px is in scope later,
not specified here).

---

## Design language (read first)

- **Personality:** a serious document tool — calm, precise, trustworthy. Closer to a
  regulatory-grade instrument than a startup gradient playground.
- **Two type worlds:**
  - **UI / chrome** (chat, panels, controls, status) → **Geist** sans.
  - **Document canvas** (the editor) → **Source Serif 4**, measure-constrained to a **660px**
    column, centered. This is the iA-Writer/journal reading surface scientists trust.
  - **Metadata** (timecodes, counts, token totals, file counts, command names) → **Geist Mono**.
- **Color discipline — the single most important rule:** chrome is neutral ink + one cool blue
  accent. **Agent role color appears ONLY on the agent that is currently active/speaking** — its
  left spine, avatar fill, name, and status dot. Every other agent message renders in neutral
  ink (gray avatar, ink name). Six agents must never turn chat into a rainbow.
- **Depth:** flat. Panels are separated by hairline borders, not shadows. Shadows are reserved
  for things that truly float — popovers (slash menu), toasts, and the document/screenshot cards.
- **No emoji.** Line icons only (24×24 grid, 1.6px stroke, round caps/joins, `fill:none`,
  `currentColor`).

---

## Layout (all three screens share this shell)

A vertical flex column at `100vw × 100vh` (mocked 1440 × 940):

```
┌───────────────────────────────────────────────────────────────┐
│  TOP BAR            height 52px, bg --chrome, border-bottom --line │
├──────────┬──────────────────────────────────┬─────────────────┤
│  CHAT    │            EDITOR                 │     FILES       │
│  380px   │            flex: 1                │     288px       │
│  --chrome│   bg --chrome, serif canvas       │  --chrome       │
│  border- │   centered, max-width 660px       │  border-left    │
│  right   │                                   │  --line         │
├──────────┴──────────────────────────────────┴─────────────────┤
│  STATUS BAR         height 30px, bg --soft, border-top --line  │
└───────────────────────────────────────────────────────────────┘
```

- Left panel fixed `380px` (seeding/steady) — `flex: 0 0 380px`.
- Right panel fixed `288px` — `flex: 0 0 288px`.
- Center editor `flex: 1; min-width: 0`. Inside it, a sub-header strip (38px) with the file
  path on the left (`protocol / main.md`, Geist Mono 11px `--ink-3`) and word count / `/`
  hint on the right; below it a scroll region whose inner column is
  `max-width: 660px; margin: 0 auto; padding: 48px 32px 120px`.
- Every panel scroll region: `min-height: 0; overflow-y: auto` (so the flex children scroll
  rather than the page).

---

## Screens

### 1. Workspace — during seeding  (`Kuhn Workspace - Column.dc.html`)
**Purpose:** the first-run pipeline is running; the user can keep working while agents seed the
project (Advisor ingests uploads, Research builds the bibliography, Writer drafts a skeleton).

**Top bar:** logo (22px ink square, 6px radius, 9px white inner square) + wordmark "Kuhn" (Geist
600, 15px); divider; breadcrumb `Okafor Lab / TRD Protocol` + a `Phase 2` pill
(`--accent` text on `--accent-soft`, 999px). Right side: a live **"Seeding · 2/4"** chip
(spinner + mono count, on `--soft`), `Preview PDF` (ghost button), `Export` (solid `--ink`).

**Left — chat with seeding panel on top:**
- A recessed **seeding panel** (`bg --soft`, border-bottom `--line-2`, padding 16/18):
  eyebrow "SEEDING PROJECT" + mono "2 of 4 · ~3 min"; a 4px progress track
  (`--soft-2`) filled 46% with `--accent`; then a **stage checklist**:
  1. **Interview** — done: 16px filled `--accent` circle with white check; "Brief captured · PM"
  2. **Ingest guidance** — running: 16px ring spinner in `--advisor`; label + small
     `Advisor` tag in `--advisor`; substatus "Reading FDA-PTSD-guidance.pdf · p. 12/40"
  3. **Build bibliography** — running: ring spinner in `--ra`; `Research` tag; "24 candidates…"
  4. **Generate skeleton** — queued: dashed 16px circle, whole row at `opacity: .55`; "Queued · Writer"
- **Transcript** below: a PM message (neutral) with three meta chips; a **Research message that
  is actively streaming** (this is the active agent → 2.5px `--ra` left spine, `--ra` avatar fill,
  `--ra` name, "working" dot, and a blinking caret block at the end of the text); then the
  **Advisor question card** (see Interactions).
- **Chat input** (bottom, border-top `--line-2`): a rounded `--soft` field "Ask an agent, or
  describe an edit…", an **agent selector** pill (colored dot + role + chevron) and a 30px solid
  `--ink` send button with an arrow icon.

**Center editor:** the protocol draft mid-generation — eyebrow "Clinical Trial Protocol · Draft",
H1 title (serif 34px), italic-weight subtitle, §1 with an inline **citation chip**
(`Goodwin 2022`), then a paragraph with a `--writer` left spine + "Writer is drafting" label +
blinking caret (active agent in the doc). Below: §2 as **shimmer skeleton lines**, and §3/§4 as
dimmed headings (`opacity` .4) — content the pipeline hasn't reached yet.

**Right — files, gaining files:** `protocol/` folder open with `main.md` (selected, `--soft`),
`01-background.md` with a **NEW** badge (`--accent` on `--accent-soft`), and `references.bib`
showing a `--ra` ring spinner + "building". `sources/` folder (count 3) with the three uploads;
`FDA-PTSD-guidance.pdf` shows an `--advisor` spinner ("ingesting"). File-type icon stroke color
encodes origin: `--reviewer` for source PDFs, `--pm` for the brief, `--ra` for the bib.

**Status bar:** `protocol/main.md` · "saving…" (pulsing `--accent` dot) on the left; on the
right, three overlapping agent dots + "3 agents working", "1 question pending" (`--advisor`),
"48,210 tokens".

### 2. Workspace — steady state  (`Kuhn Workspace - Steady State.dc.html`)
**Purpose:** seeding is done; the user is writing, chat is idle, the file tree is populated. This
screen carries the **editor interactions**.

Differences from screen 1: top bar shows a green **"Saved"** check instead of the seeding chip;
the left seeding panel is gone (chat is just transcript + input); messages are all neutral
(PM, Writer, and a **Reviewer "report" message** rendered as a bordered card with a header row
"Skeleton review · 2 notes" and bulleted critique — this is how a report differs from a
conversational message); the editor body is fuller (§1–§3 real prose, multiple citation chips);
the file tree is fully populated with green check / done states; status bar reads "all changes
saved" and "agents idle".

The editor has an **active editing line** — a borderless serif input at the caret with the
placeholder "Continue writing, or type / for a command…", plus a contextual hint chip
("Try /write…, or /cite"). See Interactions.

### 3. Empty — new project  (`Kuhn Empty State.dc.html`)
**Purpose:** pre-seeding. Nothing has run yet; give the user one clear action.

- Top bar: breadcrumb shows an "Untitled" project; the primary action is a **"Seed project"**
  button (solid `--accent`, sparkle icon).
- Left chat: a single PM welcome message inviting the user to seed or upload.
- Center editor: an empty-state hero — short heading, one line of guidance, and two buttons
  (**Seed project** solid `--accent`, **Start blank** ghost).
- Right files: an **upload drop zone** (dashed border, up-arrow icon, "Upload materials / Drop
  protocols, guidance, prior drafts…", accepted types in mono "PDF · DOCX · TXT · BIB"), and an
  empty hint "No files yet."

---

## Interactions & Behavior

All interaction logic below is implemented in the prototypes' logic classes — reproduce the
behavior, not the code.

### Seeding agent-question card (screen 1) — states: pending → answered | expired
- **Pending:** bordered card (`1px --advisor`, bg `#FBF6EC`, radius 12). Header: `--advisor` dot
  + "Advisor needs a decision"; right side a **countdown pill** (clock icon + `mm:ss` in Geist
  Mono) that **decrements once per second**, starting around `0:48`. Body: the question.
  Two buttons: **"RCTs only"** (solid `--advisor`) and **"Include OLE"** (ghost). Footer:
  "Defaults to RCTs only if it expires." A 3px **depletion bar** along the bottom animates from
  100%→0% over the countdown window.
- **Answered:** clicking a choice swaps the card to a calm confirmation (green hairline border,
  white bg, check glyph, "You chose: <label>"). The status bar's "1 question pending" flips to a
  resolved state.
- **Expired:** if the countdown hits 0 with no answer, the card swaps to a neutral "Expired —
  defaulted to RCTs only" state (`--soft` bg, `--ink-3` clock glyph). Default = the primary
  option.
- Respect `prefers-reduced-motion` (the prototype disables the depletion animation; keep the
  state logic).

### Slash command menu (screen 2)
- Typing `/` at the editing line opens a **popover at the caret** (`--chrome`, `1px --line`,
  radius 12, `--shadow-pop`, width 400). Header "COMMANDS"; rows for
  `/cite`, `/write`, `/research`, `/figure`, `/review`, `/ask`, `/status` — each row = a 28px
  rounded square avatar tinted with the **owning agent's color** + white initials, the command
  name (Geist Mono), its `<arg>` placeholder (mono `--ink-3`), and a one-line description.
- **Filtering:** the menu filters as the user types (`/wr` → `/write`). **Keyboard:** ↑/↓ move
  the highlighted row (`--soft-2` bg), **Enter** runs it, **Esc** clears. The menu is fully
  keyboard-driven (a11y requirement). Highlight follows hover too.

### `/write` — streamed suggestion with accept/reject (screen 2)
- Selecting `/write` inserts a **suggestion block** in-flow: a `--writer` left spine + "WRITER ·
  SUGGESTED EDIT" eyebrow with a pulsing dot. The suggested sentence **streams in character by
  character** with a blinking `--writer` caret (≈22ms/step in the proto).
- When streaming completes, an action row appears: **Accept** (solid `--accent`, check icon) and
  **Reject** (ghost), plus a muted note "Writer drafted from §2 context".
- **Accept** → the text merges into the document as a normal serif paragraph (gentle
  fade-and-rise entrance, ~0.3s, `--ease`) and a **toast** confirms ("Suggestion accepted").
- **Reject** → the block is removed, editor returns to idle.

### `/cite` — inline search → citation chip (screen 2)
- Selecting `/cite` shows a brief "Research is searching PubMed…" inline loader (ring spinner,
  `--ra`), then inserts a **citation chip** into a new sentence and fires a toast
  ("Citation inserted · references.bib updated"). Chip style is the canonical inline element
  below.
- Other commands (`/research`, `/figure`, `/review`, `/ask`, `/status`) route to the owning
  agent and fire a "Routed to <Agent>" toast in the proto (stub — wire to real dispatch).

### Citation chip (canonical inline element)
- `display:inline-flex; align-items:baseline; white-space:nowrap`, Geist (UI font, **not** the
  serif body), 13px, color `--accent`, background `--accent-soft`, padding `1px 7px`, radius 5,
  `margin: 0 2px`. Renders an author-year label (the source markdown is `[@goodwin2022]`).

### Toasts
- Bottom-center of the editor, `--ink` bg, white text, radius 10, `--shadow-pop`, a small
  `--good` dot, fade-and-rise in; auto-dismiss ~2.6s.

### Streaming / active-agent treatment (chat + doc)
- The **one** active agent at a time gets color: 2–2.5px left spine in its role color, role-color
  avatar fill (white initials), role-color name, a "working/streaming" dot (pulsing), and a
  blinking caret block at the end of the streaming text. Everything else stays neutral ink.

### Session continuity
- Chat transcripts begin with a centered mono "HH:MM · session restored" divider. Long jobs
  re-attach to in-progress pipeline stages on reload.

---

## State Management (what the app needs to track)
- **Seeding:** stage list `[{id, label, owner, status: done|running|queued, substatus}]`,
  overall progress %, and a derived "N of M" + ETA.
- **Agent question:** `{status: pending|answered|expired, secondsRemaining, choice, defaultChoice}`
  with a 1Hz tick that flips pending→expired at 0 and sets `choice = defaultChoice`.
- **Editor command state:** `{ inputText, menuOpen, menuIndex, mode: idle|writing|suggestion|citing,
  revealedChars, acceptedParagraphs[], insertedChips[], toast }`.
- **Active agent** (single id) drives all role-color application in chat and the doc.
- **Save state:** `saving | saved`, token count, files list with per-file
  `status: new|modified|generated|ingesting|done` and an `originAgent` (drives icon color).

---

## Design Tokens
Lift `kuhn-tokens.css` **verbatim** — it is the source of truth and is structured for a
follow-on dark mode (re-declare the same names under `[data-theme="dark"]`). Summary:

**Surfaces:** `--bg #E8EBED` · `--chrome #FFFFFF` · `--soft #F5F7F8` · `--soft-2 #EEF1F3` ·
`--paper #FFFFFF`
**Ink:** `--ink #1B1E24` · `--ink-2 #586069` · `--ink-3 #8A909A` · `--ink-inv #FFFFFF` ·
`--doc-ink #26292F`
**Accent (single cool blue):** `--accent #2F5BB7` · `--accent-deep #234A99` ·
`--accent-soft #E7EDF9` · `--accent-line #C7D6F0`
**Lines:** `--line rgba(20,22,28,.11)` · `--line-2 rgba(20,22,28,.06)` ·
`--line-strong rgba(20,22,28,.20)`
**Agent identities** (color + `-soft`), used only when active:
`--pm #3E63A8` · `--writer #7A5AA6` · `--ra #2E8C84` · `--advisor #B07D2E` ·
`--reviewer #B0524E` · `--analyst #3E8A5B`
**Semantic:** `--good #2E7A55` · `--warn #A94A36` (+ `-soft` tints)
**Radii:** `--r-xs 6` · `--r-sm 8` · `--r 11` · `--r-lg 14` · `--r-xl 18` · `--r-pill 999`
**Spacing (4px ramp):** `--s-1 4` … `--s-12 48`
**Elevation:** `--shadow-card` (hairline) · `--shadow-pop` (menus/toasts) · `--shadow-doc` (cards)
**Focus:** `--focus-ring 0 0 0 3px rgba(47,91,183,.35)` — visible focus is required (WCAG AA).
**Type families:** `--font-ui Geist` · `--font-doc "Source Serif 4"` · `--font-mono "Geist Mono"`
**UI scale:** `--ui-h1` 20/1.3 600 · `--ui-h2` 16 · `--ui-title` 14 · `--ui-body` 13.5/1.55 ·
`--ui-small` 12 · `--ui-eyebrow` 11 uppercase .08em · `--ui-mono` 11
**Document scale:** `--doc-h1` 34/1.18 · `--doc-h2` 21 · `--doc-h3` 17 · `--doc-body` 17/1.65 ·
`--doc-small` 14 · `--doc-meta` 11 mono uppercase · **`--doc-measure 660px`**
**Motion:** `--ease cubic-bezier(.2,.7,.3,1)` · `--dur-fast .12s` · `--dur .22s`

## Assets
- **Fonts (Google Fonts):** Geist (300–700), Geist Mono (400–500), Source Serif 4 (400–600).
  Import link is at the top of every prototype and in the comment block of `kuhn-tokens.css`.
- **Icons:** inline SVG line icons (24×24, 1.6px stroke, round joins, `fill:none`,
  `currentColor`) — drawn directly in the markup; no icon library. Reuse a single set in the app.
- **Logo:** a simple wordmark treatment only (the ink square + "Kuhn"). No bespoke logo asset.
- No raster images.

## Screenshots
PNG references of every screen are in `screenshots/` (rendered at 1440-wide, hi-fi):
- `01-workspace-seeding.png` — workspace during seeding (pipeline, streaming Research, pending question).
- `02-workspace-steady.png` — steady-state editing (chat idle, files populated, Reviewer report card).
- `03-editor-slash-menu.png` — the slash command menu open at the caret (agent-colored command rows).
- `04-empty-new-project.png` — empty / new-project state.
- `05-foundations-spec.png` — the full foundations spec (color, agent identities, type, spacing, radii, states).

## Files in this bundle
- `kuhn-tokens.css` — **the token sheet; lift verbatim.**
- `Kuhn Workspace - Column.dc.html` — workspace during seeding (interactive agent question).
- `Kuhn Workspace - Steady State.dc.html` — steady-state editing (slash menu, /write, /cite).
- `Kuhn Empty State.dc.html` — empty / new-project state.
- `Kuhn Foundations.dc.html` — the visible foundations spec (swatches, scales, states).

> To view a prototype: open any `.dc.html` in a browser. Ignore the `support.js` runtime
> reference and the `<x-dc>` / `data-props` wrappers — they only power the interactive preview.
