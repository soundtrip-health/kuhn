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
| 008 | [Trust & the Writing Loop](008-trust-and-writing-loop/index.md) | In Progress — 002 version history done; roadmap priority #1 |
| 009 | [Agent Depth & Cost Control](009-agent-depth-and-cost/index.md) | Draft — roadmap priority #2 |
| 010 | [Collaboration & Org Readiness](010-collab-and-org-readiness/index.md) | Draft — roadmap priority #3 |
| 011 | [Multi-Tenant Orgs & Administration](011-multi-tenant-orgs/index.md) | Ready — issue #46; builds on 010-003 |
| 012 | [Folders & File Organization](012-folders-and-file-organization/index.md) | **In progress** — issue #47; branch `epic-012-folders` |
| 013 | [External Review via Magic Links](013-external-review/index.md) | Ready — issue #48; builds on 010-003 + 008-004 |

## Delivery plan — issues #46/#47/#48 track (2026-08-02)

The plan for epics 011–013 plus their one external prerequisite. This track
runs alongside the 2026-07 roadmap (008 → 009 → 010); it front-runs the rest
of epic 010 because #46–#48 are direct user asks.

**Phase 1 — Epic 012 (folders), no dependencies.** Order: 012-002 backend
(`moved` event + path-consumer updates) → 012-001 tree UI shipping move
against it → 012-003 verification sweep. Doing 002 first avoids shipping a
move UI that orphans comments.

> **Status 2026-08-03:** 012-002 done, 012-001 code-complete but still
> `in-progress` (its browser check has never been run). Review added 012-004
> and 012-005. Branch `epic-012-folders` is 2 commits ahead of `main`,
> unpushed, no PR. Resume instructions are in the
> [epic index](012-folders-and-file-organization/index.md#current-state--picking-this-up-fresh-2026-08-03).

**Phase 2 — Story 010-003 (roles & permissions), the keystone.** Pulled ahead
of the rest of epic 010: it defines owner/editor/viewer, the enforcement
matrix, and the message-level read-only Yjs room guard that 011 and 013 both
build on.

**Phase 3 — Epics 011 and 013 in parallel** (different surfaces, both
unblocked by 010-003):
- 011: 001 super-admin/org lifecycle → 002 invitations → 003 settings and
  004 promotion approval in either order.
- 013: 001 review links/guest sessions → 002 reviewer surface → 003 link
  management & attribution.

**Deferred from this track:** 010-005's `auth_events` table is a soft
dependency — 011/013 stories record events into it if it exists and note the
gap otherwise; land 010-005 opportunistically. The rest of epic 010
(presence, Yjs persistence, OIDC, OCR) keeps its own sequencing.

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
