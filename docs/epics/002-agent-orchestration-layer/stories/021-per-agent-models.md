# Story 021: Per-Agent Model Selection

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S
**Completed:** 2026-06-12

## Goal

Each agent role runs on a model matched to its job: premium models for planning and
complex writing, mid-tier for general analysis/review, cheap models for high-volume
literature search. Careful per-agent model selection is a key product lever for both
quality and cost.

## Design

The model lives on the `agents` table (`agents.model`, nullable), consistent with the
DB-backed-prompts decision — editable at runtime, no redeploy to retune. Resolution
order at task time (`runtime.js`): `agents.model` → `AGENT_MODEL` env (global
fallback) → SDK default. Because `dispatch_agent` sub-tasks go through `runAgentTask`
and load their own agent row, sub-agents automatically get their own model — a Haiku
RA can serve an Opus PM within one dispatch tree.

Seeded defaults (override per role at seed time with `AGENT_MODEL_<SLUG>`):

| Role | Model | Rationale |
|------|-------|-----------|
| pm | `claude-opus-4-8` | Planning, interview judgment, orchestration |
| writer | `claude-opus-4-8` | Complex scientific writing |
| ra | `claude-haiku-4-5` | High-volume literature search; also the biggest token sink in the seeding tree (see story 020 budget finding) |
| advisor | `claude-sonnet-4-6` | Domain framing, knowledge-base building |
| reviewer | `claude-sonnet-4-6` | Critical review |
| analyst | `claude-sonnet-4-6` | General analysis/coding |

Pricing context (2026-06): Haiku 4.5 $1/$5 per MTok, Sonnet 4.6 $3/$15, Opus 4.8 $5/$25.

## Acceptance Criteria

- [x] `agents.model` column (idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for
      existing databases)
- [x] Seed writes per-role models with `AGENT_MODEL_<SLUG>` env override
- [x] `runAgentTask` passes `agent.model ?? config.agent.model` to the SDK; sub-agents
      resolve their own model
- [x] Tests: per-agent model used; global fallback when the row has none
- [x] Verified on the live backend: all six roles seeded with their tier

## Notes

- One model per role. Per-task overrides (e.g. "use Opus for this one RA deep-dive")
  are not supported; revisit if a real need appears.
- Resuming an SDK session continues on whatever model the role now maps to — a seed
  retune mid-conversation switches the model on the next turn (cache miss, no error).
