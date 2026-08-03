import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real filesystem, mocked DB: project 1 and 2 are rows whose roots default to
// <projectsRoot>/<id>; project 99 does not exist.
vi.mock('./db.js', () => ({
  query: vi.fn(async (_sql, [id]) => ({
    rows: [1, 2].includes(Number(id)) ? [{ root_path: null }] : [],
  })),
}));

import { config } from './config.js';
import {
  StorageError,
  resolveProjectDir,
  createProjectDir,
  readProjectFile,
  writeProjectFile,
  deleteProjectEntry,
  moveProjectEntry,
  listProjectTree,
  searchProjectFiles,
} from './storage.js';

let root;
let savedProjectsRoot;

beforeEach(async () => {
  savedProjectsRoot = config.agent.projectsRoot;
  root = await mkdtemp(join(tmpdir(), 'kuhn-storage-'));
  config.agent.projectsRoot = root;

  await mkdir(join(root, '1', 'draft'), { recursive: true });
  await writeFile(join(root, '1', 'draft', 'main.md'), '# Title\n\nHello kuhn.\n');
  await mkdir(join(root, '2'), { recursive: true });
  await writeFile(join(root, '2', 'secret.md'), 'project two secret\n');
  await writeFile(join(root, 'outside.txt'), 'outside any project\n');
});

afterEach(async () => {
  config.agent.projectsRoot = savedProjectsRoot;
  await rm(root, { recursive: true, force: true });
});

const expectStorageError = async (promise, code) => {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err, 'expected a rejection').toBeInstanceOf(StorageError);
  expect(err.code).toBe(code);
};

describe('path containment', () => {
  it('rejects .. traversal', async () => {
    await expectStorageError(readProjectFile(1, '../outside.txt'), 'outside_root');
    await expectStorageError(readProjectFile(1, 'draft/../../outside.txt'), 'outside_root');
    await expectStorageError(writeProjectFile(1, '../evil.txt', 'x'), 'outside_root');
    await expectStorageError(deleteProjectEntry(1, '../outside.txt'), 'outside_root');
  });

  it('rejects absolute paths', async () => {
    await expectStorageError(readProjectFile(1, join(root, '1', 'draft', 'main.md')), 'outside_root');
    await expectStorageError(writeProjectFile(1, '/etc/hosts', 'x'), 'outside_root');
  });

  it('rejects cross-project access', async () => {
    await expectStorageError(readProjectFile(1, '../2/secret.md'), 'outside_root');
    await expectStorageError(writeProjectFile(1, '../2/injected.md', 'x'), 'outside_root');
    await expectStorageError(moveProjectEntry(1, 'draft/main.md', '../2/stolen.md'), 'outside_root');
  });

  it('rejects symlinks that resolve outside the project root', async () => {
    await symlink(join(root, 'outside.txt'), join(root, '1', 'link-file'));
    await symlink(join(root, '2'), join(root, '1', 'link-dir'));

    await expectStorageError(readProjectFile(1, 'link-file'), 'outside_root');
    await expectStorageError(readProjectFile(1, 'link-dir/secret.md'), 'outside_root');
    await expectStorageError(writeProjectFile(1, 'link-dir/injected.md', 'x'), 'outside_root');
  });

  it('rejects null bytes and empty paths', async () => {
    await expectStorageError(readProjectFile(1, 'a\0b'), 'invalid_path');
    await expectStorageError(readProjectFile(1, ''), 'invalid_path');
  });

  it('rejects unknown projects', async () => {
    await expectStorageError(readProjectFile(99, 'draft/main.md'), 'not_found');
  });

  it('allows symlinks that stay inside the project root', async () => {
    await symlink(join(root, '1', 'draft', 'main.md'), join(root, '1', 'alias.md'));
    const buf = await readProjectFile(1, 'alias.md');
    expect(buf.toString()).toContain('Hello kuhn');
  });
});

