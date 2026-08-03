import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Real in-memory SQLite + real storage against a temp workspace: the diff /
// re-anchor / accept-reject math is the substance here, so only the two side
// effects are mocked — version-history commits (git) and the event hub.
process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('./history.js', () => ({
  commitNow: vi.fn(async () => 'commit-hash'),
  scheduleCommit: vi.fn(),
}));
vi.mock('./project-events.js', () => ({ publishProjectEvent: vi.fn() }));

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync;
let commitNow; let publishProjectEvent;
let isSuggestionPath; let sha256; let computeHunks; let applyHunk; let unapplyHunk;
let proposeEdit; let effectiveContent; let listEdits; let acceptEdit; let rejectEdit;

let root;
let PROJECT_ID;
const USER_ID = 9;

// Fixture: two well-separated changes → two hunks at context 2.
const line = (i) => `line${i}`;
const BASE = Array.from({ length: 14 }, (_, i) => line(i + 1)).join('\n') + '\n';
const PROPOSED = BASE.replace('line2', 'LINE2').replace('line12', 'LINE12');

beforeAll(async () => {
  ({ exec, querySync } = await import('./db.js'));
  exec(readFileSync(resolve(__dirname, 'db', 'schema.sql'), 'utf-8'));
  ({ commitNow } = await import('./history.js'));
  ({ publishProjectEvent } = await import('./project-events.js'));
  ({
    isSuggestionPath, sha256, computeHunks, applyHunk, unapplyHunk,
    proposeEdit, effectiveContent, listEdits, acceptEdit, rejectEdit,
  } = await import('./pending-edits.js'));
  root = await mkdtemp(join(tmpdir(), 'kuhn-pending-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  querySync('DELETE FROM pending_edits');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  const dir = await mkdtemp(join(root, 'p-'));
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type, root_path) VALUES (1, 'P', 'manuscript', $1) RETURNING id",
    [dir],
  );
  PROJECT_ID = rows[0].id;
  querySync("INSERT INTO jobs (id, role, input, project_id) VALUES (42, 'writer', 'x', $1)", [PROJECT_ID]);
  await mkdir(join(dir, 'draft'), { recursive: true });
  await writeFile(join(dir, 'draft', 'main.md'), BASE);
});

const diskContent = async (path = 'draft/main.md') => {
  const { rows } = querySync('SELECT root_path FROM projects WHERE id = $1', [PROJECT_ID]);
  return readFile(join(rows[0].root_path, path), 'utf-8');
};

const propose = (over = {}) => proposeEdit(PROJECT_ID, {
  path: 'draft/main.md', proposedContent: PROPOSED, agentSlug: 'writer', jobId: 42, ...over,
});

// --- Scope rule ---------------------------------------------------------------

describe('isSuggestionPath (story 008-001)', () => {
  it('matches on the leading path segment exactly', () => {
    expect(isSuggestionPath('draft/main.md')).toBe(true);
    expect(isSuggestionPath('draft/sections/intro.md')).toBe(true);
    expect(isSuggestionPath('draft')).toBe(true);
    expect(isSuggestionPath('draft-notes/x.md')).toBe(false);
    expect(isSuggestionPath('research/summary.md')).toBe(false);
    expect(isSuggestionPath('pm/status.md')).toBe(false);
    expect(isSuggestionPath('drafts/main.md')).toBe(false);
  });

  it('normalizes before matching — no dodging or smuggling with dot segments', () => {
    expect(isSuggestionPath('./draft/main.md')).toBe(true);
    expect(isSuggestionPath('research/../draft/main.md')).toBe(true);
    expect(isSuggestionPath('draft/../research/x.md')).toBe(false);
    expect(isSuggestionPath('../draft/main.md')).toBe(false);
    expect(isSuggestionPath('')).toBe(false);
    expect(isSuggestionPath(null)).toBe(false);
  });
});

// --- Hunk math ----------------------------------------------------------------

