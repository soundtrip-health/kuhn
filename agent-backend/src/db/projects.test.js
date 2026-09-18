// Issue #190: project soft delete / restore / purge. Real in-memory SQLite —
// the substance is the deleted_at filter on every live read and the cascade
// on purge, so no mocks.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync;
let projects;
const USER = 5;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  projects = await import('./projects.js');
});

beforeEach(() => {
  for (const table of ['comments', 'projects', 'memberships', 'users', 'organizations']) {
    querySync(`DELETE FROM ${table}`);
  }
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org'), (2, 'Other', 'other')");
  querySync(
    "INSERT INTO users (id, email, display_name) VALUES ($1, 'pi@lab.test', 'Dr. PI')", [USER],
  );
  querySync("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, 1, 'editor')", [USER]);
});

const insert = (name, orgId = 1) => querySync(
  "INSERT INTO projects (org_id, name, project_type) VALUES ($1, $2, 'manuscript') RETURNING id",
  [orgId, name],
).rows[0].id;

describe('soft delete', () => {
  it('stamps deleted_at/deleted_by and hides the project from every live read', async () => {
    const a = insert('A');
    const b = insert('B');
    const before = Date.now();
    const row = await projects.softDeleteProject(a, { userId: USER });
    expect(row.id).toBe(a);
    expect(row.deleted_by).toBe(USER);
    expect(new Date(row.deleted_at).getTime()).toBeGreaterThanOrEqual(before - 1000);

    expect(await projects.getProject(a)).toBeUndefined();
    expect((await projects.getProjectAny(a)).deleted_at).toBe(row.deleted_at);
    expect((await projects.listOrgProjects(1)).map((p) => p.id)).toEqual([b]);
    expect((await projects.listProjectsForUser(USER)).map((p) => p.id)).toEqual([b]);
  });

  it('is a no-op on an already-deleted or unknown project', async () => {
    const a = insert('A');
    expect(await projects.softDeleteProject(a, { userId: USER })).toBeTruthy();
    expect(await projects.softDeleteProject(a, { userId: USER })).toBeUndefined();
    expect(await projects.softDeleteProject(999, { userId: USER })).toBeUndefined();
  });

  it('lists an org\'s deleted projects newest first with the deleter', async () => {
    const a = insert('A');
    const b = insert('B');
    const other = insert('Elsewhere', 2);
    await projects.softDeleteProject(a, { userId: USER });
    await projects.softDeleteProject(other, { userId: USER });
    querySync("UPDATE projects SET deleted_at = '2030-01-01T00:00:00.000Z' WHERE id = $1", [a]);
    await projects.softDeleteProject(b, { userId: null });
    const rows = await projects.listDeletedOrgProjects(1);
    expect(rows.map((p) => p.id)).toEqual([a, b]); // a's stamp is later
    expect(rows[0].deleted_by).toEqual({ id: USER, display_name: 'Dr. PI', email: 'pi@lab.test' });
    expect(rows[1].deleted_by).toBeNull();
    expect(rows[0].config).toEqual({}); // parsed like every other listing
  });
});

describe('restore', () => {
  it('clears the stamp; the project is live again', async () => {
    const a = insert('A');
    await projects.softDeleteProject(a, { userId: USER });
    const row = await projects.restoreProject(a);
    expect(row.deleted_at).toBeNull();
    expect(row.deleted_by).toBeNull();
    expect((await projects.getProject(a)).id).toBe(a);
    expect(await projects.listDeletedOrgProjects(1)).toEqual([]);
  });

  it('returns nothing for a live or unknown project', async () => {
    const a = insert('A');
    expect(await projects.restoreProject(a)).toBeUndefined();
    expect(await projects.restoreProject(999)).toBeUndefined();
  });
});

describe('purge', () => {
  it('removes the row and cascades child rows', async () => {
    const a = insert('A');
    querySync("INSERT INTO comments (project_id, path, body) VALUES ($1, 'draft/main.md', 'hi')", [a]);
    await projects.softDeleteProject(a, { userId: USER });
    expect(await projects.purgeProject(a)).toBe(true);
    expect(await projects.getProjectAny(a)).toBeUndefined();
    expect(querySync('SELECT count(*) AS n FROM comments WHERE project_id = $1', [a]).rows[0].n).toBe(0);
    expect(await projects.purgeProject(a)).toBe(false);
  });
});