describe('file operations', () => {
  it('reads and writes files, creating parent directories', async () => {
    const { created } = await writeProjectFile(1, 'refs/bib/main.bib', '@article{x}');
    expect(created).toBe(true);
    expect((await readProjectFile(1, 'refs/bib/main.bib')).toString()).toBe('@article{x}');

    const second = await writeProjectFile(1, 'refs/bib/main.bib', '@article{y}');
    expect(second.created).toBe(false);
  });

  it('enforces the file size cap', async () => {
    const saved = config.storage.maxFileBytes;
    config.storage.maxFileBytes = 10;
    try {
      await expectStorageError(writeProjectFile(1, 'big.md', 'x'.repeat(11)), 'too_large');
    } finally {
      config.storage.maxFileBytes = saved;
    }
  });

  it('deletes files and directories but never the root', async () => {
    await deleteProjectEntry(1, 'draft/main.md');
    await expectStorageError(readProjectFile(1, 'draft/main.md'), 'not_found');
    await deleteProjectEntry(1, 'draft');
    await expectStorageError(deleteProjectEntry(1, '.'), 'invalid_path');
    await expectStorageError(deleteProjectEntry(1, 'never-existed.md'), 'not_found');
  });

  it('moves files within the project and refuses to clobber', async () => {
    await moveProjectEntry(1, 'draft/main.md', 'archive/v1.md');
    expect((await readProjectFile(1, 'archive/v1.md')).toString()).toContain('Hello kuhn');
    await writeProjectFile(1, 'a.md', 'a');
    await writeProjectFile(1, 'b.md', 'b');
    await expectStorageError(moveProjectEntry(1, 'a.md', 'b.md'), 'conflict');
  });

  // Story 012-002: every path-keyed consumer is re-keyed from what this
  // returns, so it must be the canonical form, not the caller's spelling.
  it('returns the canonical relative paths it operated on', async () => {
    expect(await moveProjectEntry(1, './draft/main.md', 'archive//v1.md')).toEqual({
      from: 'draft/main.md',
      to: 'archive/v1.md',
    });
    // Trailing slashes on a folder move: normalize() keeps them, resolve() does not.
    expect(await moveProjectEntry(1, 'archive/', 'old/archive/')).toEqual({
      from: 'archive',
      to: 'old/archive',
    });
    expect((await readProjectFile(1, 'old/archive/v1.md')).toString()).toContain('Hello kuhn');
  });

  it('refuses a self-move however it is spelled', async () => {
    await expectStorageError(moveProjectEntry(1, 'draft/main.md', 'draft/main.md'), 'invalid_path');
    await expectStorageError(moveProjectEntry(1, 'draft/main.md', './draft//main.md'), 'invalid_path');
    // Untouched, not silently renamed onto itself.
    expect((await readProjectFile(1, 'draft/main.md')).toString()).toContain('Hello kuhn');
  });

  it('refuses to move a folder into its own descendant, leaving no directories behind', async () => {
    await expectStorageError(moveProjectEntry(1, 'draft', 'draft/sub/draft'), 'invalid_path');
    const tree = await listProjectTree(1, 'draft');
    expect(tree.map((n) => n.name)).toEqual(['main.md']);
    // A sibling whose name merely shares the prefix is still movable.
    await writeProjectFile(1, 'draftive.md', 'x');
    expect(await moveProjectEntry(1, 'draftive.md', 'draft/draftive.md')).toEqual({
      from: 'draftive.md',
      to: 'draft/draftive.md',
    });
  });

  it('lists the tree and omits symlinks', async () => {
    await symlink(join(root, 'outside.txt'), join(root, '1', 'sneaky'));
    const tree = await listProjectTree(1);
    const names = tree.map((n) => n.name);
    expect(names).toContain('draft');
    expect(names).not.toContain('sneaky');
    const draft = tree.find((n) => n.name === 'draft');
    expect(draft.type).toBe('dir');
    expect(draft.children).toEqual([
      expect.objectContaining({ name: 'main.md', path: join('draft', 'main.md'), type: 'file' }),
    ]);
  });

  it('searches file contents with line numbers', async () => {
    await writeProjectFile(1, 'notes.md', 'alpha\nbeta kuhn\ngamma');
    const matches = await searchProjectFiles(1, 'kuhn');
    expect(matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'notes.md', line: 2 }),
        expect.objectContaining({ path: join('draft', 'main.md'), line: 3 }),
      ]),
    );
  });
});

