# Testing Checklist

Manual testing guide for Kuhn features. Newest features first.
Updated as stories are completed — check the date on each section.

---

## Knowledge Library (Issue #65, 2026-08-11)

**Setup:** backend + webapp dev servers (no Docker needed — v1 catalog items are
markdown). Scripted version: `node webapp/scripts/knowledge-check.mjs`
(`npm run knowledge-check` in `webapp/`, no LLM tokens).

- [ ] Org menu → Org admin → **Knowledge** tab lists 12 packages (3 nested under Biosciences)
- [ ] Checking a package imports its items; item rows reach "Searchable" live
- [ ] Unchecking one item flips the package checkbox to indeterminate
- [ ] Org library panel groups imports under "Kuhn knowledge library"; their delete buttons are locked
- [ ] Non-owner members see a read-only Knowledge view via org menu → "Org knowledge…"
- [ ] New-org seed step offers the package picker with "General scientific writing" pre-checked
- [ ] After enabling, agent chat can cite the imported standards (`search_org_knowledge`)

---

## Render & Export (Story 002-019, 2026-06-12)

**Setup:** backend + webapp dev servers, Docker running with the sandbox images pulled
(one-time: `docker pull ghcr.io/typst/typst:latest && docker pull pandoc/core:latest` —
the backend does not pull on startup). Scripted version:
`node webapp/scripts/render-check.mjs` (no LLM tokens).

- [ ] Click **Preview** in the topbar — panel opens and the rendered PDF of the open
      document appears (first render takes a few seconds; container startup)
- [ ] Edit the document, click **Render** — the preview updates with the new content
      (unchanged content responds instantly: `X-Render-Cache: hit`)
- [ ] Citations resolve: a doc with `[@key]` + `references.bib` next to it renders
      "(Author et al. YEAR)" plus a formatted bibliography
- [ ] **.docx** / **.tex** buttons download `main.docx` / `main.tex`; the docx opens in
      Word/Pages, the tex contains `\documentclass`
- [ ] Error surface: a doc with a failing raw-typst block (e.g. `#assert(false, ...)`)
      shows the Typst compile error in the preview status line — red text, not a crash
- [ ] No `.preview-*.typ` files linger in the project tree after rendering

## Collab Reload Race Fix (Story 002-024, 2026-06-12)

**Setup:** backend + webapp dev servers. Scripted version: `node webapp/scripts/reload-check.mjs`
(no LLM tokens).

- [ ] Open http://localhost:5174, wait for sync, reload — no `Context "editorState" not found`
      (or any other) error in the browser console, even when reloading repeatedly against a
      warm Yjs room
- [ ] Type text and reload before the save debounce (~1.5 s) — the text survives the reload
- [ ] Two tabs still sync edits (`node webapp/scripts/collab-check.mjs`)

## Slash Commands & `/cite` (Story 002-016, 2026-06-12)

**Setup:** backend + webapp dev servers, open http://localhost:5174. Scripted version:
`node webapp/scripts/cite-check.mjs` (citation endpoints intercepted — no PubMed network
or LLM tokens needed). Backend unit tests: `cd agent-backend && npm test` (citations.test.js).

- [ ] Type `/` at the start of a line or after a space — command menu opens at the caret;
      typing filters it; ↑↓ navigate, Esc closes, Enter/Tab or click selects
- [ ] `/` mid-word or right after a citation chip does NOT open the menu
- [ ] Select **/cite** — the typed `/cite` text is consumed and the picker opens; search
      "semaglutide cardiovascular" → PubMed candidates with title/authors/journal/year
- [ ] Pick a candidate — a styled `[@key]` chip is inserted; `draft/references.bib` gains a
      full BibTeX entry (file tree refreshes); the saved markdown contains plain `[@key]`
- [ ] Cite the same paper again — the existing key is reused, no duplicate bib entry
- [ ] Hover a chip — tooltip shows authors (year), title, journal from the bib
- [ ] Reload — `[@key]` in the markdown source renders as a chip again
- [ ] Error paths: nonsense query → "No results"; backend stopped → error in the picker
      status line, editor keeps working
- [ ] Agent path: ask the RA to "find and add a citation about X to the bibliography" —
      it uses `add_citation`, chat shows "📚 ra added citation [@key]", bib + tree refresh
      (costs real quota)

## Project Seeding Pipeline (Story 002-015, 2026-06-12)

**Setup:** backend (`cd agent-backend && npm run dev`) + webapp (`cd webapp && npm run dev`),
open http://localhost:5174. **Note:** the pipeline runs real agent tasks (Opus PM/Writer) —
each full run costs real quota. Scripted version: `node webapp/scripts/seed-check.mjs`.

- [ ] Click **Seed project** — chat shows "🌱 seeding project…" then "▶ PM interview…"
- [ ] PM asks intake questions one at a time; input box switches to answer mode; answers unblock it
- [ ] PM does not dispatch sub-agents itself; after the interview, "✓ PM interview done"
- [ ] `project.json` written (file tree refreshes); `projects.config` populated in DB
- [ ] "▶ background research…": RA and Advisor stream interleaved; `draft/references.bib`,
      `research/literature-summary.md`, `guidance/index.md` appear