describe('hunk computation and single-hunk apply/un-apply', () => {
  it('derives context-2 hunks with index and a content hash', () => {
    const hunks = computeHunks(BASE, PROPOSED);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ index: 0, oldStart: 1 });
    expect(hunks[0].lines).toEqual([' line1', '-line2', '+LINE2', ' line3', ' line4']);
    expect(hunks[1]).toMatchObject({ index: 1 });
    expect(hunks[1].lines).toContain('-line12');
    for (const h of hunks) {
      expect(h.hash).toBe(sha256(h.lines.join('\n')));
      expect(h.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(computeHunks(BASE, BASE)).toEqual([]);
  });

  it('applyHunk applies exactly one hunk to the base side', () => {
    const [h0, h1] = computeHunks(BASE, PROPOSED);
    expect(applyHunk(BASE, h0)).toBe(BASE.replace('line2', 'LINE2'));
    expect(applyHunk(BASE, h1)).toBe(BASE.replace('line12', 'LINE12'));
    expect(applyHunk('unrelated\ncontent\n', h0)).toBe(false);
  });

  it('unapplyHunk removes exactly one hunk from the proposed side', () => {
    const [h0, h1] = computeHunks(BASE, PROPOSED);
    expect(unapplyHunk(PROPOSED, h0)).toBe(BASE.replace('line12', 'LINE12'));
    expect(unapplyHunk(PROPOSED, h1)).toBe(BASE.replace('line2', 'LINE2'));
  });
});

// --- Propose / effective content ----------------------------------------------

describe('proposeEdit', () => {
  it('captures the disk base and returns the REST edit shape', async () => {
    const edit = await propose();
    expect(edit).toMatchObject({
      path: 'draft/main.md', agent: 'writer', jobId: 42,
      stale: false, baseMissing: false, proposedContent: PROPOSED,
    });
    expect(edit.baseContent).toBeUndefined(); // fresh rows carry hunks, not the base blob
    expect(edit.hunks).toHaveLength(2);
    expect(typeof edit.createdAt).toBe('string');
    expect(await diskContent()).toBe(BASE); // the file's bytes never changed
  });

  it('a proposal for a file that does not exist yet sets baseMissing', async () => {
    const edit = await propose({ path: 'draft/new-section.md', proposedContent: 'a\nb\n' });
    expect(edit).toMatchObject({ baseMissing: true, stale: false });
    expect(edit.hunks).toHaveLength(1);
    expect(edit.hunks[0].lines).toEqual(['+a', '+b']);
  });

  it('coalesces proposals per path: base stays from the first, proposed replaced', async () => {
    const first = await propose();
    await writeFile(join((querySync('SELECT root_path FROM projects WHERE id = $1', [PROJECT_ID])).rows[0].root_path, 'draft', 'main.md'), BASE); // unchanged disk
    const second = await propose({ proposedContent: BASE.replace('line2', 'REVISED2'), agentSlug: 'reviewer', jobId: null });
    expect(second.id).toBe(first.id);
    expect(second.agent).toBe('reviewer');
    expect(second.hunks).toHaveLength(1);
    expect(second.hunks[0].lines).toContain('+REVISED2');
  });

  it('rejects out-of-scope paths with invalid_path (→ 400)', async () => {
    await expect(propose({ path: 'research/notes.md' }))
      .rejects.toMatchObject({ name: 'StorageError', code: 'invalid_path' });
  });

  it('effectiveContent prefers the pending proposal over the disk file', async () => {
    expect(await effectiveContent(PROJECT_ID, 'draft/main.md')).toBe(BASE);
    await propose();
    expect(await effectiveContent(PROJECT_ID, 'draft/main.md')).toBe(PROPOSED);
  });
});

// --- Staleness / re-anchor ----------------------------------------------------

