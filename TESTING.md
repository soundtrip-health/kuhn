# Testing Checklist

Manual testing guide for Kuhn features. Newest features first.
Updated as stories are completed — check the date on each section.

---

## Agent Backend: Database + Seeding (Story 002-010, 2026-04-14)

**Setup:** `cd agent-backend && docker compose up -d && npm run dev`

- [ ] Server starts and prints "Schema applied", "Seeded 6 agents", "Seeded 7 tools", "Seeded 20 agent-tool assignments"
- [ ] `curl http://localhost:3002/health` returns `{ "status": "ok", "db": { "ok": true, ... } }`
- [ ] Verify agents in DB: `docker compose exec postgres psql -U kuhn -c "SELECT slug, name FROM agents ORDER BY slug;"` shows 6 rows (advisor, analyst, pm, ra, reviewer, writer)
- [ ] Verify tools in DB: `docker compose exec postgres psql -U kuhn -c "SELECT slug, name FROM tools ORDER BY slug;"` shows 7 rows
- [ ] Verify assignments: `docker compose exec postgres psql -U kuhn -c "SELECT count(*) FROM agent_tools;"` returns 20
- [ ] Idempotency: restart server (`npm run dev` again) — no errors, no duplicate rows
- [ ] Standalone seed: `npm run db:seed` completes without errors
- [ ] Graceful degradation: stop Postgres (`docker compose down`), start server — logs error but still listens on port 3002

## Agent Backend: Scaffold (Story 002-009, 2026-04-13)

**Setup:** `cd agent-backend && docker compose up -d && npm run dev`

- [ ] Health check: `GET http://localhost:3002/health` returns JSON with DB status and uptime
- [ ] Yjs signaling: open TeXlyre in two browser tabs with the same project — edits sync via WebRTC through `ws://localhost:3002/yjs-signaling`
- [ ] Yjs WebSocket: collaboration still works if WebRTC peer connection fails (falls back to `ws://localhost:3002/yjs-websocket/<room>`)

## TeXlyre `/cite` Command (Epic 003, 2026-04-13)

**Setup:** `cd texlyre && npm run dev`, open http://localhost:5173/texlyre/

### Basic Flow

- [ ] Create or open a LaTeX project
- [ ] Type a claim sentence, then on a new line type `/cite` and press Enter — citation modal opens
- [ ] Type `/cite smith diabetes` and press Enter — modal opens with "smith diabetes" as hints
- [ ] Search results appear from multiple providers (PubMed, OpenAlex, etc.) with source attribution
- [ ] Select a citation — `\cite{key}` is inserted in the document
- [ ] A `.bib` file is created or updated with the full reference entry
- [ ] The inserted key appears in TeXlyre's bibliography autocomplete immediately

### Typst Support

- [ ] In a Typst document, `/cite` inserts `#cite(<key>)` syntax instead of `\cite{key}`

### Provider Coverage

- [ ] PubMed results appear for biomedical queries
- [ ] OpenAlex results appear for broad academic queries
- [ ] arXiv results appear (via Semantic Scholar API)
- [ ] bioRxiv/medRxiv results appear
- [ ] PsyArXiv results appear (via Semantic Scholar API)
- [ ] IEEE Xplore results appear for engineering queries
- [ ] If a provider fails, others still return results (no full-modal crash)

### Search Quality (Story 003-010)

- [ ] Multiple query variants are generated (visible in browser console)
- [ ] Results are deduplicated across providers
- [ ] Author/year hints improve result ranking when provided
- [ ] Document-level keywords influence search (longer documents produce better context)

### Edge Cases

- [ ] `/cite` inside a LaTeX command (e.g., `\citeauthor{`) does NOT trigger the modal
- [ ] Empty search (no context, no hints) still works without crashing
- [ ] Rapidly opening/closing the modal does not leave stale state
