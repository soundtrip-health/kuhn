# Story 035: Prompts instruct agents to run a script that doesn't exist

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Four of the six agent system prompts tell the agent to shell out to
`python3 scripts/read_sections.py …` — for section reads, TODO sweeps, and
citation audits. Two facts make this dead text:

1. **`scripts/read_sections.py` does not exist** anywhere in the repo.
2. **Agents have no shell tool.** The seeded tool set is `file_read`,
   `file_write`, `file_list`, `file_move`, `pubmed_search`, `arxiv_search`,
   `web_search`, `search_org_knowledge`, `ask_user`, `spawn_agent`. Nothing
   executes a command.

So these prompts spend tokens instructing agents to do something they cannot
do, and — worse — describe capabilities (section splitting, TODO listing,
citation auditing) as *available* when they are not. `pm.md` goes furthest,
walking through `python3 -m venv .venv && source .venv/bin/activate &&
pip install -r requirements.txt`, and then carries a hand-written caveat
telling the agent that those sections don't apply in the webapp — a workaround
for text that should simply be cut.

Leftovers from the CLI-workspace era, when agents ran in a repo with a shell.

## Affected

| Prompt | Dead content |
|--------|--------------|
| `pm.md` | `.venv` bootstrap; citation-audit and TODO-check commands in the checklists; the "sections that mention shell commands … apply only to the CLI workspace" caveat |
| `writer.md` | section split/assemble, section read, TODO, citation-audit command blocks |
| `reviewer.md` | section read, TODO command blocks |
| `ra.md` | citation-audit command block |

## Acceptance Criteria

- [ ] Every ```bash block invoking `read_sections.py`, and the `.venv`
      bootstrap, is gone from all four prompts.
- [ ] Each removed capability is **either** re-expressed in terms of the tools
      the agent actually has (e.g. "read the section with `file_read`") **or**
      deliberately dropped — decide per case; do not leave an implied
      capability with no mechanism behind it.
- [ ] The PM's "shell commands … apply only to the CLI workspace" caveat is
      removed along with the text it was apologizing for.
- [ ] Decide the fate of the *citation audit* and *TODO sweep* specifically —
      these are genuinely useful and currently have no tool. Either file a
      follow-up for a real tool, or state in the prompt that the agent should
      do it by reading the file. Don't let them vanish silently.
- [ ] `npm run db:seed` re-applies; `npm test` green.
- [ ] **Smoke a live PM run and a live writer run** and confirm no behavioral
      regression. (Spends model quota — this is the reason the work wasn't
      folded into story 034.)

## Notes

- Found 2026-07-13 during the story 034 preamble audit; split out because 034
  was a mechanical text strip and this is a judgment-heavy prompt rewrite that
  changes what agents are told they can do.
- Prompts are served from the `agents` table, not from disk: edit the `.md`,
  then `npm run db:seed` (a backend restart also re-seeds).
- Worth checking at the same time whether any *other* capability described in
  the prompts lacks a backing tool — this class of drift is unlikely to be
  limited to the one script.
