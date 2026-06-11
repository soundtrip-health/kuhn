# Epics

Each epic is a directory containing an `index.md` (overview) and a `stories/` subdirectory.

## Active Epics

| # | Epic | Status |
|---|------|--------|
| 001 | [Editor Foundation Research](001-editor-foundation-research/index.md) | In Progress |
| 002 | [Agent Orchestration Layer](002-agent-orchestration-layer/index.md) | Draft |
| 003 | [TeXlyre Citation Assistant](003-texlyre-citation-assistant/index.md) | In Progress |

## Epic Lifecycle

1. **Draft** — being scoped, stories being written
2. **Ready** — fully scoped, stories estimated, ready to start
3. **In Progress** — active development
4. **Done** — all stories completed and accepted
5. **Blocked** — waiting on an external dependency or decision

## Story Format

Each story file follows this template:

```markdown
# Story NNN: Title

**Status:** draft | ready | in-progress | done | blocked
**Epic:** [NNN — Epic Name](../index.md)
**Estimate:** S / M / L / XL

## Goal
What this story accomplishes.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes
Any context, links, or decisions.
```
