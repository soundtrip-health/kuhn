# Spec: Kuhn interchange — bundle format and API

**Status:** implemented on the Kuhn side — API tokens (#156), import (#157), export (#158), docs (#155 PR); the joint smoke with sciwriter's scripts is the remaining step (2026-09-09)
**Companion:** `2026-09-08-kuhn-interchange-design.md` (sciwriter-side design: converters, sidecar, redline). This document is the Kuhn-side contract that design codes against. Where the two disagree, this one wins and the 09-08 design should be updated.
**Issues:** [#152 API tokens](https://github.com/soundtrip-health/kuhn/issues/152) · [#153 import](https://github.com/soundtrip-health/kuhn/issues/153) · [#154 export](https://github.com/soundtrip-health/kuhn/issues/154) · [#155 docs + smoke](https://github.com/soundtrip-health/kuhn/issues/155)

## 1. What changed since the 09-08 design

The 09-08 design is right in shape: two composite endpoints, a bundle as the contract, sciwriter as source of truth. Five things change, all driven by how the deployed Kuhn actually works:

1. **Auth is a per-user bearer token, not a shared secret.** The deployed Kuhn (`kuhn.soundtrip.ai`) runs in magic-link mode; every API route requires an identity, and every write is attributed to a user and scoped to that user's organizations. A token minted by a signed-in Kuhn user carries all of that for free. A shared secret would need Kuhn to trust an org/user named in the bundle, which is the one thing the tenancy layer never does.
2. **The bundle is Kuhn's generic interchange format.** Paths inside it are Kuhn workspace paths (`draft/main.md`, `draft/figures/x.png`), the project id lives in the URL rather than the manifest, and tool-specific data rides in an opaque `meta` slot that Kuhn stores and echoes back. Nothing in the URL or format says "sciwriter".
3. **Cite keys are honored, and renames are reported.** Kuhn's reference inserter generates its own keys and dedups by DOI/PMID; naively reusing it would silently break `[@key]` citations. The importer honors the supplied `cite_key`, and when dedup or a key collision forces a different key it rewrites the citations in the imported docs and returns the map.
4. **Import is a checkpointed, event-publishing, conflict-aware write.** One history checkpoint before and one after, file events for every path (so open editors refresh), a 409 when a member has a target doc open, and server-side re-anchoring of existing comments against the new text.
5. **Export is the same bundle plus comments.** Symmetric schemas, so Kuhn can test export → import → export identity without sciwriter in the loop.

## 2. Prerequisites and authentication

- Each person who pushes needs a **Kuhn account with editor role** in the target organization. Kuhn is invite-only; an org owner invites them from the Members panel.
- They mint a **personal API token** in Kuhn (account menu → *API tokens* → *New token*, choose a name and expiry). The token is shown once. Kuhn stores only its SHA-256, like sessions and review links today.
- Every request carries `Authorization: Bearer <token>`. The token acts as that user: same org memberships, same role checks, same attribution on comments, file events and history commits as if they were signed in.
- Tokens are listable and revocable per user. Default expiry 90 days, maximum 365. A revoked, expired or unknown token gets `401 {error:'authentication required'}`.

Client configuration on the sciwriter side is two environment variables:

```
KUHN_URL=https://kuhn.soundtrip.ai
KUHN_API_TOKEN=kuhn_…            # never committed; the sidecar records KUHN_URL and the project id only
```

Token endpoints (session-authenticated, i.e. from the webapp):

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/api/me/tokens` | `{name, expires_in_days?}` → `201 {token, id, name, expires_at}` (token appears here only) |
| `GET` | `/api/me/tokens` | `{tokens:[{id,name,created_at,last_used_at,expires_at}]}` |
| `DELETE` | `/api/me/tokens/:id` | revoke; `204` |

Tokens are prefixed `kuhn_` so secret scanners and greps can find them.

## 3. Bundle format (schema_version 1)

A zip file:

```
manifest.json
references.json          # optional; may be empty
files/<workspace path>   # every file the bundle carries: docs AND assets
comments.json            # export only
```

Bundle paths under `files/` **are** the Kuhn workspace paths. There is no separate `docs/` vs `figures/` tree; the manifest says which files are documents.

**Relative links resolve relative to the document's own directory** (standard markdown; Kuhn's renderer resolves `![…](figures/x.png)` from `draft/main.md` as `draft/figures/x.png`). The simplest round trip is therefore to place assets under the doc's directory so the link text in the doc never changes: sciwriter's `![cap](figures/x.png)` in `draft/main.md` stays verbatim and the PNG lands at `files/draft/figures/x.png`. No link rewriting in either direction.

### manifest.json

```json
{
  "schema_version": "1",
  "source": {
    "tool": "sciwriter",
    "project": "bendable2",
    "revision": "<git sha at export>",
    "exported_at": "2026-09-08T00:00:00Z",
    "exported_by": "bob.dougherty@osmind.org"
  },
  "project": {
    "name": "bendable2 — for review",
    "project_type": "manuscript",
    "org_id": null
  },
  "docs": [
    {
      "path": "draft/main.md",
      "title": "…",
      "meta": {
        "figure_numbering": { "fig:forest": 1 },
        "table_numbering": { "tab:endpoints": 1 },
        "patent_inlines": [ { "marker": "US10478405B2", "text": "(US10478405B2, Assignee)" } ]
      }
    }
  ]
}
```

- `source` is free-form provenance. Kuhn stores it and labels the history checkpoint with `tool` and `revision`.
- `project` is used on **create** only: `name` required, `project_type` one of `manuscript | grant | rwe-protocol | rct-protocol | sop` (default `manuscript`), `org_id` the Kuhn organization to create in (the user must hold editor there). A user who belongs to exactly one organization may omit it; anyone in several must name one, here or as the multipart field `org_id`, or the import is refused with `400 org_required` listing their organizations — the Kuhn UI shows one organization at a time, so a silent default would put the project where they are not looking. On **update** it is ignored; rename with `PATCH /api/projects/:id` if wanted.
- `docs[].path` must exist under `files/`. `meta` is opaque JSON (≤ 64 KB per doc); Kuhn stores it under the project's `interchange` config and returns it unchanged on export. sciwriter can keep its sidecar as well; this just means a fresh clone can recover it from Kuhn.
- Files under `files/` not listed in `docs` are assets and are written verbatim.

### references.json

An array. `cite_key` and `title` are required; everything else optional. Field names match Kuhn's `bib_references` columns. `authors` is an array of family-first strings (`"Berman, R. M."`), which is how Kuhn stores and emits them; `{family, given}` objects are also accepted and normalized to that form.

```json
[
  {
    "cite_key": "Berman2000",
    "entry_type": "article",
    "title": "…",
    "authors": [ "Berman, R. M.", "Cappiello, A." ],
    "year": 2000,
    "journal": "…", "volume": "…", "issue": "…", "pages": "…", "publisher": "…",
    "doi": "…", "pmid": "…", "pmcid": "…", "url": "…", "abstract": "…"
  }
]
```

Only cited keys need to be included. Kuhn resolves each entry as follows, in order, and reports the outcome per key:

| Outcome | When | Effect |
|---|---|---|
| `created` | no existing reference matches by key, DOI/PMID or title+author+year | inserted under the requested `cite_key` |
| `matched` | the requested key already holds the same reference, **or** a strong/weak match exists under another key | mutable fields (title, authors, year, journal, …) are refreshed from the bundle; `actual_key` is the existing key |
| `renamed` | the requested key is held by a *different* reference | inserted under `actual_key` (requested key plus a suffix) |

Whenever `actual_key ≠ cite_key`, Kuhn rewrites `[@cite_key]` → `[@actual_key]` in every doc in the bundle before writing it (all Pandoc citation forms: `[@k]`, `[@a; @b]`, `[-@k]`, `[@k, p. 3]`, bare `@k`). The response carries the map; the sciwriter side should apply the same map to its archived base so the redline diff is clean. In practice the first push creates the keys sciwriter asked for, so re-pushes are identity maps.

### comments.json (export only)

Keyed by doc path. Each thread is a root with nested `replies`. Shape mirrors Kuhn's comments API with the author normalized into one object.

```json
{
  "draft/main.md": [
    {
      "id": 118,
      "body": "This claim needs the 2023 replication.",
      "author": { "kind": "reviewer", "name": "A. Reviewer", "id": 9 },
      "anchor": { "quote": "response rates exceeded 60%", "start": 4120, "end": 4147 },
      "orphaned": false,
      "resolved_at": null,
      "resolved_by": null,
      "created_at": "2026-09-10T14:02:11.120Z",
      "replies": [
        { "id": 121, "body": "Added, see Berman2000.", "author": { "kind": "member", "name": "Bob Dougherty", "id": 1 }, "created_at": "…" }
      ]
    }
  ]
}
```

- `author.kind` is `member` (a Kuhn user), `reviewer` (an external magic-link reviewer; `name` is the name they claimed), or `agent` (`name` is the agent slug, e.g. `reviewer`). Kuhn never emits `\pi{}`/`\cr{}`; the sciwriter importer decides that mapping (per the 09-08 design: everything becomes `\pi{Name: …}`).
- `anchor` offsets are character offsets into the doc `content` **in the same export**, re-resolved at export time; `orphaned: true` means the quote could not be found and offsets are the last known hint.
- Resolved threads are included with `resolved_at` set; filtering is the client's choice (the 09-08 design skips them by default).

## 4. Endpoints

All three require a bearer token or a session. Role: editor for import, viewer for export.

### `POST /api/projects/import` — create a project from a bundle

`multipart/form-data` with one field `bundle` (the zip). Optional fields `org_id` (overrides `manifest.project.org_id`) and `label` (history checkpoint label suffix).

Response `201`:

```json
{
  "project": { "id": 42, "name": "bendable2 — for review", "project_type": "manuscript", "org_id": 3 },
  "files": [ { "path": "draft/main.md", "kind": "doc", "created": true }, { "path": "draft/figures/fig1.png", "kind": "asset", "created": true } ],
  "references": [ { "cite_key": "Berman2000", "status": "created", "actual_key": "Berman2000" } ],
  "citations_rewritten": { "draft/main.md": { "smith2020": "smith2020a" } },
  "comments": { "reanchored": 0, "orphaned": 0 },
  "checkpoint": "<git sha>"
}
```

### `POST /api/projects/:id/import` — update an existing project

Same body. Optional field `force=1` (see *open documents* below). Response `200`, same shape. `created` per file is `false` for overwrites.

### `GET /api/projects/:id/export` — pull docs, comments and references

Query: `path=` (repeatable; default: the docs of the last import, or every `.md` under `draft/` if the project was never imported), `format=json|zip` (default `json`).

`format=json` returns everything inline, no binary assets — the feedback payload:

```json
{
  "schema_version": "1",
  "project": { "id": 42, "name": "…", "project_type": "manuscript" },
  "exported_at": "…",
  "revision": "<git sha of the project's history head>",
  "last_import": { "source": { "tool": "sciwriter", "revision": "…", "…": "…" }, "imported_at": "…", "checkpoint": "<git sha>" },
  "docs": [
    {
      "path": "draft/main.md",
      "content": "…full markdown…",
      "meta": { "…": "as imported" },
      "modified_since_import": true,
      "comments": [ "…threads as in comments.json…" ]
    }
  ],
  "references": [ "…same shape as references.json, all project references…" ]
}
```

`format=zip` returns the bundle layout of §3 (`manifest.json` with an added `export` block carrying the fields above, `references.json`, `files/…` including assets, `comments.json`). Importing that zip into another Kuhn project reproduces the docs, assets and references; comments are informational and are not imported.

`modified_since_import` is true when the doc's content differs from the bytes written by the last import checkpoint. Per-hunk attribution is **not** provided; the existing history endpoints (`GET /api/projects/:id/history?path=` and `…/history/file?path=&ref=`) expose every version since the checkpoint with author and timestamp if the sciwriter side ever wants it.

### Errors

Standard Kuhn shapes: `{error, code?}`.

| Status | When |
|---|---|
| 400 `invalid_bundle` | not a zip, missing/invalid manifest, doc listed but absent, unsafe path (`..`, absolute, `.git`), non-UTF-8 doc, bad `project_type`, `meta` too large |
| 400 `org_required` | create only: the user belongs to several organizations and neither the manifest nor the `org_id` field names one; body lists `orgs: [{id, name, slug, role}]` |
| 401 | no/invalid/expired token or session |
| 403 | token user lacks editor role, or the org is suspended |
| 404 | project not found **or** the user is not a member (non-leaking, as everywhere in Kuhn) |
| 409 `doc_open` | a Kuhn member has one of the target docs open in the editor and `force` was not set; body lists `paths` |
| 413 `too_large` | any file over the upload limit (`STORAGE_MAX_FILE_BYTES`, default 20 MB), bundle over `KUHN_IMPORT_MAX_BYTES` (default 200 MB uncompressed), or more than 500 entries |

## 5. Import semantics

- **Validate everything, then write.** The zip is fully parsed and checked (paths, sizes, manifest, docs decode as UTF-8, citation keys parse) before any byte touches the project. Validation failures write nothing.
- **Additive.** Files present in the project but absent from the bundle are left alone. sciwriter never deletes in Kuhn; a doc removed from the draft simply stops being updated.
- **Two checkpoints.** `Snapshot before import` on the pre-import state, then all writes, then `Import from <tool> @<revision>` (with the optional `label`). The response's `checkpoint` is the second commit; the export's `last_import.checkpoint` returns it, so the sciwriter side can always diff against exactly what was pushed via the history endpoints, independently of its own archived base.
- **References before docs.** References are upserted first so the citation rewrite map is known before docs are written; `draft/references.bib` is materialized at the end.
- **Events.** Every written path publishes a `file_change` event (`create` or `update`, attributed to the token user), the same way an upload does. Idle collaboration rooms are evicted so the next open re-seeds from the new bytes; rooms held only by external reviewers are told to refresh. This is what a plain file `PUT` deliberately does *not* do, which is why the import endpoint exists rather than a client-side loop of PUTs.
- **Open documents.** A room held by a signed-in member keeps the live Yjs state, which would autosave stale content over the import. Without `force`, the import refuses with `409 doc_open` listing the paths. With `force=1`, those sockets are closed with the terminal *document replaced* close (4001): the member's editor stops, says the document was replaced, and the next open re-seeds from the imported bytes. (Not the reconnectable refresh close — a member client auto-reconnects after that and would re-seed the room from its own stale state.) Unsaved local edits in that editor are lost, so the sciwriter CLI should surface the 409 and ask before forcing.
- **Comment re-anchoring.** After the docs are written, every root comment on an imported path is re-resolved against the new content (exact match nearest the old offset, then whitespace-normalized). Found anchors get updated offsets; missing ones are flagged `orphaned` (and un-flagged if a later import brings the text back). Threads are never deleted. Counts are returned.
- **Provenance.** The manifest's `source` and `docs[].meta` are stored under the project's `interchange` config, together with `imported_at`, `checkpoint`, and the per-doc content hash written. The webapp can later show "imported from sciwriter @abc123, 2 h ago"; for v1 this is API-only.
- **Idempotent.** Re-importing an identical bundle writes the same bytes, creates no history commit (git sees no change), refreshes reference fields to the same values, and returns `created: false` everywhere.
- **Logging.** Every import and export writes a structured log line (`interchange_import` / `interchange_export`) with project, user, tool, revision, file and reference counts, rewritten keys, re-anchor counts, and duration.

## 6. What this means for the sciwriter side

Changes to the 09-08 design, all small:

1. Send `Authorization: Bearer $KUHN_API_TOKEN`; read `KUHN_URL` from the environment. Drop the "dev auth, no token" assumption. The sidecar `kuhn.json` records `kuhn_url` and `project_id`, never the token.
2. Bundle layout: `files/draft/<relpath>.md` for docs, `files/draft/figures/<name>.png` for figures, so `![…](figures/x.png)` needs no rewriting. `references.json` uses `authors` (not `authors_json`), as family-first strings. Per-doc numbering and patent maps go under `docs[].meta`.
3. First push: `POST /api/projects/import`, record `project.id` from the response. A user in several Kuhn organizations must pass `org_id` (a `--org` flag that fills the multipart field is the natural home; the `400 org_required` body lists the choices). Later pushes: `POST /api/projects/{id}/import`. Handle `409 doc_open` by asking, then retrying with `force=1`.
4. Apply `citations_rewritten` to the archived base before storing it, so the base matches what Kuhn holds.
5. Feedback pull: `GET /api/projects/{id}/export` (JSON). Comments come with `author.kind`/`author.name`; anchors are offsets into the returned `content`. The `\pi{Name: …}` mapping, resolved-skipping and section-level fallback stay exactly as designed.
6. The 09-08 push-refusal on residual `\cr{}`/`\pi{}` stays a sciwriter-side rule; Kuhn does not inspect doc content beyond citations.

## 7. Testing

- Kuhn unit tests: bundle parsing/validation (safe paths, limits, manifest schema), key-honoring reference upsert (all three outcomes), citation rewrite across Pandoc forms, comment re-anchoring, token auth in both auth modes.
- Kuhn route tests: create and update imports end to end against a temp data dir; 409/force path with a live room; export JSON and zip; **export → import → export identity** on a fixture bundle under `test-projects/interchange/`.
- Token-free check script (`webapp/scripts/interchange-check.mjs`, `npm run interchange-check`) that pushes the fixture, edits the doc and adds a comment through the API, pulls the export, re-pushes (re-anchoring the comment), and round-trips the zip export through a second project.
- Joint smoke: sciwriter's `export_to_kuhn.py` / `import_kuhn_feedback.py` against an isolated dev pair first (`KUHN_URL=http://localhost:31xx`, dev auth accepts the bearer token too), then against production with a real token.

## 8. Kuhn implementation plan

Four pull requests, in this order. The first unblocks the sciwriter team to test authentication against the deployed instance before the endpoints exist.

**PR 1 (#152 → PR #156) — Personal API tokens.** `api_tokens` table (`id, user_id, name, token_hash, last_used_at, expires_at, revoked_at, created_at`); `db/api-tokens.js` (mint/list/revoke/resolve, hashing as in `db/auth.js`); a bearer branch in `session.js` ahead of the cookie lookup, active in every auth mode; `/api/me/tokens` routes on `meRouter`; an *API tokens* panel in `webapp/src/user-menu.ts` (+ `api.ts`); threat-model row for the new credential kind; deployment doc section. Tests for the store, the middleware, and the routes.

**PR 2 (#153 → PR #157) — Import.** `src/interchange/` (`bundle.js` zip read + validation, `citations-rewrite.js`, `import.js` orchestration); `upsertReferenceByKey` in `db/references.js`; `reanchorPath` in `db/comments.js`; `routes/interchange.js` mounted in `index.js`; a `hasMemberConnections(room)` helper in `yjs-websocket.js` for the 409; zip reading via a small pure-JS dependency (`fflate`); `KUHN_IMPORT_MAX_BYTES` in `config.js`; structured log lines. Fixture bundle under `test-projects/interchange/`.

**PR 3 (#154 → PR #158) — Export.** JSON and zip export in `routes/interchange.js`, comment shaping with the normalized `author`, `modified_since_import` via the stored content hash, the round-trip identity test, and the check script.

**PR 4 (#155) — Docs and smoke.** `docs/architecture.md` interchange section, README pointer, this spec marked implemented, joint smoke with the sciwriter scripts.

Rough effort: PR 1 one day, PR 2 two days, PR 3 one day, PR 4 half a day.

## 9. Decisions (resolved 2026-09-09)

- **Token minting UI vs API-only for v1.** The panel is small; if it slips, an owner can mint via `curl` with a session cookie. **Decided:** ship the panel in PR 1.
- **Should export also carry pending agent edits?** Kuhn's agents can propose edits that sit as pending, off-disk. **Decided:** no; only accepted content crosses the boundary.
- **Project naming on re-push.** **Decided:** never rename on update; the sciwriter user renames in Kuhn if they want.
