# Story 009: Backend Scaffold

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Stand up the Node.js agent backend with Docker-based Postgres+pgvector, Yjs signaling
and WebSocket servers, and a health check endpoint. This is the foundation that all
subsequent stories build on.

## Acceptance Criteria

- [x] Node.js + Express server starts and serves a health check at `GET /health`
- [x] `docker-compose.yml` starts Postgres 16 with pgvector extension
- [x] DB connection pool connects to Postgres; health check reports DB status
- [x] y-webrtc signaling server accepts WebSocket connections and relays messages between peers in the same room
- [x] y-websocket server accepts WebSocket connections and syncs Yjs documents
- [x] TeXlyre local dev config updated to point to the new backend for collab
- [x] `npm run dev` starts the server with file watching

## Technical Notes

- Backend lives in `agent-backend/` at the repo root
- Single HTTP server on port 3002; WebSocket upgrade routes:
  - `/yjs-signaling` — y-webrtc signaling relay (JSON protocol)
  - `/yjs-websocket/<roomName>` — y-websocket document sync (binary Yjs protocol)
- Postgres on default port 5432 via Docker
- CORS allows `http://localhost:5173` (texlyre dev server)

## Out of Scope

- Database schema (Story 010)
- Agent routing / LLM integration (Story 011)
- File storage API (Story 014)
- Authentication (deferred from prototype)
