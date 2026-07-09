# Kuhn Agent Backend

Node.js backend for Kuhn's AI agents. Hosts the agent runtime, in-process
SQLite prompt/conversation storage, and the Yjs signaling + WebSocket servers
used for real-time collaboration.

## Current State

- Express server with health endpoint (`/health`)
- In-process SQLite (better-sqlite3); schema applied and agents/tools seeded on startup
- Agent prompts seeded from `src/db/prompts/*.md`, plus tool/assignment/tenant data from `src/db/seed-data.js`
- Conversation logging tables
- y-webrtc signaling (`/yjs-signaling`) and y-websocket (`/yjs-websocket/:doc`) servers
- **Agent runtime on the Claude Agent SDK** (story 011): `runAgentTask(role, projectId,
  input)` boundary, per-role tool allowlists from the DB, project-dir workspaces,
  durable `jobs` table, per-task token budgets, `dispatch_agent` sub-tasks, in-process
  PubMed/arXiv search tools
- **Storage API + sandboxed execution** (story 018): every file operation —
  HTTP routes and agent tools alike — goes through `src/storage.js`, which enforces
  the project root (no `..` traversal, no absolute paths, no symlink escapes);
  Typst/Pandoc render in a locked-down container via `src/sandbox.js`

- **Webapp support** (story 013): token-level `text_delta` streaming
  (`includePartialMessages`), `GET/POST /api/projects`, Yjs doc-update broadcast,
  CORS allowlist including the webapp dev origin (`http://localhost:5174`)
- **PM agent** (story 012): `ask_user` question round trip (the agent blocks until
  `POST /api/agent/jobs/:id/reply` or a timeout), `save_project_config` →
  `projects.config` + `project.json`
- **Per-agent models** (story 021): each role runs on its DB-configured model
  (`agents.model`, seeded premium for pm/writer, mid for advisor/reviewer/analyst,
  cheap for ra; override at seed time with `AGENT_MODEL_<SLUG>`)
- **Conversation restore + weighted budgets** (story 020): conversation read API for
  transcript restore, `question_expired` events, and token budgets weighted by model
  cost relative to the root agent's tier (a Haiku sub-agent burns the budget slower
  than the Opus PM)
- **Seeding pipeline** (story 015): `POST /api/projects/:id/seed` runs PM interview →
  RA + Advisor in parallel → Writer skeleton → `pm/status.md` as a deterministic
  code pipeline (`src/agents/seeding.js`), each stage a top-level task with its own
  budget

- **Render & export** (story 019): `POST /api/projects/:id/render` (markdown → Typst →
  PDF, content-hash cached) and `GET /api/projects/:id/export?format=docx|tex`, both
  through the sandbox (`src/render.js`)

Next: `/write` (017), file manager (014), UI design implementation (025); live
seeding verification (022) deferred during hands-on testing.

## Agent API

| Endpoint | What |
|----------|------|
| `POST /api/agent/task` | Run an agent task; body `{ role, projectId, input, context?, sessionId? }`; streams AgentEvents as SSE |
| `GET /api/agent/jobs?projectId=&status=` | List jobs, newest first |
| `POST /api/agent/jobs/:id/dispatch` | Re-dispatch a stored (e.g. interrupted) job; streams SSE |
| `POST /api/agent/jobs/:id/reply` | Answer a running job's pending `ask_user` question; 409 when none is pending |
| `POST /api/projects/:id/seed` | Run the seeding pipeline (interview → research → skeleton); streams stage markers + AgentEvents as SSE |
| `GET /api/projects/:id/conversations?limit=` | Recent top-level conversations with user/assistant messages (transcript restore) |

AgentEvent types: `text_delta` (token-level streaming), `text` (full turn),
`file_change`, `question` (ask_user is waiting; reply via the reply route),
`question_expired` (the question timed out; the agent proceeds with defaults),
`stage` (seeding pipeline progress), `citation` (reserved), `done` (with token
usage), `error`. Events carry `agent: <role-slug>`; sub-agent progress is forwarded
into the parent stream.

Auth: set `ANTHROPIC_API_KEY` in `.env` (or rely on Claude Code login credentials on a dev machine).

Smoke test (needs credentials, uses real model quota): `npm run smoke`

## Files API (story 018)

All paths are project-relative; escapes (`..`, absolute paths, symlinks out of the
project root) return 403.

