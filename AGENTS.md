# CLAUDE.md

Guidance for Claude Code (and human contributors) **working on the Kuhn codebase**.
For what the product *is* and how to use it, see [README.md](README.md) and
[docs/architecture.md](docs/architecture.md) — don't duplicate that here.

> `CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md`.

## Repository layout

This is a monorepo of two independently-installed Node packages plus supporting
content. The root `package.json` is a **dev-only orchestrator** (a `dev` script that
runs both apps via `concurrently`, and a `postinstall` that installs both packages) —
it holds no app code and publishes nothing. Each package is still installed and run
independently, so `npm` commands (`test`, `build`, `db:seed`, …) run **inside each
package**; only `npm install` and `npm run dev` are meaningful at the root.

```
kuhn/
├── agent-backend/   # Node.js service: agent runtime, REST + WebSocket, SQLite, Yjs, render/export
├── webapp/          # Browser app (Vite + TypeScript): chat, Milkdown/Crepe editor, file manager
├── docs/            # architecture.md, deployment.md, data-pipeline.md, design/
└── guidance-docs/   # Curated reference corpus (regulatory guidance, etc.), by project type — content, not wired into the app
```

Agent definitions (system prompts, models, tools) are **DB-seeded** from
`agent-backend/src/db/prompts/*.md` + `seed-data.js` — see "Agent prompts" below.

## Running the apps

Both run locally; the webapp talks to the backend over REST + WebSocket.

### Backend (`agent-backend/`) — port 3002

```bash
cd agent-backend
npm install            # first run
npm run dev            # node --watch src/index.js
```

The database is **in-process SQLite** — no service to run. On startup it creates
the DB file, applies the schema, and seeds agents/tools. Health:
http://localhost:3002/health

- `npm test` / `npm run test:watch` — vitest
- `npm run db:seed` — re-seed agents & tools (run after editing prompts/seed data)
- `npm run smoke` — research smoke test (uses real model quota)

The backend also serves `webapp/dist` at `/` whenever that build exists
(single-port deployment — see `docs/deployment.md`; disable with
`KUHN_WEBAPP_DIST=''`). Production webapp builds call the API on their own
origin; dev builds default to `http://localhost:3002`.

Needs `ANTHROPIC_API_KEY` in `agent-backend/.env`. The SQLite DB and uploaded
project files both live under an explicit data directory, `KUHN_DATA_DIR`
(default: repo-root `./data`, gitignored) — `data/db/kuhn.sqlite` and
`data/files/<projectId>/`. Override the DB path alone with `KUHN_SQLITE_PATH`,
or the file root with `PROJECTS_ROOT`. Render/export shell out to **sandboxed**
Typst/Pandoc Docker images
(`docker pull ghcr.io/typst/typst:latest pandoc/core:latest minidocks/poppler:latest` — poppler powers org-library PDF ingestion, story 006-002).

**The local data directory is disposable.** There is no production data in a
dev checkout: every project under `data/` is a test project. Delete
`data/db/kuhn.sqlite` and `data/files/` whenever it is convenient — the backend
reapplies `schema.sql` and re-seeds agents/tools on startup — and create,
modify or delete projects freely. The token-free check scripts write into
`projects[0]` by design (override with `PROJECT_ID`); that needs no permission
and no warning. They still purge their own fixtures, only so that repeated runs
stay readable.

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
- `db/` + `db.js` — SQLite access (better-sqlite3; `db.js` keeps a `$1`-placeholder, `{rows}`-returning shim): `schema.sql` (DDL), `prompts/*.md` + `seed-data.js` (agent/tool/reference seed data), `seed.js` (applies it), `init.js` (startup: schema → seed), `references.js` (per-project reference store + .bib export)
- `storage.js` — project-scoped file API (**enforces the project root — all file access goes through here**)
- `sandbox.js` — sandboxed subprocess execution; `render.js` — markdown → Typst → PDF, Pandoc export
- `yjs-websocket.js` / `yjs-signaling.js` — real-time collab servers
- `*.test.js` — colocated vitest tests

**`webapp/src/`** — flat TS modules, one concern each: `main.ts` (entry), `chat.ts`,
`editor.ts` (Milkdown/Crepe), `files.ts`, `project-browser.ts`, `preview.ts`,
`api.ts` (backend client), `citation.ts`/`cite-picker.ts`/`bib.ts` (`/cite`),
`seeding.ts`, plus `style.css` / `kuhn-tokens.css` for the design system.

## Agent prompts (`db/prompts/` + `db/seed-data.js`)

The six agents (pm, writer, ra, advisor, reviewer, analyst) have their system
prompts in **`agent-backend/src/db/prompts/<slug>.md`** (plain markdown, no
escaping). Their names/models, the tool definitions, the agent→tool matrix, and
the default-tenant rows live in **`db/seed-data.js`**. `seed.js` applies both via
idempotent parameterized upserts; `init.js` runs it at startup (after
`schema.sql`) and `npm run db:seed` re-applies it. The runtime loads prompts
from the `agents` table.

- **To change a prompt: edit `db/prompts/<slug>.md`, then `npm run db:seed`.**
- **To change a model, tool, or assignment: edit `db/seed-data.js`, then `npm run db:seed`.**

(Historical note: prompts lived in a top-level `agents/` tree, then in a single
dollar-quoted `seed.sql`. The Postgres→SQLite move retired dollar-quoting, so
prompts returned to per-agent `.md` files — now under `db/prompts/`.)

## Stories — project-management rules

Public work is tracked via GitHub issues and PRs. The maintainers additionally keep an
epic/story planning record in `docs/epics/NNN-epic-slug/` (`index.md` + `stories/`) —
**not part of the public tree**; it lives in a private companion repository and in
maintainers' checkouts (git-excluded). If `docs/epics/` is absent in your checkout,
skip this section. Statuses: `draft`, `ready`, `in-progress`, `done`, `blocked`.
These rules are about keeping that record honest:

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
