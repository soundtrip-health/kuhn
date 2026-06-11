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

Next: webapp scaffold (story 013), PM agent (012).

## Agent API

| Endpoint | What |
|----------|------|
| `POST /api/agent/task` | Run an agent task; body `{ role, projectId, input, context?, sessionId? }`; streams AgentEvents as SSE |
| `GET /api/agent/jobs?projectId=&status=` | List jobs, newest first |
| `POST /api/agent/jobs/:id/dispatch` | Re-dispatch a stored (e.g. interrupted) job; streams SSE |

AgentEvent types: `text`, `file_change`, `question` (reserved), `citation` (reserved),
`done` (with token usage), `error`. Events carry `agent: <role-slug>`; sub-agent progress
is forwarded into the parent stream.

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
| `CORS_ORIGIN` | `http://localhost:5173` |
| `PROJECTS_ROOT` | `agent-backend/projects` |
| `AGENT_TOKEN_BUDGET` | `250000` (input+output tokens per task, incl. sub-agents) |
| `AGENT_MAX_DISPATCH_DEPTH` | `2` |
| `AGENT_MAX_TURNS` | `50` |
| `AGENT_MODEL` | SDK default |
| `STORAGE_MAX_FILE_BYTES` | `20971520` (20 MB per file) |
| `SANDBOX_TYPST_IMAGE` / `SANDBOX_PANDOC_IMAGE` | `ghcr.io/typst/typst:latest` / `pandoc/core:latest` |
| `SANDBOX_TIMEOUT_MS` / `SANDBOX_CPUS` / `SANDBOX_MEMORY` | `60000` / `1` / `512m` |
| `SANDBOX_MAX_OUTPUT_BYTES` | `33554432` (32 MB) |