| Endpoint | What |
|----------|------|
| `GET /api/projects/:id/files[?path=dir]` | Project tree (symlinks omitted) |
| `GET /api/projects/:id/file?path=...` | Raw file content |
| `PUT /api/projects/:id/file?path=...` | Create/overwrite; body is the raw content |
| `DELETE /api/projects/:id/file?path=...` | Delete file or directory |
| `POST /api/projects/:id/files/move` | Body `{ from, to }` |
| `POST /api/projects/:id/files/upload` | Multipart; `files` field(s), optional `path` dir |

## Render & export (stories 018/019)

`src/sandbox.js` runs Typst/Pandoc in Docker with `--network none`, the project
mounted read-only, a separate output dir, and CPU/memory/time limits. This wrapper is
the designated path for anything that executes document-derived code (future analyst
Python included). The helpers are `renderTypstPdf(projectId, sourcePath)` and
`pandocConvert(projectId, sourcePath, outName, extraArgs?)`.

On top of them, `src/render.js` (story 019) serves:

| Endpoint | What |
|----------|------|
| `POST /api/projects/:id/render` | Body `{ path }`; markdown → Typst (Pandoc, citeproc when `references.bib` sits next to the source) → PDF bytes; content-hash cached (`X-Render-Cache: hit\|miss`) |
| `GET /api/projects/:id/export?path=...&format=docx\|tex` | Pandoc export, attachment download |

Errors are readable, not 500s: compile failure → 422 with the stderr excerpt,
timeout → 504, oversized output → 413, missing source → 404.

Images: `ghcr.io/typst/typst:latest`, `pandoc/core:latest` (pull once with `docker pull`).
On macOS, keep `PROJECTS_ROOT` somewhere Docker Desktop can bind-mount (the default,
inside the repo, is fine; `/tmp` is not).

## Quick Start

```bash
# Configure credentials (first time): copy the template and set ANTHROPIC_API_KEY
cp .env.example .env

# Install deps (first time)
npm install

# Start the backend (port 3002)
npm run dev
```

The database is in-process SQLite — no service to start. On startup the backend
creates the DB file under the data dir, applies the schema, and seeds
agents/tools/assignments. Health check: http://localhost:3002/health

## Commands

| Command | What |
|---------|------|
| `npm run dev` | Start dev server with watch mode (port 3002) |
| `npm start` | Start server |
| `npm run db:seed` | Re-seed agent prompts (`src/db/prompts/*.md`) and tool/assignment data (`src/db/seed-data.js`) |
| `npm test` | Run tests |

## Configuration

Environment variables (see `src/config.js`; `.env` supported):

| Var | Default |
|-----|---------|
| `ANTHROPIC_API_KEY` | — (required unless using Claude Code login credentials) |
| `PORT` | `3002` |
| `CORS_ORIGIN` | `http://localhost:5173,http://localhost:5174` |
| `KUHN_DATA_DIR` | repo-root `./data` (holds `db/kuhn.sqlite` + `files/<projectId>/`) |
| `KUHN_SQLITE_PATH` | `<KUHN_DATA_DIR>/db/kuhn.sqlite` (override the DB file alone) |
| `PROJECTS_ROOT` | `<KUHN_DATA_DIR>/files` (override the project-files root alone) |
| `AGENT_TOKEN_BUDGET` | `2500000` (per task incl. sub-agents, weighted by model cost relative to the root agent's tier) |
| `AGENT_TOKEN_BUDGET_GRACE` | `1.1` (in-flight task may run to `grace×` the budget before interruption) |
| `AGENT_MODEL_WEIGHTS` | `haiku:1,sonnet:3,opus:5,default:5` (approximate price ratios for budget weighting) |
| `AGENT_QUESTION_TIMEOUT_MS` | `900000` (15 min for an `ask_user` reply, then the agent proceeds with defaults) |
| `AGENT_MAX_DISPATCH_DEPTH` | `2` |
| `AGENT_MAX_TURNS` | `50` |
| `AGENT_MODEL` | SDK default (global fallback; `agents.model` per role wins, `AGENT_MODEL_<SLUG>` overrides at seed time) |
| `AGENT_RETRY_MAX_ATTEMPTS` / `AGENT_RETRY_BASE_MS` / `AGENT_RETRY_MAX_MS` | `5` / `1500` / `30000` (transient model-provider error backoff, story 029) |
| `STORAGE_MAX_FILE_BYTES` | `20971520` (20 MB per file) |
| `SANDBOX_TYPST_IMAGE` / `SANDBOX_PANDOC_IMAGE` | `ghcr.io/typst/typst:latest` / `pandoc/core:latest` |
| `SANDBOX_TIMEOUT_MS` / `SANDBOX_CPUS` / `SANDBOX_MEMORY` | `60000` / `1` / `512m` |
| `SANDBOX_MAX_OUTPUT_BYTES` | `33554432` (32 MB) |
