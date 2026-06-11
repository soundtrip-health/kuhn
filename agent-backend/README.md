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

Next: agent runtime built on the Claude Agent SDK (Epic 002, story 011).

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
