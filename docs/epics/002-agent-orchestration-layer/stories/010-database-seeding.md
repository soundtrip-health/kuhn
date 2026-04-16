# Story 010: Database Schema + Seeding

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Create the Postgres schema for the agent backend, seed agent prompts and tool
definitions from existing AGENTS.md files, and provide a conversation logging
module for subsequent stories to use.

## Acceptance Criteria

- [x] `schema.sql` defines tables: `agents`, `tools`, `agent_tools`, `projects`, `conversations`, `messages`
- [x] pgvector extension enabled (`CREATE EXTENSION IF NOT EXISTS vector`)
- [x] All DDL is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
- [x] `seed.js` reads all 6 `agents/*/AGENTS.md` files and upserts agent rows (slug, name, description, system_prompt)
- [x] `seed.js` upserts 7 tool definitions with JSON Schema parameter specs
- [x] `seed.js` populates `agent_tools` with the correct assignment matrix (20 rows)
- [x] Seed is idempotent — re-running updates existing rows, does not create duplicates
- [x] `init.js` runs extension + schema + seed; called automatically on server startup
- [x] Server starts gracefully if Postgres is unavailable (logs error, continues degraded)
- [x] `conversation.js` exports `createConversation(agentSlug, projectId?)`, `logMessage({...})`, `getHistory(conversationId, opts?)`
- [x] `npm run db:seed` re-runs seeding standalone
- [x] Restarting the server produces no errors and no duplicate data

## Technical Notes

- Schema lives in `agent-backend/src/db/schema.sql`
- Seed, init, and conversation modules in `agent-backend/src/db/`
- pgvector extension created as a separate statement (cannot run inside a transaction)
- `messages` table is append-only (no `updated_at`) — chat messages are immutable
- `conversations.agent_slug` is NOT a FK to `agents` — avoids re-seeding complications
- `projects.project_type` uses a CHECK constraint for the 5 known types

## Out of Scope

- Agent routing / LLM integration (Story 011)
- File storage API (Story 014)
- Embedding columns for semantic search (future)
- Authentication (deferred from prototype)
