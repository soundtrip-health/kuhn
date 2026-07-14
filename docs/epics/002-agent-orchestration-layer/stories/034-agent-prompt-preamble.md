# Story 034: Strip the stray `# CLAUDE.md` preamble from all six agent prompts

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Goal

Every one of the six agent system prompts in `agent-backend/src/db/prompts/`
(`pm`, `writer`, `ra`, `advisor`, `reviewer`, `analyst`) opens with:

```
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```

So every Kuhn agent is told, as the first thing in its system prompt, that it is
Claude Code working on a repository. It then goes on to describe the PM/writer/RA
role. This is leftover framing from when the prompts were extracted out of
`CLAUDE.md`-shaped workspace files; it has been seeded into the `agents` table
since the SQLite migration (PR #19) and is live in every agent run today.

Harmless-looking, but it is misdirection at the highest-priority position in the
prompt, and it is the kind of thing that quietly degrades role adherence.

## Acceptance Criteria

- [x] The `# CLAUDE.md` heading and the "guidance to Claude Code" line are
      removed from all six `db/prompts/*.md`; each prompt now opens with its
      role heading (`## Role: Project Manager`, etc.).
- [x] `npm run db:seed` re-applies cleanly and the `agents` rows match the
      files (verified: every seeded prompt now starts at `## Role:`).
- [x] `npm test` green — 234/234, 26 files.
- [x] **Audit** for the same class of stale CLI-workspace framing (shell
      commands, `.venv`, Python scripts, "this repository"). Done — and it
      found more than expected: four prompts instruct agents to run
      `python3 scripts/read_sections.py`, a script that **does not exist**,
      via a **shell tool the agents do not have**. That is a prompt rewrite,
      not a text strip. **Deferred to
      [Story 035](035-dead-cli-instructions-in-prompts.md)**, which owns the
      full description and the fix.
- [~] Smoke a PM and a writer run. **Not done — deliberately deferred to
      [Story 035](035-dead-cli-instructions-in-prompts.md)**, which changes
      prompt *content* and needs live runs to judge. This story removed four
      lines of boilerplate from the top of each file and changed no
      instruction; the risk of a behavioral regression from that alone did not
      justify spending model quota. If a live run later shows otherwise, that
      is a real finding — file it, don't edit this story.

## Notes

- Found on 2026-07-13 while checking whether the story 031 PM prompt had been
  seeded. Pre-existing since PR #19 — **not** a wizard regression.
- Deliberately not folded into story 031: that story is `done` and this touches
  all six prompts, not just `pm.md`.
- Each prompt now opens at `## Role:` (an H2 with no H1 above it). Left as-is:
  promoting the headings is churn with no effect on the model.
- Note for whoever picks up 035: prompts are served from the `agents` table,
  not from disk. Edit the `.md`, then `npm run db:seed` (a backend restart also
  re-seeds).
