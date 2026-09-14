import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

// Real in-memory SQLite + a temp catalog root (slide-themes.test.js rig).
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync; let config;
let types;
let typesRoot;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ config } = await import('../config.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  typesRoot = await mkdtemp(join(tmpdir(), 'kuhn-doc-types-'));
  config.docTypes.catalogRoot = typesRoot;
  types = await import('./doc-types.js');
});

afterAll(async () => {
  await rm(typesRoot, { recursive: true, force: true });
});

beforeEach(() => {
  querySync('DELETE FROM org_doc_types');
  querySync('DELETE FROM catalog_doc_types');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'A', 'a'), (2, 'B', 'b')");
});

const manifest = (list) => ({ catalog_version: 1, types: list });
const seedManifest = async (list) => {
  await writeFile(join(typesRoot, 'catalog.json'), JSON.stringify(manifest(list)));
  await types.seedDocTypeCatalog();
};

describe('validateDocTypeManifest', () => {
  it('rejects bad slugs, duplicates, missing titles, and malformed fields', () => {
    const bad = (list) => expect(() => types.validateDocTypeManifest(manifest(list)))
      .toThrow(types.DocTypeError);
    bad([{ slug: 'Bad Slug', title: 'X' }]);
    bad([{ slug: 'x', title: 'X' }]); // too short (min 2)
    bad([{ slug: 'a-type', title: 'A' }, { slug: 'a-type', title: 'A2' }]);
    bad([{ slug: 'a-type' }]); // no title
    bad([{ slug: 'a-type', title: 'A', wizard_hints: 'not a list' }]);
    bad([{ slug: 'a-type', title: 'A', default_template: '../x' }]);
    expect(() => types.validateDocTypeManifest({ catalog_version: 0, types: [] })).toThrow(/catalog_version/);
    expect(types.validateDocTypeManifest(manifest([
      { slug: 'manuscript', title: 'Manuscript', default_template: 'manuscript', wizard_hints: ['a'], guidance: 'g' },
    ]))).toBeTruthy();
  });

  it('the shipped doc-types/catalog.json validates and carries the five original types', async () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '../../../doc-types/catalog.json'), 'utf-8'));
    expect(() => types.validateDocTypeManifest(raw)).not.toThrow();
    expect(raw.types.map((t) => t.slug)).toEqual(['manuscript', 'rwe-protocol', 'rct-protocol', 'grant', 'sop']);
    for (const t of raw.types) {
      expect(t.wizard_hints).toHaveLength(4);
      expect(t.guidance.split(/\s+/).length).toBeGreaterThan(120);
    }
  });
});

describe('seedDocTypeCatalog', () => {
  it('seeds in manifest order, keeps dropped rows as unavailable, and re-activates on return', async () => {
    await seedManifest([
      { slug: 'manuscript', title: 'Manuscript', description: 'd', wizard_hints: ['h1', 'h2'], guidance: 'G' },
      { slug: 'memo', title: 'Memo' },
    ]);
    let rows = types.listCatalogDocTypes();
    expect(rows.map((r) => [r.slug, r.available, r.sort_order])).toEqual([['manuscript', 1, 0], ['memo', 1, 1]]);
    expect(rows[0].wizard_hints).toEqual(['h1', 'h2']); // parsed back from JSON
    expect(rows[1].wizard_hints).toEqual([]);

    await seedManifest([{ slug: 'manuscript', title: 'Manuscript v2' }]);
    rows = types.listCatalogDocTypes();
    expect(rows.map((r) => [r.slug, r.available, r.title])).toEqual([['manuscript', 1, 'Manuscript v2'], ['memo', 0, 'Memo']]);
    expect(types.effectiveDocTypes(null).map((t) => t.slug)).toEqual(['manuscript']); // unavailable hidden

    await seedManifest([{ slug: 'memo', title: 'Memo' }, { slug: 'manuscript', title: 'Manuscript' }]);
    expect(types.listCatalogDocTypes().map((r) => [r.slug, r.available])).toEqual([['memo', 1], ['manuscript', 1]]);
  });
});

