# Epic 006: Org Knowledge Library

**Status:** in-progress
**Created:** 2026-07-12
**Updated:** 2026-07-12 (003 shipped — agents can search the org library with provenance; FTS eval 10/11, no embeddings story needed; next: 004 UI/onboarding)

## Goal

Give each organization a shared, searchable library of its own knowledge —
SOPs, house style guides, regulatory guidance, templates, prior work — that
agents actually consult. Prompt users to start the library at org creation and
make adding to it trivially easy afterwards.

Today **nothing in the system is org-scoped except access control**: every
content table is keyed by `project_id`, `organizations` holds only
`name`/`slug`, uploads are opaque bytes with no content extraction or
indexing, agent search is a literal regex scan over the project workspace
(`storage.js:208-238`), and the curated top-level `guidance-docs/` corpus is
never read at runtime. The advisor prompt's claim that its knowledge base
"grows over time across projects" (`db/prompts/advisor.md`) is currently
unbacked — this epic makes it true.

Fulfills the architecture's long-planned "per-tenant KB + shared guidance
corpus" (deferred from Epic 004).

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Retrieval | **SQLite FTS5 (BM25) first; no embeddings yet** | In-process, zero new infra, strong on regulatory/domain terminology. Embeddings become a later story only if FTS relevance proves insufficient — measure before adding a vector dependency. |
| Storage scope | **Extend `storage.js` with an explicit org scope** | `resolveSafe` root-enforcement is the tenancy-safety invariant; org files live under `<KUHN_DATA_DIR>/orgs/<orgId>/library/` behind the same chokepoint. No second path-handling module. |
| Extraction | **Sandboxed, via `sandbox.js`** | Pandoc (already pulled) for docx/html/md; PDF needs poppler `pdftotext` (small additional image) — decided in Story 002. No in-process native parsers. |
| Agent access | **New `search_org_knowledge` MCP tool** | Agents cannot reach outside the project root today (correctly). Org knowledge crosses that boundary through one read-only, provenance-carrying tool — not by widening file access. |
| Ingestion status | **Emit lifecycle events (`ingesting` → `ready`/`failed`)** | The file manager's dormant `ingesting`/`done` badge states (Epic 005) light up from this pipeline. |
| Seed corpus | **`guidance-docs/` becomes importable content** | The curated corpus is the test fixture and the default offer for new orgs; it stays human-curated in the repo, imported per-org on request rather than globally wired. |

## Scope

### Must Have

- [x] `org_documents` store + org-scoped storage root, membership-guarded CRUD
- [x] Ingestion pipeline: extract → chunk → FTS5 index, with status lifecycle
- [x] `search_org_knowledge` agent tool, allowlisted via `agent_tools`;
      advisor/RA prompts updated to use it
- [ ] Org library UI: browse/upload/delete, ingestion status visible
- [ ] Org-creation flow replaced (no more `window.prompt`) with a modal that
      prompts seeding the library; "promote to org library" from project files

### Deferred

- Embedding/vector retrieval (only if FTS relevance falls short)
- Cross-org shared Kuhn-curated corpus served centrally (per-org import first)
- Library versioning/approval workflow for regulated-doc control
- Org admin beyond library management (invites, roles, quotas — Epic 007+)

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Org document store & storage scope](stories/001-org-document-store.md) — `org_documents` table, org storage root via `storage.js`, guarded CRUD routes | done | L |
| 002 | [Ingestion pipeline & FTS index](stories/002-ingestion-and-fts.md) — sandboxed text extraction, chunking, FTS5 table, status lifecycle events | done | L |
| 003 | [`search_org_knowledge` agent tool](stories/003-search-org-knowledge-tool.md) — MCP tool + allowlist + prompt updates; provenance in results | done | M |
| 004 | [Org library UI & onboarding](stories/004-org-library-ui-onboarding.md) — library browser, org-creation modal with seed step, promote-from-project | ready | L |

## Sequencing

001 → 002 → 003 sequential. 004 can start against 001's API (upload/browse)
and grows ingestion-status display as 002 lands. Story 002's status events
plug into Epic 005's feed if it has shipped; otherwise they degrade to
poll-on-open (soft dependency, not a blocker).

## Risks

- **PDF extraction quality** — regulatory PDFs (multi-column, scanned) extract
  poorly; scope Story 002 to text-layer PDFs and surface `failed`/low-yield
  status honestly rather than indexing garbage. OCR is out of scope.
- **Retrieval relevance** — FTS5 needs sane chunking (heading-aware, ~500–1000
  tokens) to return useful passages; budget eval time in Story 003 with the
  `guidance-docs/` corpus as the fixture.
- **Tenancy** — this is the first org-scoped *content*; the `resolveSafe`
  extension and route guards in 001 are the invariant-bearing surface. Review
  accordingly.