describe('listEdits staleness and re-anchor', () => {
  const overwriteDisk = async (content) => {
    const { rows } = querySync('SELECT root_path FROM projects WHERE id = $1', [PROJECT_ID]);
    await writeFile(join(rows[0].root_path, 'draft', 'main.md'), content);
  };

  it('returns fresh rows untouched while the base still matches the disk', async () => {
    await propose();
    const [edit] = await listEdits(PROJECT_ID);
    expect(edit).toMatchObject({ stale: false });
    expect(edit.hunks).toHaveLength(2);
  });

  it('re-anchors cleanly when the user edited away from the hunks', async () => {
    await propose();
    const drifted = BASE.replace('line7', 'user edit 7');
    await overwriteDisk(drifted);
    const [edit] = await listEdits(PROJECT_ID);
    expect(edit.stale).toBe(false);
    expect(edit.proposedContent).toBe(drifted.replace('line2', 'LINE2').replace('line12', 'LINE12'));
    expect(edit.hunks).toHaveLength(2); // both hunks survive, rebased on the new base
  });

  it('marks the row stale when the user edit collides with a hunk', async () => {
    await propose();
    await overwriteDisk(BASE.replace('line2', 'user took this line'));
    const [edit] = await listEdits(PROJECT_ID);
    expect(edit.stale).toBe(true);
    // Stale rows carry both blobs inline for side-by-side review.
    expect(edit.baseContent).toBe(BASE);
    expect(edit.proposedContent).toBe(PROPOSED);
  });

  it('deletes a row that resolved itself (user applied the proposal by hand)', async () => {
    await propose();
    await overwriteDisk(PROPOSED);
    expect(await listEdits(PROJECT_ID)).toEqual([]);
    expect(querySync('SELECT * FROM pending_edits').rows).toEqual([]);
  });

  it('filters by path', async () => {
    await propose();
    await propose({ path: 'draft/other.md', proposedContent: 'x\n' });
    expect((await listEdits(PROJECT_ID, { path: 'draft/other.md' })).map((e) => e.path))
      .toEqual(['draft/other.md']);
  });
});

// --- Accept -------------------------------------------------------------------

