# Kuhn feature guide

This directory is the **user-facing feature guide** that the in-app `help` agent answers
from (issue #170). At startup the backend indexes every `*.md` file here (except this
README) into a full-text index, section by section; the help agent's `search_kuhn_guide`
tool searches it and cites the page and section it used. Nothing here is org-scoped: the
guide describes Kuhn itself, not any tenant's content.

**The guide is a maintained artifact.** A PR that adds or changes user-facing behaviour
updates the relevant page in the same PR (there is a checklist item in the pull-request
template). `agent-backend/src/db/guide.test.js` asserts that every agent, every slash
command and every front-matter key Kuhn understands is mentioned somewhere in the guide,
so a new command or key fails CI until it is documented.

## Pages

| File | Covers |
|---|---|
| `projects.md` | creating projects, the setup wizard, project browser, seeding, project types, deleting |
| `editor.md` | the rich editor, block menu, `\newpage` chips, page-break lines, `page_limits:`, `template:`, front matter, saving, live collaboration |
| `preview-export.md` | PDF preview and page map, exports (PDF, Word, LaTeX), Marp slide decks and themes, Word reference documents |
| `citations.md` | `/cite`, the cite picker, the reference store, `.bib` export, PubMed and arXiv search, reference verification |
| `comments.md` | margin comments: filing, threads, replying, resolving, agent comments, orphaned anchors |
| `agents-and-chat.md` | the agents and what each does, the agent selector, models and pins, Stop, questions, hand-off / fresh start, budget pause, reconnecting, slash commands |
| `files.md` | the file manager, project folders, uploads, moving and renaming, the active document |
| `org-admin.md` | organizations, members and roles, settings, budgets, models, promotions, knowledge library, scripts, secrets, slide themes, page-layout templates, agent prompt additions |
| `interchange.md` | personal API tokens, exporting and importing interchange bundles, working with sciwriter |
| `accounts.md` | signing in (magic link), sessions, switching organizations, super-admin |

## Page format

Every page is plain Markdown with YAML front matter:

```markdown
---
title: Human-readable page title
area: editor            # one of: projects, editor, preview, citations, comments, agents, files, org-admin, interchange, accounts
keywords: newpage, page break, page limits, template
---

# Page title

One short paragraph saying what this area is for.

## Feature name

**What it does.** One to three sentences.

**How to use it.** The exact UI path: button labels and menu names in quotes exactly as
they appear on screen ("Preview PDF", "Page break"), keyboard shortcuts, slash commands
(`/cite`) and front-matter keys (`page_limits:`) in backticks, with a minimal example
where a key takes structured input.

**Prerequisites.** What must be true first: a render must have run, the user needs the
owner role, a Docker image must be built, the backend must be restarted, a setting must be on.
Write "None." if there are none.

**Gotchas.** The non-obvious behaviour people trip over. Omit the paragraph if there is
genuinely nothing to say.
```

Rules:

- **Section granularity is what gets cited.** One `##` section per feature; the heading is
  what the help agent quotes back, so make it the name a user would use.
- **Only document what the code does.** Verify every button label, menu item, route,
  slash command and front-matter key against `webapp/src/*.ts`, `webapp/index.html` and
  `agent-backend/src/routes/*.js` before writing it. Never describe planned behaviour;
  if something is deferred, say it is not available yet.
- **Say what requires a render, a restart, or a role.** That is the class of question the
  help agent exists to answer.
- Keep pages self-contained; cross-reference other pages by file name in plain prose
  ("see `citations.md`").
- No screenshots, no emoji, no marketing language.