- [ ] "▶ skeleton draft…": Writer produces `draft/main.md` with sections + TODOs; citations
      use only keys that exist in `references.bib`
- [ ] `pm/status.md` written with per-stage outcomes; "✓ project seeding done"
- [ ] Failure path: a failed research branch is reported ("1 of 2 research tasks failed") but the
      skeleton still runs; an interview that saves no config aborts the pipeline
- [ ] Seeding stage prompts do NOT replay as "you" messages in the restored transcript after reload

## Chat Restore & Question UX (Story 002-020, 2026-06-12)

**Setup:** backend + webapp as above. Scripted reload check:
`node webapp/scripts/reload-resume-check.mjs`.

- [ ] Have a short exchange with an agent, reload — transcript re-renders (markdown intact),
      followed by "— restored transcript —" and "↺ resumed session(s)"
- [ ] `GET http://localhost:3002/api/projects/1/conversations` returns conversations with
      user/assistant messages; sub-agent dispatch conversations are absent
- [ ] Mid-interview reload: answer one PM question, reload, send "continue" — the PM remembers
      earlier answers (SDK session resume)
- [ ] Question timeout (set `AGENT_QUESTION_TIMEOUT_MS=15000` for testing): leave a question
      unanswered — chat shows "⏱ question timed out…", input box returns to normal mode, and the
      agent continues with defaults
- [ ] Reply to a dead question (answer after the task ended): clear "no longer waiting" message,
      input box back to normal
- [ ] Weighted budget: in the backend logs / job rows, a Haiku RA task burns the shared budget at
      1/5 the rate of the Opus PM (`AGENT_MODEL_WEIGHTS`, default `haiku:1,sonnet:3,opus:5`)

## Agent Runtime, PM Interview & Webapp (Stories 002-011/012/013/018/021, 2026-06-11)

**Setup:** backend + webapp as above. (Backfilled summary — see the story files for detail.)

- [ ] Chat: pick a role, send a message — reply streams token-by-token, then renders as markdown;
      token usage appears in the status bar; follow-ups continue the same conversation
- [ ] PM `ask_user`: ask the PM to interview you — question bubble appears, input switches to
      answer mode, reply unblocks the agent on the same stream
- [ ] Per-agent models (021): `SELECT slug, model FROM agents` shows opus for pm/writer,
      sonnet for advisor/reviewer/analyst, haiku for ra
- [ ] Storage API (018): `GET /api/projects/1/file?path=../etc/passwd` → 403; agent file tools
      stay inside the project root
- [ ] Editor: edits to `draft/main.md` save (debounced/Cmd-S) and sync across two tabs (Yjs)
- [ ] Jobs are durable: restart the backend mid-task — the job row ends up `interrupted`,
      `POST /api/agent/jobs/:id/dispatch` re-runs it with the recorded session

## Agent Backend: Database + Seeding (Story 002-010, 2026-04-14; setup updated for SQLite 2026-07-09)

**Setup:** `cd agent-backend && npm run dev` (in-process SQLite; no service to start).
DB queries below assume the default DB path, repo-root `data/db/kuhn.sqlite`.

- [ ] Server starts and prints "[db] Schema applied." and "[seed] Applied default tenant, agents, tools, and assignments."
- [ ] `curl http://localhost:3002/health` returns `{ "status": "ok", "db": { "ok": true, ... } }`
- [ ] Verify agents in DB: `sqlite3 ../data/db/kuhn.sqlite "SELECT slug, name FROM agents ORDER BY slug;"` shows 6 rows (advisor, analyst, pm, ra, reviewer, writer)
- [ ] Verify tools in DB: `sqlite3 ../data/db/kuhn.sqlite "SELECT slug, name FROM tools ORDER BY slug;"` shows 12 rows
- [ ] Verify assignments: `sqlite3 ../data/db/kuhn.sqlite "SELECT count(*) FROM agent_tools;"` returns 28
- [ ] Idempotency: restart server (`npm run dev` again) — no errors, no duplicate rows
- [ ] Standalone seed: `npm run db:seed` completes without errors
- [ ] Graceful degradation: point the DB at an unwritable path (`KUHN_SQLITE_PATH=/nonexistent/x.sqlite npm run dev`) — logs a DB init error but still listens on port 3002

## Agent Backend: Scaffold (Story 002-009, 2026-04-13; setup updated for SQLite 2026-07-09)

**Setup:** `cd agent-backend && npm run dev` (in-process SQLite; no service to start).

- [ ] Health check: `GET http://localhost:3002/health` returns JSON with DB status and uptime
- [ ] Yjs signaling: `ws://localhost:3002/yjs-signaling` accepts connections (historical — its
      only client was the removed TeXlyre fork's y-webrtc collab; the webapp uses y-websocket)
- [ ] Yjs WebSocket: two webapp tabs sync edits via `ws://localhost:3002/yjs-websocket/<room>`
      (`node webapp/scripts/collab-check.mjs`)

## TeXlyre `/cite` Command (Epic 003, 2026-04-13) — historical

The TeXlyre fork was removed in story 002-023 (2026-06-12) after the `/cite` port to
Milkdown (story 002-016, checklist above). The original TeXlyre checklist is in git
history (`git show ca90441:TESTING.md`).