describe('org types + resolution', () => {
  it('upsert replaces fields and re-activates; status toggles; orgs are isolated', () => {
    const first = types.upsertOrgDocType({ orgId: 1, slug: 'white-paper', title: 'White paper', guidance: 'v1', wizardHints: ['a', ''] });
    expect(first).toMatchObject({ status: 'active', slug: 'white-paper', wizard_hints: ['a'] });
    types.setOrgDocTypeStatus(1, 'white-paper', 'disabled');
    const replaced = types.upsertOrgDocType({ orgId: 1, slug: 'white-paper', title: 'White paper', guidance: 'v2' });
    expect(replaced.guidance).toBe('v2');
    expect(replaced.status).toBe('active'); // re-save re-activates
    expect(types.listOrgDocTypes(2)).toEqual([]); // tenant isolation
    expect(() => types.upsertOrgDocType({ orgId: 1, slug: 'Bad', title: 'x' })).toThrow(types.DocTypeError);
    expect(() => types.upsertOrgDocType({ orgId: 1, slug: 'ok-slug', title: '' })).toThrow(/title is required/);
  });

  it('effectiveDocTypes: active org rows shadow catalog rows in place; extras follow by title', async () => {
    await seedManifest([
      { slug: 'manuscript', title: 'Manuscript', guidance: 'CATALOG' },
      { slug: 'grant', title: 'Grant' },
    ]);
    types.upsertOrgDocType({ orgId: 1, slug: 'zeta', title: 'Zeta memo' });
    types.upsertOrgDocType({ orgId: 1, slug: 'alpha', title: 'Alpha brief' });
    types.upsertOrgDocType({ orgId: 1, slug: 'manuscript', title: 'Manuscript (house style)', guidance: 'ORG' });
    types.upsertOrgDocType({ orgId: 1, slug: 'hidden', title: 'Hidden' });
    types.setOrgDocTypeStatus(1, 'hidden', 'disabled');

    const eff = types.effectiveDocTypes(1);
    expect(eff.map((t) => [t.slug, t.source])).toEqual([
      ['manuscript', 'org'], ['grant', 'catalog'], ['alpha', 'org'], ['zeta', 'org'],
    ]);
    expect(eff[0].title).toBe('Manuscript (house style)');
    expect(eff[0].guidance).toBe('ORG');
    // Other org: catalog only.
    expect(types.effectiveDocTypes(2).map((t) => [t.slug, t.source])).toEqual([['manuscript', 'catalog'], ['grant', 'catalog']]);
  });

  it('resolveDocType / docTypeResolves: org shadows catalog; disabled falls through; unknown → null', async () => {
    await seedManifest([{ slug: 'manuscript', title: 'Manuscript', guidance: 'CATALOG' }]);
    expect(types.resolveDocType(1, 'manuscript')).toMatchObject({ source: 'catalog', guidance: 'CATALOG' });
    expect(types.resolveDocType(1, 'unknown')).toBe(null);
    expect(types.resolveDocType(1, 'Not A Slug')).toBe(null);
    expect(types.resolveDocType(null, 'manuscript')).toMatchObject({ source: 'catalog' });

    types.upsertOrgDocType({ orgId: 1, slug: 'manuscript', title: 'Manuscript (org)', guidance: 'ORG' });
    expect(types.resolveDocType(1, 'manuscript')).toMatchObject({ source: 'org', guidance: 'ORG' });
    expect(types.resolveDocType(2, 'manuscript').source).toBe('catalog'); // other org unaffected

    types.setOrgDocTypeStatus(1, 'manuscript', 'disabled');
    expect(types.resolveDocType(1, 'manuscript').source).toBe('catalog'); // disabled falls through

    types.upsertOrgDocType({ orgId: 1, slug: 'white-paper', title: 'White paper' });
    expect(types.docTypeResolves(1, 'white-paper')).toBe(true);
    expect(types.docTypeResolves(2, 'white-paper')).toBe(false);
    types.setOrgDocTypeStatus(1, 'white-paper', 'disabled');
    expect(types.docTypeResolves(1, 'white-paper')).toBe(false); // no catalog fallback for org-only types
  });
});
