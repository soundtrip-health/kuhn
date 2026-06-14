# Story 028: Question Card Collapses to a Sliver During Seeding

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S
**Completed:** 2026-06-14

## Goal

Fix the ask_user question card rendering as an invisible ~15px sliver during the
seeding interview, so the user can actually see and answer PM questions.

## Symptom

In the "Start project interview" (seeding) flow, the PM would say "Let me ask
the first question," the input would flip to answer mode ("Type your answer…",
"PM is waiting for your answer…"), but **no question card was visible**. The card
was in the DOM with full content and `display:block; visibility:visible;
opacity:1` — its rendered height was just **15px** with the rest clipped.

This is almost certainly what originated the older "my question may not be
showing up on your end" reports: the card was invisible during the interview, so
the question went unanswered, timed out, and the PM re-asked it as plain text
(which then persisted in the transcript). [Story 027](027-reconnect-pending-question.md)
hardened the reconnect path; this story fixes the actual rendering bug.

## Root cause

`#chat-log` is a flex column (`display:flex; flex-direction:column`,
`webapp/src/style.css`). In flexbox, a flex item with `overflow` other than
`visible` gets an **automatic minimum size of 0** — and `.question-card` has
`overflow:hidden` (for its rounded corners + depletion bar). When the seeding
panel is shown it shrinks `#chat-log`'s available height, so the card — uniquely
collapsible because of that `overflow:hidden` — was squeezed to a sliver while
the normal text bubbles (no `overflow:hidden`) kept their content height. In
plain chat (no seeding panel) the log had room, so the card rendered — which is
why it only reproduced in the seeding interview.

## Fix

`webapp/src/style.css`:
- `.question-card { … flex-shrink: 0; }` — the card keeps its natural height and
  `#chat-log` scrolls instead of compressing it.
- `.qc-question { … white-space: pre-wrap; }` — preserve the agent's line breaks
  so a multi-line question (e.g. a numbered options list) renders as a list
  instead of one run-on paragraph.

## Verification

Drove the seeding interview in the real webapp: the card now renders at full
height (~250–300px) with the question and its numbered options, the countdown,
and the answer hint — no console errors. (CSS-only change; no test harness for
computed layout, verified via browser screenshot + DOM measurement.)

## Out of Scope

- Rendering markdown inside the question card (the card intentionally shows
  escaped plain text; the PM occasionally emits `**bold**`, which shows
  literally — minor, left as-is).