// Story 012-001: the file manager can create folders, so storage needs an
// exported directory-create. The canonical-path contract is the same one
// moveProjectEntry established — the webapp keys tree state by path.
describe('ancestor-is-a-file paths (story 012-005)', () => {
  // `draft/main.md/sub` — a plausible typo, reachable from the folder UI —
  // used to rethrow ENOTDIR bare, which the routes mapped to a 500.
  const expectConflictNaming = async (promise, blocker) => {
    const err = await promise.then(() => null, (e) => e);
    expect(err, 'expected a rejection').toBeInstanceOf(StorageError);
    expect(err.code).toBe('conflict');
    expect(err.message).toContain(blocker);
  };

  it('mkdir under a file is a conflict naming the blocking file', async () => {
    await expectConflictNaming(createProjectDir(1, 'draft/main.md/sub'), 'draft/main.md');
  });

  it('read through a file ancestor is a conflict naming the blocking file', async () => {
    await expectConflictNaming(readProjectFile(1, 'draft/main.md/sub/x.md'), 'draft/main.md');
  });

  it('write through a file ancestor is a conflict, deep or shallow', async () => {
    await expectConflictNaming(writeProjectFile(1, 'draft/main.md/x.md', 'x'), 'draft/main.md');
    await expectConflictNaming(
      writeProjectFile(1, 'draft/main.md/a/b/c.md', 'x'),
      'draft/main.md',
    );
  });

  it('does not loosen containment: traversal and symlink escapes still map as before', async () => {
    await expectStorageError(readProjectFile(1, '../outside.txt'), 'outside_root');
    await symlink(join(root, '2'), join(root, '1', 'sneaky'));
    await expectStorageError(readProjectFile(1, 'sneaky/secret.md'), 'outside_root');
  });
});

describe('createProjectDir (story 012-001)', () => {
  it('creates nested directories in one call', async () => {
    expect(await createProjectDir(1, 'figures/panels')).toEqual({
      path: 'figures/panels',
      created: true,
    });
    const tree = await listProjectTree(1, 'figures');
    expect(tree).toEqual([
      expect.objectContaining({ name: 'panels', type: 'dir', children: [] }),
    ]);
  });

  it('returns the canonical relative path, not the caller\'s spelling', async () => {
    expect(await createProjectDir(1, './x//y/')).toEqual({ path: 'x/y', created: true });
  });

  it('is idempotent: an existing directory is created:false, not a conflict', async () => {
    expect((await createProjectDir(1, 'notes')).created).toBe(true);
    expect(await createProjectDir(1, 'notes')).toEqual({ path: 'notes', created: false });
    // An existing directory that predates the call behaves the same.
    expect(await createProjectDir(1, 'draft')).toEqual({ path: 'draft', created: false });
  });

  it('empty directories survive a re-list (no .keep sentinel needed)', async () => {
    await createProjectDir(1, 'empty');
    const names = (await listProjectTree(1)).map((n) => n.name);
    expect(names).toContain('empty');
    const empty = (await listProjectTree(1)).find((n) => n.name === 'empty');
    expect(empty).toMatchObject({ type: 'dir', children: [] });
  });

  it('refuses to clobber a file that already holds the path', async () => {
    await expectStorageError(createProjectDir(1, 'draft/main.md'), 'conflict');
    // The file is untouched.
    expect((await readProjectFile(1, 'draft/main.md')).toString()).toContain('Hello kuhn');
  });

  it('refuses the project root however it is spelled', async () => {
    await expectStorageError(createProjectDir(1, '.'), 'invalid_path');
    await expectStorageError(createProjectDir(1, 'a/..'), 'invalid_path');
  });

  it('applies the same containment guarantees as its neighbours', async () => {
    await expectStorageError(createProjectDir(1, '../escape'), 'outside_root');
    await expectStorageError(createProjectDir(1, '/etc/kuhn'), 'outside_root');
    await expectStorageError(createProjectDir(1, '../2/injected'), 'outside_root');
    await expectStorageError(createProjectDir(1, '.git/hooks'), 'invalid_path');
    await expectStorageError(createProjectDir(1, 'a\0b'), 'invalid_path');
    await expectStorageError(createProjectDir(1, ''), 'invalid_path');
    await expectStorageError(createProjectDir(99, 'anything'), 'not_found');
  });

  it('makes a fresh folder a legal move destination', async () => {
    await createProjectDir(1, 'archive');
    expect(await moveProjectEntry(1, 'draft/main.md', 'archive/main.md')).toEqual({
      from: 'draft/main.md',
      to: 'archive/main.md',
    });
  });
});

describe('resolveProjectDir', () => {
  it('creates and returns the per-project workspace', async () => {
    const dir = await resolveProjectDir(1);
    expect((await readFile(join(dir, 'draft', 'main.md'))).toString()).toContain('Hello kuhn');
  });

  it('throws not_found for unknown projects', async () => {
    await expectStorageError(resolveProjectDir(99), 'not_found');
  });
});
