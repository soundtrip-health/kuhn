// Issue #65 (PLA-255): the catalog reader's containment + manifest validation,
// and seedKnowledgeCatalog's idempotency / availability / never-delete rules.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

let config; let exec; let querySync;
let catalogFileExists; let loadCatalogManifest; let readCatalogFile;
let resolveCatalogFile; let validateCatalogManifest; let CatalogError;
let seedKnowledgeCatalog;

let root;          // temp catalog root the tests control
let savedRoot;
let outsideFile;   // a real file OUTSIDE the root, for escape attempts

const MANIFEST = {
  catalog_version: 1,
  packages: [
    {
      id: 'writing',
      title: 'Writing',
      parent: null,
      description: 'Prose.',
      items: [
        { id: 'writing/style', title: 'Style', path: 'writing/style.md',
          version: 1, kind: 'document', tags: ['style'] },
        { id: 'writing/absent', title: 'Absent', path: 'writing/absent.md',
          version: 2, kind: 'knowledge-card' },
      ],
    },
    { id: 'bio', title: 'Bio', parent: null, items: [] },
    { id: 'bio-reg', title: 'Regulatory', parent: 'bio', items: [] },
  ],
};

const writeManifest = (manifest) =>
  writeFile(join(root, 'catalog.json'), JSON.stringify(manifest));

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  ({ exec, querySync } = await import('../db.js'));
  ({
    CatalogError, catalogFileExists, loadCatalogManifest, readCatalogFile,
    resolveCatalogFile, validateCatalogManifest,
  } = await import('./knowledge-catalog.js'));
  ({ seedKnowledgeCatalog } = await import('./seed.js'));

  root = await mkdtemp(join(tmpdir(), 'kuhn-catalog-'));
  savedRoot = config.knowledge.catalogRoot;
  config.knowledge.catalogRoot = root;

  await mkdir(join(root, 'writing'), { recursive: true });
  await writeFile(join(root, 'writing', 'style.md'), '# Style\n');
  outsideFile = join(tmpdir(), 'kuhn-catalog-outside.md');
  await writeFile(outsideFile, 'outside the root');

  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  exec(readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf-8'));
});

afterAll(async () => {
  config.knowledge.catalogRoot = savedRoot;
  await rm(root, { recursive: true, force: true });
  await rm(outsideFile, { force: true });
});

describe('resolveCatalogFile containment', () => {
  it('accepts relative paths inside the root', () => {
    expect(resolveCatalogFile('writing/style.md')).toBe(join(root, 'writing', 'style.md'));
  });

  it.each([
    ['..', 'outside_root'],
    ['../secrets.md', 'outside_root'],
    ['writing/../../escape.md', 'outside_root'],
    ['/etc/passwd', 'outside_root'],
    ['', 'invalid_path'],
    ['writing/\0style.md', 'invalid_path'],
  ])('rejects %j', (path, code) => {
    let err;
    try { resolveCatalogFile(path); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CatalogError);
    expect(err.code).toBe(code);
  });

  it('readCatalogFile refuses a symlink that escapes the root', async () => {
    await symlink(outsideFile, join(root, 'writing', 'sneaky.md'));
    await expect(readCatalogFile('writing/sneaky.md'))
      .rejects.toMatchObject({ code: 'outside_root' });
    // But existence checks and reads of real files still work.
    expect(await catalogFileExists('writing/style.md')).toBe(true);
    expect(await catalogFileExists('writing/absent.md')).toBe(false);
    expect((await readCatalogFile('writing/style.md')).toString()).toBe('# Style\n');
  });

  it('catalogFileExists shares the read confinement: available ⇔ legally readable', async () => {
    // Normal in-root file → available.
    expect(await catalogFileExists('writing/style.md')).toBe(true);
    // Missing file → unavailable.
    expect(await catalogFileExists('writing/absent.md')).toBe(false);
    // A symlink resolving outside the root → unavailable AND never readable:
    // what the availability check reports must match what a read would allow.
    expect(await catalogFileExists('writing/sneaky.md')).toBe(false);
    await expect(readCatalogFile('writing/sneaky.md'))
      .rejects.toMatchObject({ code: 'outside_root' });
    // An in-root symlink to an in-root file stays fine both ways.
    await symlink(join(root, 'writing', 'style.md'), join(root, 'writing', 'alias.md'));
    expect(await catalogFileExists('writing/alias.md')).toBe(true);
    expect((await readCatalogFile('writing/alias.md')).toString()).toBe('# Style\n');
  });
});

