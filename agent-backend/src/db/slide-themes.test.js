import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

// Real in-memory SQLite + a temp catalog root (same rig as ingest.test.js).
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync; let config;
let themes; let seedSlideThemeCatalog;
let themesRoot;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ config } = await import('../config.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  themesRoot = await mkdtemp(join(tmpdir(), 'kuhn-themes-'));
  config.slideThemes.catalogRoot = themesRoot;
  themes = await import('./slide-themes.js');
  ({ seedSlideThemeCatalog } = await import('./seed.js'));
});

afterAll(async () => {
  await rm(themesRoot, { recursive: true, force: true });
});

beforeEach(() => {
  querySync('DELETE FROM org_slide_themes');
  querySync('DELETE FROM catalog_slide_themes');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'A', 'a'), (2, 'B', 'b')");
});

const manifest = (list) => ({ catalog_version: 1, themes: list });

describe('themeNameFromCss', () => {
  it('reads the marp @theme header', () => {
    expect(themes.themeNameFromCss('/* @theme kuhn */\nsection {}')).toBe('kuhn');
    expect(themes.themeNameFromCss('/*@theme my-theme2*/')).toBe('my-theme2');
    expect(themes.themeNameFromCss('section {} /* no header */')).toBe(null);
  });
});

describe('validateThemeManifest', () => {
  it('rejects built-in shadowing, duplicates, and escaping paths', () => {
    const bad = (list) => expect(() => themes.validateThemeManifest(manifest(list)))
      .toThrow(themes.ThemeError);
    bad([{ name: 'default', title: 'X', path: 'x.css' }]);
    bad([{ name: 'a', title: 'A', path: 'a.css' }, { name: 'a', title: 'A2', path: 'a2.css' }]);
    bad([{ name: 'a', title: 'A', path: '../escape.css' }]);
    bad([{ name: 'Bad Name', title: 'A', path: 'a.css' }]);
    expect(themes.validateThemeManifest(manifest([{ name: 'kuhn', title: 'Kuhn', path: 'kuhn.css' }])))
      .toBeTruthy();
  });
});

describe('seedSlideThemeCatalog', () => {
  it('seeds present CSS as available, missing as unavailable, dropped rows to 0', async () => {
    await writeFile(join(themesRoot, 'catalog.json'), JSON.stringify(manifest([
      { name: 'kuhn', title: 'Kuhn', path: 'kuhn.css', description: 'd' },
      { name: 'ghost', title: 'Ghost', path: 'missing.css' },
    ])));
    await writeFile(join(themesRoot, 'kuhn.css'), '/* @theme kuhn */');
    await seedSlideThemeCatalog();
    const rows = themes.listCatalogThemes();
    expect(rows.map((r) => [r.name, r.available])).toEqual([['ghost', 0], ['kuhn', 1]]);

    // Reseed without ghost: the row survives, unavailable.
    await writeFile(join(themesRoot, 'catalog.json'), JSON.stringify(manifest([
      { name: 'kuhn', title: 'Kuhn', path: 'kuhn.css' },
    ])));
    await seedSlideThemeCatalog();
    expect(themes.listCatalogThemes().map((r) => [r.name, r.available]))
      .toEqual([['ghost', 0], ['kuhn', 1]]);
  });
});

describe('org themes + render-time resolution', () => {
  it('upsert replaces CSS and re-activates; status toggles; orgs are isolated', () => {
    const first = themes.upsertOrgTheme({ orgId: 1, name: 'acme', title: 'Acme', css: '/* @theme acme */ v1' });
    expect(first.status).toBe('active');
    themes.setOrgThemeStatus(1, 'acme', 'disabled');
    const replaced = themes.upsertOrgTheme({ orgId: 1, name: 'acme', title: 'Acme', css: '/* @theme acme */ v2' });
    expect(replaced.css).toContain('v2');
    expect(replaced.status).toBe('active'); // re-upload re-activates
    expect(themes.listOrgThemes(2)).toEqual([]); // tenant isolation
  });

  it('resolveThemeCss: active org theme shadows catalog; disabled falls through; builtin → null', async () => {
    await writeFile(join(themesRoot, 'catalog.json'), JSON.stringify(manifest([
      { name: 'kuhn', title: 'Kuhn', path: 'kuhn.css' },
    ])));
    await writeFile(join(themesRoot, 'kuhn.css'), '/* @theme kuhn */ CATALOG');
    await seedSlideThemeCatalog();

    expect(await themes.resolveThemeCss(1, 'default')).toBe(null); // marp built-in
    expect(await themes.resolveThemeCss(1, 'unknown')).toBe(null);

    const fromCatalog = await themes.resolveThemeCss(1, 'kuhn');
    expect(fromCatalog).toMatchObject({ source: 'catalog' });
    expect(fromCatalog.css).toContain('CATALOG');

    themes.upsertOrgTheme({ orgId: 1, name: 'kuhn', title: 'Kuhn (org)', css: '/* @theme kuhn */ ORG' });
    expect((await themes.resolveThemeCss(1, 'kuhn'))).toMatchObject({ source: 'org' });

    themes.setOrgThemeStatus(1, 'kuhn', 'disabled');
    expect((await themes.resolveThemeCss(1, 'kuhn')).source).toBe('catalog'); // disabled falls through
    expect((await themes.resolveThemeCss(2, 'kuhn')).source).toBe('catalog'); // other org unaffected
  });
});
