# Epics

Each epic is a directory containing an `index.md` (overview) and a `stories/` subdirectory.

## Active Epics

| # | Epic | Status |
|---|------|--------|
| 001 | [Editor Foundation Research](001-editor-foundation-research/index.md) | Done (decision revised 2026-06-11: Milkdown) |
| 002 | [Agent Orchestration Layer](002-agent-orchestration-layer/index.md) | In Progress |
| 003 | [TeXlyre Citation Assistant](003-texlyre-citation-assistant/index.md) | Done (ports to Milkdown in story 016) |
| 004 | [Editor Upgrade + Project Management](004-editor-and-project-management/index.md) | Done |
| 005 | [File Activity & Project Events](005-file-activity-and-events/index.md) | Done |
| 006 | [Org Knowledge Library](006-org-knowledge-library/index.md) | Done (OCR follow-up filed as 010-006) |
| 007 | [Identity & User Memory](007-identity-and-user-memory/index.md) | In Progress (identity 001–003 done; memory 004–006 next) |
| 008 | [Trust & the Writing Loop](008-trust-and-writing-loop/index.md) | Draft — roadmap priority #1 |
| 009 | [Agent Depth & Cost Control](009-agent-depth-and-cost/index.md) | Draft — roadmap priority #2 |
| 010 | [Collaboration & Org Readiness](010-collab-and-org-readiness/index.md) | Draft — roadmap priority #3 |

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
