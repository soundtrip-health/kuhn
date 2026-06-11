# Story 018: Storage API + Sandboxed Execution

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Implement the two infrastructure invariants from the multi-tenancy decision
(architecture.md, 2026-06-11) while the system is still single-user: a single project-root-
enforcing storage API, and sandboxed execution for anything that runs document-derived code.
Done now, multi-tenancy later becomes auth + quotas instead of a rewrite.

## Acceptance Criteria

### Storage API

- [ ] All file operations (frontends *and* agent tools) go through one storage service:
      `read/write/list/delete/move(projectId, relativePath)`
- [ ] Path resolution rejects escapes: `..` traversal, absolute paths, and symlinks that
      resolve outside the project root (resolve real path, verify prefix)
- [ ] Every project row and file path carries `project_id`; schema includes an `owner_id`
      (tenant) column with a single default value for now
- [ ] HTTP endpoints: project tree, file CRUD, upload (multipart) — consumed by stories 013/014
- [ ] Agent file tools (story 011) rewired to call the storage service — no raw `fs` against
      user projects anywhere in agent code paths
- [ ] Tests: traversal attempts, symlink escape, cross-project access all rejected

### Sandboxed execution

- [ ] Typst/Pandoc rendering runs in a container (no network, project dir mounted read-only,
      output dir write-only, CPU/memory/time limits), not in the backend process
- [ ] The same wrapper is the designated path for future analyst Python execution
- [ ] Backend treats the sandbox as untrusted: size-capped outputs, timeout → clean error

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
