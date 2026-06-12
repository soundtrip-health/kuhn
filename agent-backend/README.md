# Kuhn Agent Backend

Node.js backend for Kuhn's AI agents. Hosts the agent runtime, Postgres-backed
prompt/conversation storage, and the Yjs signaling + WebSocket servers used for
real-time collaboration.

## Current State

- Express server with health endpoint (`/health`)
- Postgres (pgvector) via docker-compose; schema auto-created on startup
- Agent prompts and tool definitions seeded from `agents/*/AGENTS.md`
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

Next: live seeding verification (022), file manager (014), slash commands (016),
render/export endpoints (019).

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

Auth: set `ANTHROPIC_API_KEY` (or rely on Claude Code login credentials on a dev machine).

Smoke test (needs Postgres + credentials): `npm run smoke`

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

## Sandboxed rendering (story 018)

`src/sandbox.js` runs Typst/Pandoc in Docker with `--network none`, the project
mounted read-only, a separate output dir, and CPU/memory/time limits. This wrapper is
the designated path for anything that executes document-derived code (future analyst
Python included). Render endpoints land with story 019; the helpers are
`renderTypstPdf(projectId, sourcePath)` and `pandocConvert(projectId, sourcePath, outName)`.

Images: `ghcr.io/typst/typst:latest`, `pandoc/core:latest` (pull once with `docker pull`).
On macOS, keep `PROJECTS_ROOT` somewhere Docker Desktop can bind-mount (the default,
inside the repo, is fine; `/tmp` is not).

## Quick Start

```bash
# Start Postgres (first time or after reboot)
docker compose up -d

# Install deps (first time)
npm install

# Start the backend (port 3002)
npm run dev
```

Health check: http://localhost:3002/health

## Commands

| Command | What |
|---------|------|
| `npm run dev` | Start dev server with watch mode (port 3002) |
| `npm start` | Start server |
| `npm run db:seed` | Re-seed agent prompts and tools from `agents/*/AGENTS.md` |
| `npm test` | Run tests |
| `docker compose up -d` / `down` | Start/stop Postgres |

## Configuration

Environment variables (see `src/config.js`; `.env` supported):

| Var | Default |
|-----|---------|
| `PORT` | `3002` |
| `PGHOST` / `PGPORT` | `localhost` / `5432` |
| `PGDATABASE` / `PGUSER` / `PGPASSWORD` | `kuhn` / `kuhn` / `kuhn_dev` |
| `CORS_ORIGIN` | `http://localhost:5173,http://localhost:5174` |
| `PROJECTS_ROOT` | `agent-backend/projects` |
| `AGENT_TOKEN_BUDGET` | `500000` (per task incl. sub-agents, weighted by model cost relative to the root agent's tier) |
| `AGENT_MODEL_WEIGHTS` | `haiku:1,sonnet:3,opus:5,default:5` (approximate price ratios for budget weighting) |
| `AGENT_QUESTION_TIMEOUT_MS` | `900000` (15 min for an `ask_user` reply, then the agent proceeds with defaults) |
| `AGENT_MAX_DISPATCH_DEPTH` | `2` |
| `AGENT_MAX_TURNS` | `50` |
| `AGENT_MODEL` | SDK default (global fallback; `agents.model` per role wins, `AGENT_MODEL_<SLUG>` overrides at seed time) |
| `STORAGE_MAX_FILE_BYTES` | `20971520` (20 MB per file) |
| `SANDBOX_TYPST_IMAGE` / `SANDBOX_PANDOC_IMAGE` | `ghcr.io/typst/typst:latest` / `pandoc/core:latest` |
| `SANDBOX_TIMEOUT_MS` / `SANDBOX_CPUS` / `SANDBOX_MEMORY` | `60000` / `1` / `512m` |
| `SANDBOX_MAX_OUTPUT_BYTES` | `33554432` (32 MB) |
