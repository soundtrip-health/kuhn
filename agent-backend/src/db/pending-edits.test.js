import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Real in-memory SQLite (file-activity.test.js pattern) — the upsert/coalesce
// SQL is the substance here. Must be set before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync;
let upsertPendingEdit; let getPendingEdit; let getPendingEditByPath;
let listPendingEdits; let updatePendingEdit; let deletePendingEdit;
let PROJECT_ID;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({
    upsertPendingEdit, getPendingEdit, getPendingEditByPath,
    listPendingEdits, updatePendingEdit, deletePendingEdit,
  } = await import('./pending-edits.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
});

beforeEach(() => {
  querySync('DELETE FROM pending_edits');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id",
  );
  PROJECT_ID = rows[0].id;
  querySync("INSERT INTO jobs (id, role, input, project_id) VALUES (9, 'writer', 'x', $1)", [PROJECT_ID]);
});

const propose = (over = {}) => upsertPendingEdit(PROJECT_ID, {
  path: 'draft/main.md',
  baseContent: 'original\n',
  baseHash: 'hash-original',
  baseMissing: false,
  proposedContent: 'proposed\n',
  agentSlug: 'writer',
  jobId: null,
  ...over,
});

describe('pending edits store (story 008-001)', () => {
  it('inserts a row and reads it back by id and by path', () => {
    const row = propose();
    expect(row).toMatchObject({
      project_id: PROJECT_ID,
      path: 'draft/main.md',
      base_content: 'original\n',
      base_hash: 'hash-original',
      base_missing: 0,
      proposed_content: 'proposed\n',
      agent_slug: 'writer',
      stale: 0,
    });
    expect(getPendingEdit(PROJECT_ID, row.id)).toMatchObject({ id: row.id });
    expect(getPendingEditByPath(PROJECT_ID, 'draft/main.md')).toMatchObject({ id: row.id });
    expect(getPendingEdit(PROJECT_ID + 1, row.id)).toBeUndefined(); // project-scoped
  });

  it('coalesces a second proposal to the same path: proposed replaced, base preserved', () => {
    const first = propose();
    const second = propose({
      baseContent: 'LATER DISK CONTENT\n', // ignored on conflict
      baseHash: 'hash-later',
      proposedContent: 'proposed v2\n',
      agentSlug: 'reviewer',
      jobId: 9,
    });
    expect(second.id).toBe(first.id); // one row per (project, path)
    expect(second).toMatchObject({
      base_content: 'original\n',
      base_hash: 'hash-original',
      proposed_content: 'proposed v2\n',
      agent_slug: 'reviewer',
      job_id: 9,
    });
    expect(listPendingEdits(PROJECT_ID)).toHaveLength(1);
  });

  it('lists per project, oldest first, with an optional path filter', () => {
    propose({ path: 'draft/a.md' });
    propose({ path: 'draft/b.md' });
    expect(listPendingEdits(PROJECT_ID).map((r) => r.path)).toEqual(['draft/a.md', 'draft/b.md']);
    expect(listPendingEdits(PROJECT_ID, { path: 'draft/b.md' }).map((r) => r.path)).toEqual(['draft/b.md']);
    expect(listPendingEdits(PROJECT_ID + 1)).toEqual([]);
  });

  it('updates only the provided fields (rebase shape)', () => {
    const row = propose();
    const updated = updatePendingEdit(row.id, {
      baseContent: 'rebased\n', baseHash: 'hash-rebased', baseMissing: true, stale: true,
    });
    expect(updated).toMatchObject({
      base_content: 'rebased\n',
      base_hash: 'hash-rebased',
      base_missing: 1,
      stale: 1,
      proposed_content: 'proposed\n', // untouched
    });
    expect(updatePendingEdit(row.id, {})).toBeUndefined(); // nothing to change
  });

  it('deletes a row', () => {
    const row = propose();
    deletePendingEdit(row.id);
    expect(getPendingEdit(PROJECT_ID, row.id)).toBeUndefined();
  });
});
