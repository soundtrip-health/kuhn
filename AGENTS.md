# CLAUDE.md

Guidance for Claude Code (and human contributors) **working on the Kuhn codebase**.
For what the product *is* and how to use it, see [README.md](README.md) and
[docs/architecture.md](docs/architecture.md) — don't duplicate that here.

> `CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md`.

## Repository layout

This is a monorepo of two independently-installed Node packages plus supporting
content. There is **no root `package.json`** — run `npm` inside each package.

```
kuhn/
├── agent-backend/   # Node.js service: agent runtime, REST + WebSocket, Postgres, Yjs, render/export
├── webapp/          # Browser app (Vite + TypeScript): chat, Milkdown/Crepe editor, file manager
├── docs/            # architecture.md + epics/ (project management — see "Stories")
└── guidance-docs/   # Curated reference corpus (regulatory guidance, etc.), by project type — content, not wired into the app
```

Agent definitions (system prompts, models, tools) are **DB-seeded** from
`agent-backend/src/db/seed.sql` — see "Agent prompts" below.

## Running the apps

Both run locally; the webapp talks to the backend over REST + WebSocket.

### Backend (`agent-backend/`) — port 3002

```bash
cd agent-backend
docker compose up -d   # Postgres (first run / after reboot)
npm install            # first run
npm run dev            # node --watch src/index.js
```

On startup it ensures the DB schema and seeds agents/tools. Health: http://localhost:3002/health

- `npm test` / `npm run test:watch` — vitest
- `npm run db:seed` — re-seed agents & tools (run after editing `src/db/seed.sql`)
- `npm run smoke` — research smoke test (uses real model quota)

Needs `ANTHROPIC_API_KEY` and Postgres config in `agent-backend/.env`. Render/export
shell out to **sandboxed** Typst/Pandoc Docker images
(`docker pull ghcr.io/typst/typst:latest pandoc/core:latest`).

### Webapp (`webapp/`) — port 5174 (pinned)

```bash
cd webapp
npm install            # first run
npm run dev            # vite (backend must be running)
```

The port is pinned because the backend CORS allowlist hard-codes it. Build with
`npm run build` (`tsc && vite build` — type errors fail the build).

Token-free check scripts (drive the app without spending model quota):
`npm run smoke`, `editor-check`, `parity-check`, `smoke:chat`, `write-check`.

## Where things live

**`agent-backend/src/`**
- `index.js` — server entry (Express + ws); `config.js` — env/config
- `routes/` — REST handlers; `session.js` — agent chat sessions
- `agents/` — agent **runtime** (the `runAgentTask` boundary, Claude Agent SDK, tool dispatch, project seeding pipeline)
- `db/` + `db.js` — Postgres access: `schema.sql` (DDL), `seed.sql` (agent/tool seed data), `seed.js` (applies seed.sql), `init.js` (startup: schema → seed)
- `storage.js` — project-scoped file API (**enforces the project root — all file access goes through here**)
- `sandbox.js` — sandboxed subprocess execution; `render.js` — markdown → Typst → PDF, Pandoc export
- `yjs-websocket.js` / `yjs-signaling.js` — real-time collab servers
- `*.test.js` — colocated vitest tests

**`webapp/src/`** — flat TS modules, one concern each: `main.ts` (entry), `chat.ts`,
`editor.ts` (Milkdown/Crepe), `files.ts`, `project-browser.ts`, `preview.ts`,
`api.ts` (backend client), `citation.ts`/`cite-picker.ts`/`bib.ts` (`/cite`),
`seeding.ts`, plus `style.css` / `kuhn-tokens.css` for the design system.

## Agent prompts (`db/seed.sql`)

The six agents (pm, writer, ra, advisor, reviewer, analyst), their tools, and the
agent→tool matrix all live in **`agent-backend/src/db/seed.sql`** — the single
canonical source. `init.js` runs it at startup (after `schema.sql`) and
`npm run db:seed` re-applies it; every statement is an idempotent upsert. The
runtime then loads prompts from the Postgres `agents` table.

- **To change a prompt, model, or tool assignment: edit `seed.sql`, then `npm run db:seed`.**
- System prompts are dollar-quoted (`$kuhn$ … $kuhn$`) so markdown apostrophes/quotes need no escaping.
- Per-agent `model` values are columns in the `agents` INSERT — change them there.

(Historical note: prompts used to be markdown files under a top-level `agents/`
directory read by `seed.js`. That tree — including orphaned CLI-era analyst
scripts and a `guidance/` corpus — was removed; prompts now live only in `seed.sql`.)

## Stories — project-management rules

Epics and stories live in `docs/epics/NNN-epic-slug/` (`index.md` + `stories/`).
Statuses: `draft`, `ready`, `in-progress`, `done`, `blocked`. These rules are about
keeping that record honest:

1. **A `done` story is read-only** — historical record, never the home for open work.
2. **Every known issue has an owning open story** — self-contained enough to act on without reading back into the done story.
3. **Done stories use forward pointers**, not issue detail (e.g. "Deferred to Story 009"); the open story owns the full description.
4. **Marking a story `done` requires an issue audit** — acceptance criteria met or explicitly deferred with a forward reference; every known issue has a receiving open story listed in the epic table.

## Conventions

- **Match the surrounding code** — both apps are plain ESM; the webapp is dependency-light TS with no framework. Keep modules small and single-purpose.
- **All project file access goes through `storage.js`** — never read/write a project path directly; the project-root enforcement is a tenancy-safety invariant.
- **Sandboxed execution only** for render/export — go through `sandbox.js`.
- **Tests are colocated** (`*.test.js`) and run with vitest.

## Claude Code permissions

`.claude/settings.json` (committed) pre-allows low-risk read-only and build commands
(git read ops, `npm test`/`build`/`lint`, `node`, `python3`, `grep`/`rg`, file tools)
so Claude Code can iterate without prompting. Add personal allowances in
`~/.claude/settings.json` (never committed). Toggle modes with `/permissions`.
