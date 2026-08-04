import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Real in-memory SQLite (file-activity.test.js pattern) — the prefix SQL, the
// UNIQUE(project_id, path) collision and the rollback are the substance here,
// so no mocks. Must be set before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync;
let applyMove; let findPendingEditConflicts;
let PROJECT_ID;
const USER_ID = 1;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ applyMove, findPendingEditConflicts } = await import('./move-paths.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
});

beforeEach(() => {
  querySync('DELETE FROM comments');
  querySync('DELETE FROM review_links');
  querySync('DELETE FROM pending_edits');
  querySync('DELETE FROM file_events');
  querySync('DELETE FROM file_seen');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync('DELETE FROM users');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync("INSERT INTO users (id, email, display_name) VALUES (1, 'dev@kuhn.local', 'Dev')");
  const { rows } = querySync(
    `INSERT INTO projects (org_id, name, project_type, config)
     VALUES (1, 'P', 'manuscript', '{}') RETURNING id`,
  );
  PROJECT_ID = rows[0].id;
});

// --- fixtures ---------------------------------------------------------------

const seen = (path) => querySync(
  'INSERT INTO file_seen (user_id, project_id, path) VALUES ($1, $2, $3)',
  [USER_ID, PROJECT_ID, path],
);

const comment = (path, body, parentId = null) => querySync(
  `INSERT INTO comments (project_id, path, parent_id, user_id, body)
   VALUES ($1, $2, $3, $4, $5) RETURNING id`,
  [PROJECT_ID, path, parentId, USER_ID, body],
).rows[0].id;

const pending = (path, proposed = 'proposed') => querySync(
  `INSERT INTO pending_edits
     (project_id, path, base_content, base_hash, base_missing, proposed_content)
   VALUES ($1, $2, '', 'hash', 1, $3) RETURNING id`,
  [PROJECT_ID, path, proposed],
).rows[0].id;

const setActiveDocument = (path) => querySync(
  'UPDATE projects SET config = $2 WHERE id = $1',
  [PROJECT_ID, JSON.stringify({ activeDocument: path, title: 'keep me' })],
);

const reviewLink = (path) => querySync(
  `INSERT INTO review_links (project_id, path, mode, token_hash, created_by, expires_at)
   VALUES ($1, $2, 'comment', $3, $4, '2999-01-01T00:00:00.000Z') RETURNING id`,
  [PROJECT_ID, path, `hash-${path}-${Math.random()}`, USER_ID],
).rows[0].id;

const paths = (table) => querySync(
  `SELECT path FROM ${table} WHERE project_id = $1 ORDER BY path`, [PROJECT_ID],
).rows.map((r) => r.path);

const config = () => JSON.parse(
  querySync('SELECT config FROM projects WHERE id = $1', [PROJECT_ID]).rows[0].config,
);

const events = () => querySync(
  'SELECT path, kind, meta, agent_slug, user_id FROM file_events WHERE project_id = $1 ORDER BY id',
  [PROJECT_ID],
).rows;

// --- tests ------------------------------------------------------------------

