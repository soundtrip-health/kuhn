# Spec 190 — Soft-delete projects; owners restore or purge

GitHub issue #190: *no way to delete a project.* Members need a way to
soft-delete a project from the UI; an organization owner can restore it or
permanently delete it.

## Model

`projects` gains two nullable columns (both `schema.sql` and
`db/init.js` `COLUMN_MIGRATIONS`; **also** add them to `PROJECTS_NEW_DDL` and
`PROJECTS_COLUMNS` there, or the project_type-CHECK rebuild that runs after
the column migration would drop them on an old database):

- `deleted_at TEXT` — NULL = live.
- `deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL`.

A soft-deleted project is invisible everywhere a live project is reachable:

- `db/projects.js`: `getProject(id)` returns live projects only; add
  `getProjectAny(id)` (deleted included) for the owner routes.
  `listProjectsForUser` / `listOrgProjects` filter `deleted_at IS NULL`.
  New: `softDeleteProject(id, { userId })`, `restoreProject(id)`,
  `listDeletedOrgProjects(orgId)` (joins `users` for the deleter's
  `display_name`/`email`), `purgeProject(id)` (row delete; child rows cascade
  per the schema).
- Because every member route resolves the project through
  `requireProjectRole → getProject`, a deleted project is a non-leaking 404
  there; collab upgrades refuse (`unknown-project`); the agent run gate
  already reports `'deleted'` when `getProject` returns nothing. No new
  checks needed on those paths — add a test proving each.
- Reviewer side (`db/review-links.js`): `getReviewerSession` joins `projects`
  and requires `deleted_at IS NULL` (the guest 401s on the next request);
  `lookupReviewLink` reports state `revoked` when the link's project is
  deleted; `collab-auth.js` `reviewerLinkState` returns `'revoked'` for a
  deleted project so the 60 s sweep closes live reviewer sockets. Restoring
  the project brings the links back untouched.
- `storage.js`: `deleteProjectDir(projectId)` removes the workspace directory
  (`rm -rf` of `resolveProjectDir`). Guard: only when the real path is
  strictly inside `config.agent.projectsRoot`; otherwise skip the disk step
  and `log.warn('project_purge_dir_skipped', …)`. Never touches other roots.

## Routes

| Route | Role | Behaviour |
|---|---|---|
| `DELETE /api/projects/:id` | editor | soft-delete; `evictRoomsUnder('project-<id>', { closeConnections: true, closeReason: 'Project deleted' })` (members and reviewers alike get 4001); `publishOrgEvent(orgId, { type: 'project', action: 'deleted', projectId, name })`; `recordAuthEvent('project.deleted')`; `log.info('project_deleted')`; 200 `{ project }` (idempotent: already deleted → 404 like any other missing project) |
| `GET /api/orgs/:orgId/projects/deleted` | owner | `{ projects: [...] }` newest deletion first, each with `deleted_at`, `deleted_by: { id, display_name, email } \| null` |
| `POST /api/orgs/:orgId/projects/:id/restore` | owner | project must belong to the org and be deleted (404 otherwise); clears the columns; `project.restored` audit + org event `action: 'restored'`; 200 `{ project }` |
| `DELETE /api/orgs/:orgId/projects/:id` | owner | purge; 409 `{ error: 'project must be deleted before it can be permanently deleted' }` when still live; directory removed first, then the row; `project.purged` audit + org event `action: 'purged'`; `log.info('project_purged', { projectId, files removed? })`; 200 `{ ok: true }` |

Owner routes go in `routes/org-admin.js`; the member delete in
`routes/projects.js`. Org ownership of `:id` is checked by comparing the
project's `org_id` with the guarded org — never trust the client.

## Webapp

- `api.ts`: `deleteProject(id)`, `listDeletedOrgProjects(orgId)`,
  `restoreOrgProject(orgId, id)`, `purgeOrgProject(orgId, id)`; a
  `DeletedProject` type.
- `workspace.ts`: `deleteProject(id)` — call the API, drop it from
  `state.projects`, emit `'projects'`; if it was active, select the first
  remaining project (or none) and emit `'project'` so `main.ts` switches (an
  empty org reopens the project browser, which it already does).
- `project-browser.ts`: a trash control per card (`.pb-card-delete`, `icon('trash')`,
  aria-label `Delete <name>`), shown only when `workspace.canEdit()`. Native
  `window.confirm` (the documented exception, see `org-library.ts`):
  `Delete "<name>"? It disappears for everyone in <org>. An organization owner can restore it or delete it permanently from Org admin.`
  Toast on success; the inline error pattern on failure.
- `style.css`: `.pb-card-delete` like `.pb-card-setup` at `right: 60px`;
  hover colour `var(--warn)`.
- `org-admin.ts`: new owner-only tab `'projects'`, label "Deleted projects",
  placed after "Settings" in `OWNER_TABS`. Table columns "Project", "Type",
  "Deleted", "By"; per row "Restore" and "Delete permanently" (confirm:
  `Permanently delete "<name>" and all its files? This cannot be undone.`).
  Empty state "No deleted projects." Loaded eagerly like the other owner tabs;
  a restore re-fetches the workspace project list (`workspace.reloadProjects()`)
  so the card reappears.
- Other tabs: a `project` org-feed event (`deleted`/`restored`/`purged`) from
  another tab should refresh the workspace project list — wire it through the
  existing org feed listener if `main.ts`/`workspace.ts` already subscribe;
  otherwise leave it (the browser's "Retry"/reload covers it) and say so.

## Tests

- `db/projects.test.js` (new, real in-memory SQLite): list filters, soft
  delete / restore / purge (cascade of a comment row), `getProject` vs
  `getProjectAny`.
- `db/review-links.test.js`: session and lookup on a deleted project.
- `routes/projects.test.js`: DELETE role gate + effects (evict + events).
- `routes/org-admin.test.js`: the three owner routes incl. 409 on live purge,
  editor gets 403, other-org project 404.
- `storage.test.js`: `deleteProjectDir` removes the dir; skips a dir outside
  the projects root.

## Feature guide

- `docs/features/projects.md` "Deleting a project": rewrite for the real
  behaviour (trash control, confirm text, who can, what happens to open tabs,
  reviewers and running agents, how to get it back).
- `docs/features/org-admin.md`: new "Deleted projects" section (tab, columns,
  Restore, Delete permanently, what purge removes, irreversibility).
- `docs/features/README.md`: add "deleted projects" to the org-admin row.
