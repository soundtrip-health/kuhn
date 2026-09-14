// Shared project memory store (issue #150): bounds, supersede-by-key with
// an immutable chain, human-authored protection, the cap's retire order,
// FTS recall (ranked, filtered, retired rows excluded, no FTS5 syntax
// errors on free text) and project isolation. Real in-memory SQLite.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('../logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const __dirname = dirname(fileURLToPath(import.meta.url));

let memory;
let exec;
let querySync;
let logMock;
const P1 = 1;
const P2 = 2;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ log: logMock } = await import('../logger.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync("INSERT INTO users (id, email, display_name) VALUES (7, 'pi@example.org', 'PI')");
  querySync("INSERT INTO projects (id, name, project_type, org_id) VALUES ($1, 'A', 'manuscript', 1), ($2, 'B', 'manuscript', 1)", [P1, P2]);
  memory = await import('./memory.js');
});

beforeEach(() => {
  querySync('DELETE FROM project_memory');
  vi.clearAllMocks();
});

const write = (over = {}) => memory.remember(P1, { kind: 'fact', body: 'The extract has 38210 rows.', sourceAgent: 'analyst', ...over });

describe('remember', () => {
  it('stores an entry with parsed tags and provenance, and logs memory_write', () => {
    const { entry, superseded } = write({ tags: ['Data', ' nsduh ', 'data'], userId: 7, jobId: null });
    expect(entry).toMatchObject({ project_id: P1, kind: 'fact', key: null, tags: ['data', 'nsduh'], source_agent: 'analyst', user_id: 7, auto: false });
    expect(superseded).toBeNull();
    expect(logMock.info).toHaveBeenCalledWith('memory_write', expect.objectContaining({ id: entry.id, kind: 'fact', agent: 'analyst' }));
  });

  it('enforces the bounds: kind, body, body length, tags, key shape', () => {
    expect(() => write({ kind: 'wish' })).toThrow(/kind must be one of/);
    expect(() => write({ body: '   ' })).toThrow(/body is required/);
    expect(() => write({ body: 'x'.repeat(2049) })).toThrow(/limit is 2048/);
    expect(() => write({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).toThrow(/at most 8 tags/);
    expect(() => write({ tags: ['x'.repeat(41)] })).toThrow(/longer than 40/);
    expect(() => write({ key: 'has space' })).toThrow(/key must be a short slug/);
    expect(() => write({ key: 'task:12/a.b_c-d' })).not.toThrow();
  });

  it('truncates instead of refusing when asked (runtime writes)', () => {
    const { entry } = write({ body: 'line\n'.repeat(1000), truncate: true });
    expect(entry.body.length).toBeLessThanOrEqual(2048);
    expect(entry.body.endsWith('[… truncated]')).toBe(true);
  });

  it('a keyed write supersedes the live entry: new row, old row retired, chain linked, bodies untouched', () => {
    const first = write({ key: 'target-journal', body: 'BMJ' }).entry;
    const { entry: second, superseded } = write({ key: 'target-journal', body: 'JAMA Netw Open', sourceAgent: 'pm' });
    expect(superseded).toBe(first.id);
    expect(second.supersedes_id).toBe(first.id);
    const old = memory.getMemory(P1, first.id);
    expect(old.body).toBe('BMJ');
    expect(old.retired_by).toBe('supersede');
    expect(old.retire_reason).toBe(`superseded by #${second.id}`);
    expect(memory.getLiveByKey(P1, 'target-journal').id).toBe(second.id);
    // The partial unique index holds: exactly one live row per key.
    const live = querySync("SELECT COUNT(*) AS n FROM project_memory WHERE key = 'target-journal' AND retired_at IS NULL").rows[0].n;
    expect(live).toBe(1);
  });

  it('a human-written live entry refuses an agent supersede but accepts a human one', () => {
    const pi = memory.remember(P1, { kind: 'decision', key: 'target-journal', body: 'PI: BMJ', sourceAgent: null, userId: 7 }).entry;
    expect(() => write({ key: 'target-journal', body: 'JAMA', sourceAgent: 'writer' })).toThrow(/written by the user and cannot be overwritten/);
    expect(memory.getLiveByKey(P1, 'target-journal').id).toBe(pi.id);
    const again = memory.remember(P1, { kind: 'decision', key: 'target-journal', body: 'PI: JAMA after all', sourceAgent: null, userId: 7 });
    expect(again.superseded).toBe(pi.id);
  });
});

describe('forget', () => {
  it('retires an entry with attribution; refuses unknown, already-retired and human-written entries for agents', () => {
    const e = write().entry;
    const retired = memory.forget(P1, e.id, { reason: 'obsolete', agent: 'ra' });
    expect(retired.retired_by).toBe('ra');
    expect(retired.retire_reason).toBe('obsolete');
    expect(() => memory.forget(P1, e.id, { agent: 'ra' })).toThrow(/No live memory entry/);
    expect(() => memory.forget(P1, 99999, { agent: 'ra' })).toThrow(/No live memory entry/);
    const human = memory.remember(P1, { kind: 'note', body: 'PI note', sourceAgent: null, userId: 7 }).entry;
    expect(() => memory.forget(P1, human.id, { agent: 'writer' })).toThrow(/cannot be retired by an agent/);
    expect(memory.forget(P1, human.id, { userId: 7 }).retired_by).toBe('user:7');
  });

  it('is project-scoped: another project cannot retire the entry', () => {
    const e = write().entry;
    expect(() => memory.forget(P2, e.id, { agent: 'ra' })).toThrow(/No live memory entry/);
    expect(memory.getMemory(P1, e.id).retired_at).toBeNull();
  });
});

describe('cap', () => {
  it('retires the oldest auto entries first, then keyless notes/task states; decisions and keyed entries survive', () => {
    const d = memory.remember(P1, { kind: 'decision', body: 'keep me', sourceAgent: 'pm' }).entry;
    const keyed = write({ key: 'data-status', body: 'keyed fact' }).entry;
    const auto1 = write({ kind: 'task_state', key: 'task:1', body: 'auto one', auto: true }).entry;
    const auto2 = write({ kind: 'task_state', key: 'task:2', body: 'auto two', auto: true }).entry;
    const note = memory.remember(P1, { kind: 'note', body: 'loose note', sourceAgent: 'ra' }).entry;
    expect(memory.countLive(P1)).toBe(5);
    expect(memory.enforceCap(P1, 3)).toBe(2);
    const liveIds = memory.recall(P1, { limit: 50 }).map((e) => e.id).sort();
    expect(liveIds).toEqual([d.id, keyed.id, note.id].sort());
    expect(memory.getMemory(P1, auto1.id).retired_by).toBe('cap');
    expect(memory.getMemory(P1, auto2.id).retired_by).toBe('cap');
    expect(memory.enforceCap(P1, 2)).toBe(1);
    expect(memory.getMemory(P1, note.id).retired_by).toBe('cap');
    // Nothing disposable left: the cap cannot retire decisions or keyed entries.
    expect(memory.enforceCap(P1, 1)).toBe(0);
    expect(memory.countLive(P1)).toBe(2);
  });
});

describe('recall', () => {
  beforeEach(() => {
    memory.remember(P1, { kind: 'task_state', key: 'task:11', body: 'Removed the 13 corrupted arXiv keys; the reference store audit shows 0 mismatches.', tags: ['ra', 'dispatch'], sourceAgent: 'ra', auto: true });
    memory.remember(P1, { kind: 'decision', key: 'target-journal', body: 'PI chose JAMA Network Open over BMJ.', sourceAgent: null, userId: 7 });
    memory.remember(P1, { kind: 'fact', body: 'The NSDUH extract has 38210 rows after exclusions.', tags: ['data'], sourceAgent: 'analyst' });
    memory.remember(P1, { kind: 'issue', body: 'Reviewer flagged the power calculation in the methods.', tags: ['methods'], sourceAgent: 'reviewer' });
    memory.remember(P2, { kind: 'fact', body: 'Other project: arXiv references are fine.', sourceAgent: 'ra' });
  });

  it('without a query returns newest first, filtered by kind and tags, never crossing projects', () => {
    const all = memory.recall(P1, { limit: 50 });
    expect(all.map((e) => e.kind)).toEqual(['issue', 'fact', 'decision', 'task_state']);
    expect(all.every((e) => e.project_id === P1)).toBe(true);
    expect(memory.recall(P1, { kind: ['decision', 'issue'] }).map((e) => e.kind)).toEqual(['issue', 'decision']);
    expect(memory.recall(P1, { tags: ['data'] })).toHaveLength(1);
    expect(memory.recall(P1, { tags: ['data', 'ra'] })).toHaveLength(0);
    expect(memory.recall(P2, { limit: 50 })).toHaveLength(1);
  });

  it('ranks the entry that shares the task vocabulary first and logs memory_recall', () => {
    const hits = memory.recall(P1, { query: 'Audit the arXiv references in the reference store for corrupted keys' }, { source: 'inject', agent: 'ra', jobId: 5 });
    expect(hits[0].key).toBe('task:11');
    expect(hits.some((h) => h.project_id === P2)).toBe(false);
    expect(logMock.info).toHaveBeenCalledWith('memory_recall', expect.objectContaining({
      source: 'inject', agent: 'ra', jobId: 5, hits: hits.length, ids: hits.map((h) => h.id),
    }));
    expect(logMock.info.mock.calls.find((c) => c[0] === 'memory_recall')[1].terms).toContain('arXiv');
  });

  it('matches stems and keys, and a query of only stopwords falls back to recency', () => {
    expect(memory.recall(P1, { query: 'journal' })[0].key).toBe('target-journal');
    expect(memory.recall(P1, { query: 'exclusion rows' })[0].kind).toBe('fact');
    expect(memory.recall(P1, { query: 'the and of' }).map((e) => e.kind)).toEqual(['issue', 'fact', 'decision', 'task_state']);
  });

  it('never raises an FTS5 syntax error on free text', () => {
    const nasty = [
      'NOT AND OR "unbalanced (paren) col:umn ^caret *star ?q {brace} [x] \\ | `tick` \'quote',
      '((((', '"""', 'a:b:c', '-', '*', 'NEAR(x y)',
    ];
    for (const q of nasty) expect(() => memory.recall(P1, { query: q })).not.toThrow();
  });

  it('excludes retired entries by default, and can list them or everything', () => {
    const t = memory.getLiveByKey(P1, 'task:11');
    memory.forget(P1, t.id, { reason: 'done', agent: 'pm' });
    expect(memory.recall(P1, { query: 'corrupted arXiv keys' })).toHaveLength(0);
    expect(memory.recall(P1, { query: 'corrupted arXiv keys', retired: true })[0].id).toBe(t.id);
    expect(memory.recall(P1, { limit: 50, retired: 'all' })).toHaveLength(4);
    expect(memory.recall(P1, { limit: 50 })).toHaveLength(3);
  });

  it('honours since and exclude', () => {
    const cut = memory.recall(P1, { limit: 50 }).at(-1).created_at;
    const later = memory.recall(P1, { since: cut, limit: 50 });
    expect(later.some((e) => e.key === 'task:11')).toBe(false);
    const ids = memory.recall(P1, { limit: 50 }).map((e) => e.id);
    expect(memory.recall(P1, { limit: 50, exclude: ids.slice(0, 2) })).toHaveLength(2);
  });
});