describe('manifest loading and validation', () => {
  it('returns null when catalog.json is absent', async () => {
    expect(await loadCatalogManifest()).toBeNull();
  });

  it('throws invalid_manifest on malformed JSON', async () => {
    await writeFile(join(root, 'catalog.json'), '{ nope');
    await expect(loadCatalogManifest()).rejects.toMatchObject({ code: 'invalid_manifest' });
  });

  it('loads and validates a good manifest', async () => {
    await writeManifest(MANIFEST);
    const manifest = await loadCatalogManifest();
    expect(manifest.catalog_version).toBe(1);
    expect(manifest.packages).toHaveLength(3);
  });

  it.each([
    ['catalog_version missing', { packages: [] }],
    ['packages not an array', { catalog_version: 1, packages: {} }],
    ['bad package id', { catalog_version: 1, packages: [{ id: 'Bad Slug!', title: 'x', items: [] }] }],
    ['duplicate package id', { catalog_version: 1, packages: [
      { id: 'a', title: 'x', items: [] }, { id: 'a', title: 'y', items: [] }] }],
    ['parent declared later', { catalog_version: 1, packages: [
      { id: 'child', title: 'x', parent: 'parent', items: [] },
      { id: 'parent', title: 'y', items: [] }] }],
    ['item id not package-scoped', { catalog_version: 1, packages: [
      { id: 'a', title: 'x', items: [
        { id: 'other/slug', title: 't', path: 'a/f.md', version: 1, kind: 'document' }] }] }],
    ['bad kind', { catalog_version: 1, packages: [
      { id: 'a', title: 'x', items: [
        { id: 'a/f', title: 't', path: 'a/f.md', version: 1, kind: 'blog-post' }] }] }],
    ['non-integer version', { catalog_version: 1, packages: [
      { id: 'a', title: 'x', items: [
        { id: 'a/f', title: 't', path: 'a/f.md', version: 1.5, kind: 'document' }] }] }],
    ['escaping item path', { catalog_version: 1, packages: [
      { id: 'a', title: 'x', items: [
        { id: 'a/f', title: 't', path: '../f.md', version: 1, kind: 'document' }] }] }],
  ])('rejects a manifest with %s', (_label, manifest) => {
    expect(() => validateCatalogManifest(manifest)).toThrow(CatalogError);
  });
});

describe('seedKnowledgeCatalog', () => {
  const packages = () =>
    querySync('SELECT * FROM knowledge_packages ORDER BY sort_order').rows;
  const items = () => querySync('SELECT * FROM knowledge_items ORDER BY id').rows;

  it('seeds packages and items, marking missing content unavailable', async () => {
    await writeManifest(MANIFEST);
    await seedKnowledgeCatalog();

    expect(packages()).toMatchObject([
      { id: 'writing', parent_id: null, available: 1, sort_order: 0 },
      { id: 'bio', parent_id: null, available: 1 },       // empty stays available
      { id: 'bio-reg', parent_id: 'bio', available: 1 },
    ]);
    expect(items()).toMatchObject([
      { id: 'writing/absent', available: 0, version: 2 }, // file missing on disk
      { id: 'writing/style', available: 1, kind: 'document', tags: '["style"]' },
    ]);
  });

  it('re-seeds idempotently and applies updates', async () => {
    const bumped = structuredClone(MANIFEST);
    bumped.packages[0].items[0].version = 3;
    await writeManifest(bumped);
    await seedKnowledgeCatalog();
    await seedKnowledgeCatalog(); // twice — still one row each

    expect(items().filter((i) => i.id === 'writing/style'))
      .toMatchObject([{ version: 3, available: 1 }]);
    expect(packages()).toHaveLength(3);
  });

  it('marks rows unavailable when they leave the manifest, never deletes', async () => {
    const shrunk = structuredClone(MANIFEST);
    shrunk.packages = [shrunk.packages[0]];          // drop bio + bio-reg
    shrunk.packages[0].items.pop();                  // drop writing/absent
    await writeManifest(shrunk);
    await seedKnowledgeCatalog();

    expect(packages()).toMatchObject([
      { id: 'writing', available: 1 },
      { id: 'bio', available: 0 },
      { id: 'bio-reg', available: 0 },
    ]);
    expect(items()).toMatchObject([
      { id: 'writing/absent', available: 0 },
      { id: 'writing/style', available: 1 },
    ]);
  });

  it('is a warning no-op without a manifest', async () => {
    await rm(join(root, 'catalog.json'));
    await expect(seedKnowledgeCatalog()).resolves.toBeUndefined();
    expect(packages()).toHaveLength(3); // prior rows untouched
  });

  it('seeds an item behind an escaping symlink as unavailable', async () => {
    // writing/sneaky.md (created by the containment suite) resolves outside
    // the catalog root: stat() would say it exists, but it can never be read
    // through the confinement boundary — so it must not seed as available.
    const manifest = structuredClone(MANIFEST);
    manifest.packages[0].items.push({
      id: 'writing/sneaky', title: 'Sneaky', path: 'writing/sneaky.md',
      version: 1, kind: 'document',
    });
    await writeManifest(manifest);
    await seedKnowledgeCatalog();
    expect(items().find((i) => i.id === 'writing/sneaky'))
      .toMatchObject({ available: 0 });
    expect(items().find((i) => i.id === 'writing/style'))
      .toMatchObject({ available: 1 });
  });
});

describe('the shipped guidance-docs/catalog.json', () => {
  it('validates, and every listed content file exists in this checkout', async () => {
    config.knowledge.catalogRoot = savedRoot; // the real repo catalog
    try {
      const manifest = await loadCatalogManifest();
      expect(manifest).not.toBeNull();
      expect(manifest.packages.length).toBeGreaterThanOrEqual(12);
      for (const pkg of manifest.packages) {
        for (const item of pkg.items) {
          expect(await catalogFileExists(item.path), item.id).toBe(true);
        }
      }
    } finally {
      config.knowledge.catalogRoot = root;
    }
  });
});
