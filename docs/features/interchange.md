---
title: Interchange with external writing tools
area: interchange
keywords: interchange, API token, personal access token, bearer, export bundle, import bundle, zip, manifest.json, references.json, comments.json, sciwriter, feedback, round trip, doc_open, org_required
---

# Interchange with external writing tools

Kuhn can be the review surface for a manuscript whose source of truth lives in another
tool. The tool pushes an interchange bundle (a zip of Kuhn workspace paths plus a manifest
and references) into a project over the REST API, colleagues and agents comment in Kuhn,
and the tool pulls the comments back as JSON. Access is through a personal API token that
acts as you. The normative contract is `docs/specs/interchange-bundle.md`; this page is the
user-facing summary. The first client is sciwriter. For one-off PDF, Word, LaTeX, slide and
HTML exports from the app, see `preview-export.md`.

## Personal API tokens

**What it does.** Mints a bearer token that lets scripts and external tools call the Kuhn
API as you: the same organizations, roles and attribution as when you are signed in. Kuhn
stores only a hash of the token.

**How to use it.** Open the account menu (the initials button at the top right, titled
"Signed in as <you>") and choose "API tokens". In the "API tokens" dialog give the token a "Name"
(placeholder "e.g. sciwriter on my laptop"), choose "Expires in" ("30 days", "90 days" or
"1 year") and press "Create token". The token is shown once with a "Copy" button. "Your
tokens" lists each token with when it was created, when it expires and when it was last
used; "Revoke" invalidates a live token immediately and "Remove" clears an expired one from
the list. Clients send it as `Authorization: Bearer kuhn_…` on every request.

**Prerequisites.** A signed-in session. Tokens work in every auth mode, including dev.

**Gotchas.** The raw value is never shown again; if you lose it, revoke and create a new
one. A token cannot create, list or revoke tokens (`403 token_scope`), so a leaked token
cannot extend its own life. Names are limited to 64 characters and expiry to 365 days; the
default is 90. A revoked, expired or unknown token gets `401 authentication required`.
"Last used" is updated at most once a minute.

## Exporting a project as a bundle

**What it does.** `GET /api/projects/:id/export` returns the project's documents with
their comment threads, all references, the history head and the last import's provenance,
either as JSON (the feedback payload) or as a zip bundle that can be imported into another
Kuhn project.

**How to use it.** Call `GET /api/projects/:id/export?format=json` (the default) or
`format=zip` with a bearer token. Add `path=` (repeatable) to choose documents; without it
the export covers the documents of the last import, or every `.md` under `draft/` if the
project was never imported. JSON carries, per document, `content`, the stored `meta`,
`modified_since_import`, and `comments` as threads with nested `replies`, a normalized
`author` (`member`, `reviewer` or `agent`) and `anchor` offsets into that same `content`.
The zip (`kuhn-project-<id>.zip`) has the bundle layout: `manifest.json`,
`references.json`, `files/<workspace path>` for the docs and the non-markdown files under
their directories (figures, tables, data), plus `comments.json`.

**Prerequisites.** Viewer role in the project.

**Gotchas.** Only accepted content crosses the boundary: pending agent suggestions are not
exported. Comments in a zip are informational; importing that zip elsewhere reproduces
docs, assets and references but not comments. The same URL with `format=pdf`, `docx`,
`tex`, `pptx` or `html` is the rendered document export; any other value is
`400 invalid_format`. There is no button for bundle export in the app; it is API-only.

## Importing a bundle

**What it does.** Creates a project from a bundle, or updates an existing project's
documents, assets and references from one, as a single checkpointed, event-publishing
write.

**How to use it.** To create: `POST /api/projects/import` as `multipart/form-data` with the
zip in the field `bundle`; `manifest.project.name` is required and `project_type` may be
`manuscript` (default), `grant`, `rwe-protocol`, `rct-protocol` or `sop`. The project lands
in the org given by the form field `org_id`, else `manifest.project.org_id`, else your only
organization. To update: `POST /api/projects/:id/import` with the same body; optional
fields `force=1` and `label` (a suffix for the history checkpoint). Both answer with the
project, per-file `created` flags, per-reference outcomes (`created`, `matched` or
`renamed` with `actual_key`), `citations_rewritten`, comment re-anchoring counts and the
`checkpoint` commit.

**Prerequisites.** Editor role in the target organization (create) or project (update).

**Gotchas.** If you belong to several organizations you must name one, or creation is
refused with `400 org_required` listing your organizations. The whole zip is validated
before anything is written; a refused import leaves nothing behind, and creation makes no
project. Imports are additive: files in the project but not in the bundle are untouched.
References are upserted under the cite key you supply; when dedup or a collision forces
another key, `[@key]` citations in the bundle's docs are rewritten and the map is returned.
Kuhn writes a "Snapshot before import" checkpoint, then the files, then an "Import from
<tool> @<revision>" checkpoint; existing comments are re-anchored against the new text and
flagged `orphaned` when their quote is gone (never deleted). If a member has a target
document open in the editor the import refuses with `409 doc_open` listing the paths;
`force=1` closes those editors with "Document replaced by import" and unsaved edits there
are lost. Limits: 200 MB uncompressed (`KUHN_IMPORT_MAX_BYTES`), 500 entries
(`KUHN_IMPORT_MAX_ENTRIES`), 20 MB per file (`STORAGE_MAX_FILE_BYTES`), 64 KB of `meta`
per document. Re-importing an identical bundle is a no-op.

## The sciwriter workflow

**What it does.** The round trip the format was built for: sciwriter stays the source of
truth, Kuhn collects review, and the comments come back into sciwriter's own syntax.

**How to use it.** Create an API token and set two environment variables where the
sciwriter scripts run: `KUHN_URL` (this site) and `KUHN_API_TOKEN`. The first
`export_to_kuhn.py` push calls `POST /api/projects/import` and records the returned
project id in sciwriter's sidecar; later pushes update that project. Docs go under
`files/draft/…` and figures under the doc's own directory (`files/draft/figures/…`), so
image links need no rewriting. `import_kuhn_feedback.py` pulls
`GET /api/projects/:id/export` (JSON) and converts comments; sciwriter applies
`citations_rewritten` to its archived base so redlines stay clean. A fixture bundle lives
in `test-projects/interchange/` (zip the directory's contents, not the directory), and
`npm run interchange-check` in `webapp/` drives the whole loop against a running backend
without spending model quota.

**Prerequisites.** A Kuhn account with editor role in the target organization (an owner
invites you from the Members tab; see `org-admin.md`) and a token.

**Gotchas.** Everything sciwriter-specific happens on the sciwriter side: Kuhn never
inspects document content beyond citation keys, never renames a project on re-push, and
never deletes files. Keep the token out of the sidecar and version control; the sidecar
records only `kuhn_url` and `project_id`. Handle `409 doc_open` by asking the person whose
editor is open before retrying with `force=1`.
