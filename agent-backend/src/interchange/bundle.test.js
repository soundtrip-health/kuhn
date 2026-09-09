// Interchange bundle parsing (issue #153). Zips are built in memory with
// fflate so each case can vary one thing; the on-disk fixture is exercised
// by routes/interchange.test.js.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';

process.env.KUHN_SQLITE_PATH = ':memory:';

let config; let parseBundle; let BundleError; let validateWorkspacePath;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  ({ parseBundle, BundleError, validateWorkspacePath } = await import('./bundle.js'));
});

const MANIFEST = {
  schema_version: '1',
  source: { tool: 'sciwriter', revision: 'abc' },
  project: { name: 'P', project_type: 'manuscript' },
  docs: [{ path: 'draft/main.md', title: 'Main', meta: { n: 1 } }],
};
const REFS = [{ cite_key: 'Berman2000', title: 'T', authors: ['Berman, R. M.'], year: 2000, doi: '10.1/x' }];

function zip(entries) {
  const out = {};
  for (const [name, value] of Object.entries(entries)) {
    if (value === null) continue;
    out[name] = typeof value === 'string' ? strToU8(value)
      : value instanceof Uint8Array ? value : strToU8(JSON.stringify(value));
  }
  return Buffer.from(zipSync(out));
}

const base = (over = {}) => zip({
  'manifest.json': MANIFEST,
  'references.json': REFS,
  'files/draft/main.md': '# Hi [@Berman2000]\n',
  'files/draft/figures/f.png': new Uint8Array([137, 80, 78, 71]),
  ...over,
});

const expectInvalid = (buf, re, code = 'invalid_bundle') => {
  let err;
  try { parseBundle(buf); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(BundleError);
  expect(err.code).toBe(code);
  expect(err.message).toMatch(re);
};

describe('parseBundle', () => {
  it('returns normalized manifest, references, docs and assets', () => {
    const b = parseBundle(base());
    expect(b.manifest.project).toEqual({ name: 'P', project_type: 'manuscript', org_id: null });
    expect(b.manifest.source).toEqual({ tool: 'sciwriter', revision: 'abc' });
    expect(b.docs).toEqual([{ path: 'draft/main.md', title: 'Main', meta: { n: 1 }, content: '# Hi [@Berman2000]\n' }]);
    expect([...b.assets.keys()]).toEqual(['draft/figures/f.png']);
    expect(b.references).toHaveLength(1);
    expect(b.references[0]).toMatchObject({ citeKey: 'Berman2000', title: 'T', authors: ['Berman, R. M.'], year: 2000, doi: '10.1/x', entryType: 'article' });
  });

  it('normalizes authors given as objects or "Given Family"', () => {
    const b = parseBundle(base({
      'references.json': [{ cite_key: 'k', title: 'T', authors: [{ family: 'Zarate', given: 'C. A.' }, 'Jane Q Doe', { family: 'Org' }] }],
    }));
    expect(b.references[0].authors).toEqual(['Zarate, C. A.', 'Doe, Jane Q', 'Org']);
  });

  it('tolerates a single wrapping directory', () => {
    const b = parseBundle(zip({
      'bundle/manifest.json': MANIFEST,
      'bundle/files/draft/main.md': 'x',
    }));
    expect(b.docs[0].path).toBe('draft/main.md');
  });

  it('refuses non-zip input and a missing or malformed manifest', () => {
    expectInvalid(Buffer.from('not a zip'), /not a zip/);
    expectInvalid(zip({ 'files/draft/main.md': 'x' }), /manifest.json is missing/);
    expectInvalid(zip({ 'manifest.json': '{oops', 'files/draft/main.md': 'x' }), /not valid JSON/);
    expectInvalid(base({ 'manifest.json': { ...MANIFEST, schema_version: '2' } }), /schema_version/);
    expectInvalid(base({ 'manifest.json': { ...MANIFEST, docs: [] } }), /docs must be a non-empty/);
    expectInvalid(base({ 'manifest.json': { ...MANIFEST, project: { name: 'P', project_type: 'poem' } } }), /project_type/);
  });

  it('refuses a doc the bundle does not carry, and unexpected root entries', () => {
    expectInvalid(base({ 'files/draft/main.md': null }), /lists draft\/main.md but/);
    expectInvalid(base({ 'stray.txt': 'x' }), /unexpected entry stray.txt/);
    expectInvalid(base({ 'manifest.json': { ...MANIFEST, docs: [MANIFEST.docs[0], MANIFEST.docs[0]] } }), /twice/);
  });

  it('refuses unsafe workspace paths before anything is written', () => {
    expectInvalid(base({ 'files/../evil.md': 'x' }), /unsafe path/);
    expectInvalid(base({ 'files/draft/.git/config': 'x' }), /reserved path segment/);
    expectInvalid(base({ 'files//abs.md': 'x' }), /absolute path/);
    expectInvalid(base({ 'files/draft\\win.md': 'x' }), /backslash/);
    expect(() => validateWorkspacePath('draft/./a.md')).toThrow(BundleError);
    expect(validateWorkspacePath('draft/figures/a.png')).toBe('draft/figures/a.png');
  });

  it('refuses a doc that is not UTF-8 text', () => {
    expectInvalid(base({ 'files/draft/main.md': new Uint8Array([0xff, 0xfe, 0x00, 0xc3]) }), /not valid UTF-8/);
  });

  it('validates references: key grammar, required title, duplicates', () => {
    expectInvalid(base({ 'references.json': [{ cite_key: 'bad key', title: 'T' }] }), /cite_key must match/);
    expectInvalid(base({ 'references.json': [{ cite_key: 'k' }] }), /title is required/);
    expectInvalid(base({ 'references.json': [{ cite_key: 'k', title: 'T' }, { cite_key: 'k', title: 'U' }] }), /twice/);
    expectInvalid(base({ 'references.json': { cite_key: 'k' } }), /must be an array/);
  });

  describe('limits', () => {
    let saved;
    afterEach(() => {
      if (saved) Object.assign(config.interchange, saved);
      saved = null;
    });

    it('caps the entry count on the declared sizes, before inflating', () => {
      saved = { ...config.interchange };
      config.interchange.maxEntries = 2;
      expectInvalid(base(), /more than 2 entries/, 'too_large');
    });

    it('caps the uncompressed total and the per-doc meta blob', () => {
      saved = { ...config.interchange };
      config.interchange.maxBundleBytes = 10;
      expectInvalid(base(), /exceeds 10 bytes uncompressed/, 'too_large');
      config.interchange.maxBundleBytes = saved.maxBundleBytes;
      config.interchange.maxMetaBytes = 50;
      const big = { ...MANIFEST, source: {}, docs: [{ path: 'draft/main.md', meta: { big: 'x'.repeat(100) } }] };
      expectInvalid(base({ 'manifest.json': big }), /meta exceeds 50 bytes/);
      expectInvalid(base({ 'manifest.json': { ...MANIFEST, source: { big: 'x'.repeat(100) } } }), /source is too large/);
    });
  });
});
