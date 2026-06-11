# Story 018: Storage API + Sandboxed Execution

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Implement the two infrastructure invariants from the multi-tenancy decision
(architecture.md, 2026-06-11) while the system is still single-user: a single project-root-
enforcing storage API, and sandboxed execution for anything that runs document-derived code.
Done now, multi-tenancy later becomes auth + quotas instead of a rewrite.

## Acceptance Criteria

### Storage API

- [x] All file operations (frontends *and* agent tools) go through one storage service:
      `read/write/list/delete/move(projectId, relativePath)`
- [x] Path resolution rejects escapes: `..` traversal, absolute paths, and symlinks that
      resolve outside the project root (resolve real path, verify prefix)
- [x] Every project row and file path carries `project_id`; schema includes an `owner_id`
      (tenant) column with a single default value for now
- [x] HTTP endpoints: project tree, file CRUD, upload (multipart) — consumed by stories 013/014
- [x] Agent file tools (story 011) rewired to call the storage service — no raw `fs` against
      user projects anywhere in agent code paths
- [x] Tests: traversal attempts, symlink escape, cross-project access all rejected

### Sandboxed execution

- [x] Typst/Pandoc rendering runs in a container (no network, project dir mounted read-only,
      output dir write-only, CPU/memory/time limits), not in the backend process
- [x] The same wrapper is the designated path for future analyst Python execution
- [x] Backend treats the sandbox as untrusted: size-capped outputs, timeout → clean error

## Implementation Notes (2026-06-11)

- `agent-backend/src/storage.js` — the single storage service. Containment: rejects
  absolute paths and `..` after normalization, then real-paths the deepest existing
  ancestor and verifies it stays under the (also real-pathed) project root, so symlink
  escapes are caught even for not-yet-created targets. Tree listing omits symlinks
  entirely. `resolveProjectDir` moved here from the runtime and now requires the
  project row to exist.
- `agent-backend/src/routes/files.js` — tree / read / write / delete / move / multipart
  upload; `StorageError` codes map to 403 (escape), 404, 400, 409, 413.
- Agent runtime: built-in SDK file tools (Read/Grep/Glob/Write/Edit) removed; roles get
  storage-backed MCP tools instead (`read_file`, `search_files`, `list_files`,
  `write_file`, `edit_file`). `file_change` events now key off the MCP tool names.
- `agent-backend/src/sandbox.js` — `runSandboxed()` (docker run, `--network none`,
  `/work` read-only, `/out` write, `--cpus/--memory/--pids-limit`, kill + clean error on
  timeout, capped stdout/stderr) plus `renderTypstPdf()` / `pandocConvert()` helpers.
  Verified end-to-end against the real Typst image. Render output temp dirs live under
  `PROJECTS_ROOT/.render-tmp`, not `os.tmpdir()` (Docker Desktop on macOS cannot mount
  `/tmp`).
- `projects.owner_id` (default `'default'`) added with an idempotent `ALTER TABLE` for
  existing databases, plus an index.

## Known Issues

- Render HTTP endpoints and the markdown → Typst conversion are not built here; story 019
  owns them and must consume `renderTypstPdf()` / `pandocConvert()`.
- Yjs room auth remains deferred (pre-existing; see epic Deferred list) — do not expose
  the prototype beyond trusted test users.

## Technical Notes

- Container path: Docker is already a dev dependency (Postgres); a small
  `docker run --rm --network none -v project:/work:ro ...` wrapper is enough for the prototype.
  Revisit gVisor/Firecracker when hosting real tenants.
- Knowledge-base tenancy (per-tenant KB vs. shared guidance corpus) is a data-model concern
  layered on the same `owner_id` scoping — design recorded in architecture.md; implementation
  deferred until multi-user.
- Yjs room auth is explicitly deferred — do not expose the prototype beyond trusted test users.

## Out of Scope

- Authentication / orgs / quotas / billing
- Row-level security policies (column exists; policies land with auth)
- File versioning / git integration
