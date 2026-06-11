# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kuhn is a web-based scientific and technical writing tool with integrated AI agents. It provides a browser-based WYSIWYG markdown editor (Milkdown) with real-time AI assistance — slash commands for inserting references, quick research, generating figures via Python, and more. Documents render to PDF via Typst and export to docx/LaTeX via Pandoc.

The AI agents (in `agents/`) provide the intelligence layer: writing, research, analysis, review, domain advising, and project management. See `agents/CLAUDE.md` for agent-specific conventions.

## Repository Layout

```
kuhn/
├── agents/          # AI agent workspaces (writer, analyst, advisor, research, review, pm)
├── docs/            # Project documentation
│   ├── epics/       # Project management — each epic has index.md + stories/
│   └── architecture.md
├── agent-backend/   # Node.js backend: agent runtime, Postgres, Yjs servers
├── texlyre/         # Retired TeXlyre fork — reference only (/cite implementation, Epic 003)
└── CLAUDE.md        # This file (symlink to AGENTS.md)
```

## Document Formats

- **Canonical authoring format:** Markdown (Pandoc/Quarto flavor) with BibTeX bibliographies
- **Rendering:** Typst (markdown → Typst → PDF)
- **Exports:** docx (Pandoc), LaTeX, HTML — LaTeX is an export target, not an authoring surface
- Decision record: [docs/architecture.md](docs/architecture.md) (revised 2026-06-11)

## Project Management

Epics and stories live in `docs/epics/`. Each epic is a directory:

```
docs/epics/NNN-epic-slug/
├── index.md          # Epic overview, goals, acceptance criteria, status
└── stories/
    ├── 001-story-slug.md
    ├── 002-story-slug.md
    └── ...
```

Epic and story statuses: `draft`, `ready`, `in-progress`, `done`, `blocked`.

### Story lifecycle rules

1. **A "done" story is read-only.** Once marked `done`, its content is historical record. It must not be the canonical location for open work items.

2. **Every known issue must have an owning open story.** When completing a story that has unresolved issues, each issue must be captured in an existing open story (or a new one created for it). The receiving story must be self-contained — someone should be able to act on it without reading back into the done story.

3. **Done stories use forward pointers, not detailed issue descriptions.** The "Known Issues" section of a done story should contain only a one-line summary and a forward reference (e.g., "Deferred to Story 009") for each item. The open story owns the full description, context, and acceptance criteria.

4. **Marking a story done requires an issue audit.** Before changing status to `done`, verify:
   - All acceptance criteria are met, or unmet criteria are explicitly deferred with a forward reference
   - Every known issue has a receiving open story listed in the epic's story table
   - The receiving stories are self-contained and actionable

## Key Commands

```bash
# Run tests (once src/ exists)
npm test              # or yarn test, depending on chosen stack

# Dev server (once src/ exists)
npm run dev
```

## Working with Claude Code — Developer Guidance

### Allowing autonomous operation

Claude Code asks permission before running shell commands. For faster iteration, you
can pre-allow low-risk commands so Claude doesn't have to pause and ask. There are
two layers of configuration:

#### 1. Project-level settings (`.claude/settings.json`)

This file is checked into the repo. It applies to everyone who clones it. The
`allowedTools` array uses glob patterns to whitelist specific commands:

```jsonc
// .claude/settings.json
{
  "permissions": {
    "allowedTools": [
      "Bash(git status)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git branch*)",
      "Bash(git show*)",
      "Bash(ls*)",
      "Bash(cat*)",
      "Bash(head*)",
      "Bash(tail*)",
      "Bash(wc*)",
      "Bash(find*)",
      "Bash(which*)",
      "Bash(echo*)",
      "Bash(pwd)",
      "Bash(npm test*)",
      "Bash(npm run lint*)",
      "Bash(npm run build*)",
      "Bash(npx tsc*)",
      "Bash(node*)",
      "Bash(python3*)",
      "Bash(pip list*)",
      "Bash(grep*)",
      "Bash(rg*)",
      "Bash(cargo check*)",
      "Bash(cargo test*)",
      "Bash(cargo clippy*)",
      "Bash(make*)",
      "Edit",
      "Write",
      "Read",
      "Glob",
      "Grep"
    ]
  }
}
```

The patterns use prefix matching — `Bash(git diff*)` allows `git diff`,
`git diff --staged`, `git diff HEAD~3`, etc. This lets Claude run read-only
git commands, build tools, tests, and linters without prompting.

#### 2. User-level settings (`~/.claude/settings.json`)

Same format, but applies to all your projects. Good for personal preferences
that shouldn't be committed (e.g., allowing `docker` commands if you always
use Docker). This file is never committed.

#### 3. Slash-command permission mode

Type `/permissions` in Claude Code to interactively toggle permission mode
between `default` (ask for everything), `allowlisted` (use the settings
above), and `full-auto` (allow everything — use with caution).

### Tips for effective Claude Code usage

- **Let Claude read before you ask it to write.** "Read src/editor/ and then refactor the toolbar" works better than "refactor the toolbar."
- **Use `/init`** in a new repo to generate a starter CLAUDE.md.
- **CLAUDE.md files are hierarchical.** A CLAUDE.md in a subdirectory adds context for work in that subtree. The agents each have their own.
- **Use subagents for parallel work.** Claude Code can spawn background agents for independent tasks (research, testing) while continuing foreground work.
