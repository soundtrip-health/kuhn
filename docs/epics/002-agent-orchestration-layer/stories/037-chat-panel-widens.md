# Story 037: Chat panel widens and crushes the editor

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Goal

The chat panel spontaneously widens to take over most of the window, squeezing
the editor into a sliver. Reported by the PI 2026-07-13.

## Root cause — confirmed

`#chat-panel` (`webapp/src/style.css:308`) is laid out as:

```css
#chat-panel {
  flex: 0 0 380px;
  /* no min-width, no overflow */
}
```

A flex item does **not** shrink below its content's min-content width unless
`min-width: 0` says so — the default is `min-width: auto`. So the `380px` basis
is not a width, it's a *suggestion*, and any single unbreakable string in the
transcript overrides it: a PubMed URL, a long file path, a code line, a DOI.

`#files-panel` directly below it already has the fix, with a comment spelling
out the reasoning:

```css
#files-panel {
  flex: 0 0 var(--files-width, 288px);
  min-width: 0; overflow: hidden;   /* stop content from widening the column */
}
```

Chat never got it. Same class of bug as [story 028](028-question-card-collapse.md)
(question card collapsing on flex min-size) — the third time flex intrinsic
sizing has bitten this layout, which is itself worth noting.

**Measured live** (1261px window, `testproj1`): injecting one long unbreakable
token into the chat log took the panel from **380px → 905px** and the editor
pane from **588px → 63px**. Removing the token restored it.

Note this is content-triggered, not sticky — it resolves when the offending
message scrolls out of the transcript, which is why the app can look fine on a
fresh load and explains the "auto-widened itself" character of the report.

## Acceptance Criteria

- [ ] `#chat-panel` gets `min-width: 0`, so its `flex-basis` is actually
      honored and no message content can widen it.
- [ ] Long unbreakable strings in chat messages **wrap rather than being
      clipped** — `overflow-wrap: anywhere` (or `break-word`) on the message
      body. Simply adding `overflow: hidden` to the panel would fix the layout
      by hiding the URL, which is the wrong trade: the PI needs to read it.
      Fix the layout *and* keep the content legible.
- [ ] Verify with the reproduction above: a message containing a long URL /
      path / DOI leaves the panel at 380px and the editor at full width.
- [ ] Check the same trap in the other flex columns while here — the pattern
      has now bitten `question-card` (028), `files-panel` (fixed), and
      `chat-panel`. Anything with a `flex: 0 0 <basis>` and no `min-width: 0`
      is the same latent bug.

## Notes

- Two-line CSS fix; the value is mostly in the audit criterion.
- Consider a comment on `#chat-panel` mirroring the one on `#files-panel` — the
  existing comment is the reason files survived and chat didn't, so it earned
  its keep.