describe('acceptEdit', () => {
  it('accept-all writes the proposal, deletes the row, publishes and commits', async () => {
    const edit = await propose();
    const result = await acceptEdit(PROJECT_ID, edit.id, { userId: USER_ID });
    expect(result).toEqual({ applied: true, remaining: 0 });
    expect(await diskContent()).toBe(PROPOSED);
    expect(await listEdits(PROJECT_ID)).toEqual([]);
    expect(publishProjectEvent).toHaveBeenCalledWith(PROJECT_ID, {
      type: 'file_change', agent: 'writer', path: 'draft/main.md', kind: 'update',
    }, { jobId: 42, userId: USER_ID });
    expect(commitNow).toHaveBeenCalledWith(PROJECT_ID, {
      agent: 'writer', userId: USER_ID, label: 'Accept suggestion on draft/main.md (job 42)',
    });
  });

  it('refuses a row whose file was moved out of draft/ (story 012-002)', async () => {
    // proposeEdit gates on isSuggestionPath, but a move re-keys pending_edits
    // (db/move-paths.js), so a row's path can leave draft/ after the fact.
    // Accepting it would write outside the suggestion scope — a path the agent
    // could never have proposed into directly.
    const edit = await propose();
    querySync('UPDATE pending_edits SET path = $2 WHERE id = $1', [edit.id, 'archive/main.md']);
    await expect(acceptEdit(PROJECT_ID, edit.id, { userId: USER_ID }))
      .rejects.toMatchObject({ code: 'invalid_path' });
    // Nothing written, and the untouched original is still on disk.
    expect(await diskContent()).toBe(BASE);
    await expect(diskContent('archive/main.md')).rejects.toThrow();
  });

  it("a base-missing accept publishes kind 'create'", async () => {
    const edit = await propose({ path: 'draft/new.md', proposedContent: 'fresh\n' });
    await acceptEdit(PROJECT_ID, edit.id, { userId: USER_ID });
    expect(await diskContent('draft/new.md')).toBe('fresh\n');
    expect(publishProjectEvent).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
      kind: 'create', path: 'draft/new.md',
    }), expect.anything());
  });

  it('accepts one hunk: the file gains just that change; the rest stays pending', async () => {
    const edit = await propose();
    const result = await acceptEdit(PROJECT_ID, edit.id, {
      hunk: { index: 0, hash: edit.hunks[0].hash }, userId: USER_ID,
    });
    expect(result.applied).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.edit.hunks).toHaveLength(1);
    expect(result.edit.hunks[0].lines).toContain('+LINE12');
    expect(await diskContent()).toBe(BASE.replace('line2', 'LINE2'));
    expect(commitNow).toHaveBeenCalledTimes(1);

    // Accepting the last hunk resolves the row entirely.
    const last = await acceptEdit(PROJECT_ID, edit.id, {
      hunk: { index: 0, hash: result.edit.hunks[0].hash }, userId: USER_ID,
    });
    expect(last).toEqual({ applied: true, remaining: 0 });
    expect(await diskContent()).toBe(PROPOSED);
    expect(await listEdits(PROJECT_ID)).toEqual([]);
  });

  it('409s a hunk whose index/hash no longer matches (race guard)', async () => {
    const edit = await propose();
    await expect(acceptEdit(PROJECT_ID, edit.id, { hunk: { index: 0, hash: 'deadbeef' } }))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(acceptEdit(PROJECT_ID, edit.id, { hunk: { index: 5, hash: edit.hunks[0].hash } }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await diskContent()).toBe(BASE); // nothing written
  });

  it('409s a stale row unless force, which replaces the whole file', async () => {
    const edit = await propose();
    const { rows } = querySync('SELECT root_path FROM projects WHERE id = $1', [PROJECT_ID]);
    await writeFile(join(rows[0].root_path, 'draft', 'main.md'), BASE.replace('line2', 'collision'));

    await expect(acceptEdit(PROJECT_ID, edit.id, { userId: USER_ID }))
      .rejects.toMatchObject({ code: 'conflict' });

    const result = await acceptEdit(PROJECT_ID, edit.id, { force: true, userId: USER_ID });
    expect(result).toEqual({ applied: true, remaining: 0 });
    expect(await diskContent()).toBe(PROPOSED);
    expect(await listEdits(PROJECT_ID)).toEqual([]);
  });

  it('404s an unknown edit id', async () => {
    await expect(acceptEdit(PROJECT_ID, 999)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('treats a self-resolved row as already applied', async () => {
    const edit = await propose();
    const { rows } = querySync('SELECT root_path FROM projects WHERE id = $1', [PROJECT_ID]);
    await writeFile(join(rows[0].root_path, 'draft', 'main.md'), PROPOSED);
    expect(await acceptEdit(PROJECT_ID, edit.id, { userId: USER_ID }))
      .toEqual({ applied: true, remaining: 0 });
    expect(commitNow).not.toHaveBeenCalled(); // nothing to write
  });
});

// --- Reject -------------------------------------------------------------------

describe('rejectEdit', () => {
  it('reject-all deletes the row, leaves the file untouched, and publishes only a proposed event', async () => {
    const edit = await propose();
    const result = await rejectEdit(PROJECT_ID, edit.id, { userId: USER_ID });
    expect(result).toEqual({ rejected: true, remaining: 0 });
    expect(await diskContent()).toBe(BASE);
    expect(await listEdits(PROJECT_ID)).toEqual([]);
    expect(commitNow).not.toHaveBeenCalled();
    expect(publishProjectEvent).toHaveBeenCalledWith(PROJECT_ID, {
      type: 'file_change', agent: 'writer', path: 'draft/main.md', kind: 'proposed',
    }, { jobId: 42, userId: USER_ID });
  });

  it('rejects one hunk: the proposal loses it, the file and the other hunk stay', async () => {
    const edit = await propose();
    const result = await rejectEdit(PROJECT_ID, edit.id, {
      hunk: { index: 0, hash: edit.hunks[0].hash }, userId: USER_ID,
    });
    expect(result.rejected).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.edit.proposedContent).toBe(BASE.replace('line12', 'LINE12'));
    expect(await diskContent()).toBe(BASE);

    // Rejecting the last hunk deletes the row.
    const last = await rejectEdit(PROJECT_ID, edit.id, {
      hunk: { index: 0, hash: result.edit.hunks[0].hash }, userId: USER_ID,
    });
    expect(last).toEqual({ rejected: true, remaining: 0 });
    expect(await listEdits(PROJECT_ID)).toEqual([]);
  });

  it('409s hunk races and per-hunk rejects on stale rows', async () => {
    const edit = await propose();
    await expect(rejectEdit(PROJECT_ID, edit.id, { hunk: { index: 0, hash: 'deadbeef' } }))
      .rejects.toMatchObject({ code: 'conflict' });

    const { rows } = querySync('SELECT root_path FROM projects WHERE id = $1', [PROJECT_ID]);
    await writeFile(join(rows[0].root_path, 'draft', 'main.md'), BASE.replace('line2', 'collision'));
    await expect(rejectEdit(PROJECT_ID, edit.id, { hunk: { index: 0, hash: edit.hunks[0].hash } }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('404s an unknown edit id', async () => {
    await expect(rejectEdit(PROJECT_ID, 999)).rejects.toMatchObject({ code: 'not_found' });
  });
});