describe('applyMove — file move (story 012-002)', () => {
  it('re-keys every path consumer and appends exactly one moved event', () => {
    seen('draft/main.md');
    const root = comment('draft/main.md', 'root');
    comment('draft/main.md', 'reply', root); // replies copy the root's path
    pending('draft/main.md');
    reviewLink('draft/main.md'); // epic 013: links follow their document
    setActiveDocument('draft/main.md');

    const result = applyMove(PROJECT_ID, 'draft/main.md', 'archive/main.md', {
      agentSlug: 'writer', userId: USER_ID,
    });

    expect(result).toMatchObject({
      from: 'draft/main.md',
      to: 'archive/main.md',
      comments: 2,
      pendingEdits: 1,
      activeDocument: 1,
      reviewLinks: 1,
    });
    expect(paths('file_seen')).toEqual(['archive/main.md']);
    expect(paths('comments')).toEqual(['archive/main.md', 'archive/main.md']);
    expect(paths('pending_edits')).toEqual(['archive/main.md']);
    expect(paths('review_links')).toEqual(['archive/main.md']);
    expect(config()).toEqual({ activeDocument: 'archive/main.md', title: 'keep me' });

    expect(events()).toEqual([{
      path: 'archive/main.md',
      kind: 'moved',
      meta: '{"from":"draft/main.md"}',
      agent_slug: 'writer',
      user_id: USER_ID,
    }]);
  });

  it('leaves unrelated rows and a non-matching activeDocument alone', () => {
    comment('draft/other.md', 'untouched');
    seen('draft/other.md');
    setActiveDocument('draft/other.md');

    const result = applyMove(PROJECT_ID, 'draft/main.md', 'archive/main.md');

    expect(result).toMatchObject({ comments: 0, pendingEdits: 0, activeDocument: 0 });
    expect(paths('comments')).toEqual(['draft/other.md']);
    expect(paths('file_seen')).toEqual(['draft/other.md']);
    expect(config().activeDocument).toBe('draft/other.md');
  });

  it('canonicalizes ./, // and trailing slashes before matching', () => {
    comment('sources/protocol.pdf', 'c');
    seen('sources/protocol.pdf');

    const result = applyMove(PROJECT_ID, './sources//protocol.pdf', 'archive/protocol.pdf/');

    expect(result).toMatchObject({
      from: 'sources/protocol.pdf', to: 'archive/protocol.pdf', comments: 1,
    });
    expect(paths('comments')).toEqual(['archive/protocol.pdf']);
    expect(paths('file_seen')).toEqual(['archive/protocol.pdf']);
    expect(events()[0]).toMatchObject({
      path: 'archive/protocol.pdf', meta: '{"from":"sources/protocol.pdf"}',
    });
  });

  it('rejects a self-move and a move into its own descendant', () => {
    expect(() => applyMove(PROJECT_ID, 'dir', './dir')).toThrow(/onto itself/);
    expect(() => applyMove(PROJECT_ID, 'dir', 'dir/sub/dir')).toThrow(/own descendant/);
    expect(() => applyMove(PROJECT_ID, '', 'x.md')).toThrow(/empty/);
    expect(() => applyMove(PROJECT_ID, 'x.md', '../escape.md')).toThrow(/project-relative/);
    expect(events()).toHaveLength(0);
  });
});

describe('applyMove — folder move', () => {
  it('carries the whole subtree and never matches a prefix look-alike', () => {
    seen('dir');
    seen('dir/a.md');
    seen('dir/sub/b.md');
    seen('directive.md');
    comment('dir/a.md', 'a');
    comment('dir/sub/b.md', 'b');
    comment('directive.md', 'decoy');
    pending('dir/a.md');
    pending('directive.md');
    reviewLink('dir/a.md');
    reviewLink('dir/sub/b.md');
    reviewLink('directive.md'); // prefix look-alike stays put
    setActiveDocument('dir/sub/b.md');

    const result = applyMove(PROJECT_ID, 'dir', 'archive/dir');

    expect(result).toMatchObject({ comments: 2, pendingEdits: 1, activeDocument: 1, reviewLinks: 2 });
    expect(paths('review_links')).toEqual([
      'archive/dir/a.md', 'archive/dir/sub/b.md', 'directive.md',
    ]);
    expect(paths('file_seen')).toEqual([
      'archive/dir', 'archive/dir/a.md', 'archive/dir/sub/b.md', 'directive.md',
    ]);
    expect(paths('comments')).toEqual([
      'archive/dir/a.md', 'archive/dir/sub/b.md', 'directive.md',
    ]);
    expect(paths('pending_edits')).toEqual(['archive/dir/a.md', 'directive.md']);
    expect(config().activeDocument).toBe('archive/dir/sub/b.md');

    // ONE event for the folder itself — descendants are implied by prefix.
    expect(events()).toEqual([{
      path: 'archive/dir',
      kind: 'moved',
      meta: '{"from":"dir"}',
      agent_slug: null,
      user_id: null,
    }]);
  });

  it('does not rewrite a repeated segment deeper in the path', () => {
    comment('a/b/x/a/b.md', 'c'); // SQLite replace() would corrupt this one
    applyMove(PROJECT_ID, 'a/b', 'z');
    expect(paths('comments')).toEqual(['z/x/a/b.md']);
  });
});

