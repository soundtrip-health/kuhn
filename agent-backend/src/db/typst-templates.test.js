import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

// Real in-memory SQLite + a temp catalog root (same rig as slide-themes.test.js).
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync; let config;
let tpl; let seedTypstTemplateCatalog;
let tplRoot;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ config } = await import('../config.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  tplRoot = await mkdtemp(join(tmpdir(), 'kuhn-typst-templates-'));
  config.typstTemplates.catalogRoot = tplRoot;
  tpl = await import('./typst-templates.js');
  ({ seedTypstTemplateCatalog } = await import('./seed.js'));
});

afterAll(async () => {
  await rm(tplRoot, { recursive: true, force: true });
});

beforeEach(() => {
  querySync('DELETE FROM org_typst_templates');
  querySync('DELETE FROM catalog_typst_templates');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'A', 'a'), (2, 'B', 'b')");
});

const manifest = (list) => ({ catalog_version: 1, templates: list });

describe('templateNameFromSource', () => {
  it('reads the // @template header', () => {
    expect(tpl.templateNameFromSource('// @template nih-grant\n#let conf(doc) = doc')).toBe('nih-grant');
    expect(tpl.templateNameFromSource('#let x = 1\n  //@template my-tpl2\n')).toBe('my-tpl2');
    expect(tpl.templateNameFromSource('#let conf(doc) = doc // no header')).toBe(null);
    expect(tpl.templateNameFromSource('/* @template nope */')).toBe(null);
  });
});

describe('validateTemplateManifest', () => {
  it('rejects duplicates, bad names, and escaping paths', () => {
    const bad = (list) => expect(() => tpl.validateTemplateManifest(manifest(list)))
      .toThrow(tpl.TemplateError);
    bad([{ name: 'a', title: 'A', path: 'a.typ' }, { name: 'a', title: 'A2', path: 'a2.typ' }]);
    bad([{ name: 'a', title: 'A', path: '../escape.typ' }]);
    bad([{ name: 'Bad Name', title: 'A', path: 'a.typ' }]);
    bad([{ name: 'a', title: '', path: 'a.typ' }]);
    expect(tpl.validateTemplateManifest(manifest([{ name: 'default', title: 'Default', path: 'default.typ' }])))
      .toBeTruthy();
  });
});

describe('seedTypstTemplateCatalog', () => {
  it('seeds present files as available, missing as unavailable, dropped rows to 0', async () => {
    await writeFile(join(tplRoot, 'catalog.json'), JSON.stringify(manifest([
      { name: 'nih-grant', title: 'NIH', path: 'nih-grant.typ', description: 'd' },
      { name: 'ghost', title: 'Ghost', path: 'missing.typ' },
    ])));
    await writeFile(join(tplRoot, 'nih-grant.typ'), '// @template nih-grant\n');
    await seedTypstTemplateCatalog();
    const rows = tpl.listCatalogTemplates();
    expect(rows.map((r) => [r.name, r.available])).toEqual([['ghost', 0], ['nih-grant', 1]]);

    await writeFile(join(tplRoot, 'catalog.json'), JSON.stringify(manifest([
      { name: 'nih-grant', title: 'NIH', path: 'nih-grant.typ' },
    ])));
    await seedTypstTemplateCatalog();
    expect(tpl.listCatalogTemplates().map((r) => [r.name, r.available]))
      .toEqual([['ghost', 0], ['nih-grant', 1]]);
  });

  it('seeds the real repo catalog: every entry has a file whose header matches its name', async () => {
    // The shipped catalog must be internally consistent — a mismatch would
    // let a document name one layout and render with another.
    const saved = config.typstTemplates.catalogRoot;
    config.typstTemplates.catalogRoot = resolve(__dirname, '../../../typst-templates');
    try {
      const m = await tpl.loadTemplateManifest();
      expect(m.templates.map((t) => t.name)).toEqual(expect.arrayContaining(['default', 'nih-grant', 'manuscript']));
      for (const t of m.templates) {
        const src = await tpl.readCatalogTemplateFile(t.path);
        expect(tpl.templateNameFromSource(src)).toBe(t.name);
        expect(src).toMatch(/#let conf\(/);
      }
    } finally {
      config.typstTemplates.catalogRoot = saved;
    }
  });
});

describe('org templates + render-time resolution', () => {
  it('upsert replaces source and re-activates; status toggles; orgs are isolated', () => {
    const first = tpl.upsertOrgTemplate({ orgId: 1, name: 'acme', title: 'Acme', source: '// @template acme\nv1' });
    expect(first.status).toBe('active');
    tpl.setOrgTemplateStatus(1, 'acme', 'disabled');
    const replaced = tpl.upsertOrgTemplate({ orgId: 1, name: 'acme', title: 'Acme', source: '// @template acme\nv2' });
    expect(replaced.source).toContain('v2');
    expect(replaced.status).toBe('active');
    expect(tpl.listOrgTemplates(2)).toEqual([]);
  });

  it('resolveTemplateSource: org shadows catalog; disabled falls through; unknown throws', async () => {
    await writeFile(join(tplRoot, 'catalog.json'), JSON.stringify(manifest([
      { name: 'nih-grant', title: 'NIH', path: 'nih-grant.typ' },
    ])));
    await writeFile(join(tplRoot, 'nih-grant.typ'), '// @template nih-grant\nCATALOG');
    await seedTypstTemplateCatalog();

    expect(await tpl.resolveTemplateSource(1, null)).toBe(null); // no front matter → pandoc default
    await expect(tpl.resolveTemplateSource(1, 'unknown')).rejects.toMatchObject({ code: 'not_found' });

    const fromCatalog = await tpl.resolveTemplateSource(1, 'nih-grant');
    expect(fromCatalog).toMatchObject({ origin: 'catalog' });
    expect(fromCatalog.source).toContain('CATALOG');

    tpl.upsertOrgTemplate({ orgId: 1, name: 'nih-grant', title: 'NIH (org)', source: '// @template nih-grant\nORG' });
    expect(await tpl.resolveTemplateSource(1, 'nih-grant')).toMatchObject({ origin: 'org' });

    tpl.setOrgTemplateStatus(1, 'nih-grant', 'disabled');
    expect((await tpl.resolveTemplateSource(1, 'nih-grant')).origin).toBe('catalog');
    expect((await tpl.resolveTemplateSource(2, 'nih-grant')).origin).toBe('catalog');
  });
});
