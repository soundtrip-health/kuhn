# Story 037: Chat panel widens and crushes the editor

**Status:** done
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

- [x] `#chat-panel` gets `min-width: 0`, so its `flex-basis` is actually
      honored and no message content can widen it.
- [x] Long unbreakable strings in chat messages **wrap rather than being
      clipped**. `.chat-body` already carried `overflow-wrap: break-word` —
      and that was *not enough*, which is the real lesson here: per spec
      `break-word` does not reduce an element's **min-content size**, so the
      long word still forced the panel wide even though it would have wrapped
      once the panel was sized. Only **`overflow-wrap: anywhere`** shrinks
      min-content. Changed to `anywhere`.
      (Deliberately *not* `overflow: hidden` on the panel: that would fix the
      layout by clipping the URL out of sight, and the PI needs to read it.)
- [x] Verified live in the running app against the real `.chat-body` markup:
      | | chat panel | editor pane |
      |---|---|---|
      | long URL, before fix | **692px** | 276px |
      | long URL, after fix | **380px** | **588px** |
      URL wraps across lines and stays fully visible. `npm run build`
      (tsc + vite) clean.
- [x] Audited the other `flex: 0 0` rules. **No further instances**: the rest
      are row items in a column container (`#topbar`, `#editor-subheader`,
      `#files-header`, `#statusbar` — their basis is a *height*, so `min-width`
      is irrelevant), the 5px `.pane-resizer`, or fixed-size icons with short
      content (`.chat-avatar`, `.stage-icon`). `#files-panel` was already
      fixed; `#chat-panel` was the last real one.

## Notes

- Fixed 2026-07-13, same session it was reported.
- The `#files-panel` comment is why that panel survived and chat didn't, so
  `#chat-panel` now carries a matching one — including the `anywhere`-vs-
  `break-word` distinction, which is the non-obvious half and the thing most
  likely to be "cleaned up" back into a bug by someone tidying the CSS.