describe('applyMove — atomicity', () => {
  it('rolls back every table when the event insert fails', () => {
    seen('draft/main.md');
    comment('draft/main.md', 'root');
    pending('draft/main.md');
    reviewLink('draft/main.md');
    setActiveDocument('draft/main.md');

    // userId 4242 has no users row: file_events.user_id's FK rejects the
    // insert AFTER every rewrite above has run inside the transaction.
    expect(() => applyMove(PROJECT_ID, 'draft/main.md', 'archive/main.md', { userId: 4242 }))
      .toThrow();

    expect(paths('file_seen')).toEqual(['draft/main.md']);
    expect(paths('comments')).toEqual(['draft/main.md']);
    expect(paths('pending_edits')).toEqual(['draft/main.md']);
    expect(paths('review_links')).toEqual(['draft/main.md']);
    expect(config().activeDocument).toBe('draft/main.md');
    expect(events()).toHaveLength(0);
  });
});

describe('applyMove — pending_edits collisions and scope', () => {
  it('refuses rather than destroying a proposal already at the destination', () => {
    // The normal case, not an edge case: proposeEdit creates base_missing=1
    // rows for files that do not exist, so storage's destination-exists 409
    // never fires and UPDATE OR REPLACE would silently delete this row.
    pending('draft/notes.md', 'source proposal');
    pending('draft/methods.md', 'the agent only copy');
    comment('draft/notes.md', 'c');

    expect(findPendingEditConflicts(PROJECT_ID, 'draft/notes.md', 'draft/methods.md'))
      .toEqual(['draft/methods.md']);
    expect(() => applyMove(PROJECT_ID, 'draft/notes.md', 'draft/methods.md'))
      .toThrow(/pending edit already exists at draft\/methods.md/);

    // Nothing lost, nothing half-written.
    const rows = querySync(
      'SELECT path, proposed_content FROM pending_edits WHERE project_id = $1 ORDER BY path',
      [PROJECT_ID],
    ).rows;
    expect(rows).toEqual([
      { path: 'draft/methods.md', proposed_content: 'the agent only copy' },
      { path: 'draft/notes.md', proposed_content: 'source proposal' },
    ]);
    expect(paths('comments')).toEqual(['draft/notes.md']);
    expect(events()).toHaveLength(0);
  });

  it('a folder move reports every colliding destination before the rename', () => {
    pending('draft/x/a.md');
    pending('draft/y/a.md');
    expect(findPendingEditConflicts(PROJECT_ID, 'draft/x', 'draft/y')).toEqual(['draft/y/a.md']);
    expect(findPendingEditConflicts(PROJECT_ID, 'draft/x', 'draft/z')).toEqual([]);
  });

  it('a CLEAN source moving onto a waiting proposal clashes too (story 012-005)', () => {
    // The source carries no pending edit, so the source-side walk sees
    // nothing — this leg was missing until files-check caught it live. The
    // arriving bytes would silently become the proposal's base.
    pending('draft/methods.md', 'the agent only copy');
    expect(findPendingEditConflicts(PROJECT_ID, 'draft/notes.md', 'draft/methods.md'))
      .toEqual(['draft/methods.md']);
    // A folder move landing ON or OVER proposals reports them all.
    pending('draft/y/a.md');
    expect(findPendingEditConflicts(PROJECT_ID, 'draft/x', 'draft/y')).toEqual(['draft/y/a.md']);
  });

  it('moves a pending edit that leaves draft/ instead of dropping it, and counts it', () => {
    // proposed_content is the only copy (proposals never hit disk), so the row
    // follows its file; the scope gate belongs at acceptance time.
    pending('draft/notes.md', 'the only copy');
    const result = applyMove(PROJECT_ID, 'draft/notes.md', 'archive/notes.md');

    expect(result).toMatchObject({ pendingEdits: 1, outOfScope: 1 });
    expect(querySync(
      'SELECT path, proposed_content FROM pending_edits WHERE project_id = $1', [PROJECT_ID],
    ).rows).toEqual([{ path: 'archive/notes.md', proposed_content: 'the only copy' }]);
  });

  it('reports outOfScope 0 for a move that stays inside draft/', () => {
    pending('draft/a.md');
    pending('draft/sub/b.md');
    const result = applyMove(PROJECT_ID, 'draft/sub', 'draft/archive/sub');
    expect(result).toMatchObject({ pendingEdits: 1, outOfScope: 0 });
    expect(paths('pending_edits')).toEqual(['draft/a.md', 'draft/archive/sub/b.md']);
  });
});
