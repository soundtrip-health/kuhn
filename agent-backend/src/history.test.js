import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real filesystem + real git; mocked DB. Project 1 exists (default root);
// user 7 is a known user for attribution.
vi.mock('./db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.includes('FROM users')) {
      return {
        rows: Number(params[0]) === 7
          ? [{ email: 'pi@lab.test', display_name: 'Dr. PI' }]
          : [],
      };
    }
    return { rows: [1].includes(Number(params[0])) ? [{ root_path: null }] : [] };
  }),
}));

import { config } from './config.js';
import { commitNow, fileAtVersion, flushProject, listHistory, scheduleCommit } from './history.js';
import { StorageError, listProjectTree, readProjectFile } from './storage.js';

let root;
let savedProjectsRoot;

beforeEach(async () => {
  savedProjectsRoot = config.agent.projectsRoot;
  root = await mkdtemp(join(tmpdir(), 'kuhn-history-'));
  config.agent.projectsRoot = root;
  await mkdir(join(root, '1', 'draft'), { recursive: true });
  await writeFile(join(root, '1', 'draft', 'main.md'), '# v1\n');
});

afterEach(async () => {
  await flushProject(1);
  config.agent.projectsRoot = savedProjectsRoot;
  await rm(root, { recursive: true, force: true });
});

describe('version history (story 008-002)', () => {
  it('creates the repo lazily, commits, and lists versions with attribution', async () => {
    const first = await commitNow(1, { userId: 7, label: 'Save draft/main.md' });
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(root, '1', 'draft', 'main.md'), '# v2\n');
    const second = await commitNow(1, { agent: 'writer', label: 'writer finished (job 3)' });
    expect(second).toMatch(/^[0-9a-f]{40}$/);

    const history = await listHistory(1, 'draft/main.md');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      hash: second, label: 'writer finished (job 3)', agent: 'writer',
    });
    expect(history[1]).toMatchObject({
      hash: first, label: 'Save draft/main.md', authorName: 'Dr. PI', agent: null,
    });
  });

  it('is a no-op when nothing changed', async () => {
    await commitNow(1, { label: 'first' });
    expect(await commitNow(1, { label: 'nothing new' })).toBe(null);
    expect(await listHistory(1)).toHaveLength(1);
  });

  it('returns file content at an old version', async () => {
    const first = await commitNow(1, { label: 'v1' });
    await writeFile(join(root, '1', 'draft', 'main.md'), '# v2\n');
    await commitNow(1, { label: 'v2' });

    expect((await fileAtVersion(1, 'draft/main.md', first)).toString()).toBe('# v1\n');
    await expect(fileAtVersion(1, 'draft/main.md', 'not-a-hash')).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(fileAtVersion(1, 'draft/nope.md', first)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('history scoped to a path excludes commits that did not touch it', async () => {
    await commitNow(1, { label: 'baseline' });
    await writeFile(join(root, '1', 'notes.md'), 'unrelated\n');
    await commitNow(1, { label: 'notes only' });
    const scoped = await listHistory(1, 'draft/main.md');
    expect(scoped.map((h) => h.label)).toEqual(['baseline']);
  });

  it('an empty repo (no commits yet) lists as empty rather than erroring', async () => {
    expect(await listHistory(1)).toEqual([]);
  });

  it('reviewer commits round-trip through listHistory as external (epic 013)', async () => {
    const hash = await commitNow(1, {
      reviewer: { linkId: 5, name: 'Jane R' }, label: 'Save draft/main.md',
    });
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const [entry] = await listHistory(1);
    expect(entry).toMatchObject({
      hash,
      authorName: 'Jane R (external)',
      authorEmail: 'link-5@reviewers.kuhn.local',
      label: 'Save draft/main.md',
      agent: null,
      external: true,
      reviewerLinkId: 5,
    });

    // Member and agent versions stay non-external.
    await writeFile(join(root, '1', 'draft', 'main.md'), '# v2\n');
    await commitNow(1, { userId: 7 });
    await writeFile(join(root, '1', 'draft', 'main.md'), '# v3\n');
    await commitNow(1, { agent: 'writer' });
    const [agentEntry, userEntry] = await listHistory(1);
    expect(agentEntry).toMatchObject({ agent: 'writer', external: false, reviewerLinkId: null });
    expect(userEntry).toMatchObject({ authorName: 'Dr. PI', external: false, reviewerLinkId: null });
  });

  it('reviewer autosaves default their label and win over plain user meta', async () => {
    await commitNow(1, { reviewer: { linkId: 9, name: 'Sam' }, userId: 7 });
    const [entry] = await listHistory(1);
    expect(entry).toMatchObject({
      label: 'External edits',
      authorEmail: 'link-9@reviewers.kuhn.local',
      external: true,
      reviewerLinkId: 9,
    });
  });

  it('a coalesced window with agent meta stays agent-attributed (agent > reviewer)', async () => {
    scheduleCommit(1, { reviewer: { linkId: 3, name: 'Sam' } });
    const hash = await commitNow(1, { agent: 'writer' }); // absorbs the pending window
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const [entry] = await listHistory(1);
    expect(entry).toMatchObject({ agent: 'writer', external: false, label: 'writer edits' });
  });

  it('an explicit reviewer checkpoint beats pending agent meta (013 fix)', async () => {
    scheduleCommit(1, { agent: 'writer' }); // agent touched the same window
    const hash = await commitNow(1, {
      reviewer: { linkId: 3, name: 'Sam' }, reviewerCheckpoint: true, label: 'Save draft/main.md',
    });
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const [entry] = await listHistory(1);
    expect(entry).toMatchObject({
      authorName: 'Sam (external)',
      authorEmail: 'link-3@reviewers.kuhn.local',
      agent: null,
      external: true,
      reviewerLinkId: 3,
      label: 'Save draft/main.md',
    });
  });

  it('the .git directory is invisible to the storage API (008-002 guard)', async () => {
    await commitNow(1, { label: 'creates .git' });
    expect((await lstat(join(root, '1', '.git'))).isDirectory()).toBe(true);

    const tree = await listProjectTree(1);
    expect(tree.some((n) => n.name === '.git')).toBe(false);
    await expect(readProjectFile(1, '.git/HEAD')).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(readProjectFile(1, 'draft/../.git/HEAD')).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(fileAtVersion(1, '.git/HEAD', 'a'.repeat(40))).rejects.toBeInstanceOf(StorageError);
  });
});
