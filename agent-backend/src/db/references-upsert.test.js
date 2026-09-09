// upsertReferenceByKey (issue #153): the key-honoring insert the interchange
// importer uses. Real in-memory SQLite so the three outcomes are decided by
// the actual dedup queries.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';
const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync; let upsertReferenceByKey; let getReferenceByKey; let insertReference;
let P;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  ({ upsertReferenceByKey, getReferenceByKey, insertReference } = await import('./references.js'));
});

beforeEach(() => {
  querySync('DELETE FROM bib_references');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  P = querySync("INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id").rows[0].id;
});

const berman = (over = {}) => ({
  citeKey: 'Berman2000', title: 'Antidepressant effects of ketamine', authors: ['Berman, R. M.', 'Cappiello, A.'],
  year: 2000, journal: 'Biol Psychiatry', doi: '10.1016/S0006-3223(99)00230-9', pmid: '10686270', ...over,
});

describe('upsertReferenceByKey', () => {
  it('creates under the requested key', async () => {
    const r = upsertReferenceByKey(P, berman());
    expect(r).toMatchObject({ status: 'created', key: 'Berman2000' });
    const row = await getReferenceByKey(P, 'Berman2000');
    expect(row).toMatchObject({ title: 'Antidepressant effects of ketamine', doi: '10.1016/s0006-3223(99)00230-9', identity_status: 'strong', source_type: null });
  });

  it('matches the same key + same identity and refreshes descriptive fields', async () => {
    upsertReferenceByKey(P, berman());
    const r = upsertReferenceByKey(P, berman({ title: 'Antidepressant effects of ketamine in depressed patients', journal: 'Biological Psychiatry', pages: '351-354' }));
    expect(r).toMatchObject({ status: 'matched', key: 'Berman2000' });
    const row = await getReferenceByKey(P, 'Berman2000');
    expect(row.title).toBe('Antidepressant effects of ketamine in depressed patients');
    expect(row.journal).toBe('Biological Psychiatry');
    expect(row.pages).toBe('351-354');
    expect(querySync('SELECT COUNT(*) AS n FROM bib_references').rows[0].n).toBe(1);
  });

  it('matches a strong (DOI/PMID) hit stored under another key', () => {
    const { key } = insertReference(P, { ...berman(), citeKey: undefined }); // Kuhn-generated key
    expect(key).toBe('berman2000');
    const r = upsertReferenceByKey(P, berman()); // requested "Berman2000"
    expect(r).toMatchObject({ status: 'matched', key: 'berman2000' });
    expect(querySync('SELECT COUNT(*) AS n FROM bib_references').rows[0].n).toBe(1);
  });

  it('matches by title+author+year when neither side has a strong id', () => {
    upsertReferenceByKey(P, { citeKey: 'grey', title: 'A grey report', authors: ['Smith, J.'], year: 2019 });
    const r = upsertReferenceByKey(P, { citeKey: 'smith2019', title: 'A Grey  Report', authors: ['Smith, John'], year: 2019, url: 'https://x' });
    expect(r).toMatchObject({ status: 'matched', key: 'grey' });
  });

  it('renames when the requested key holds a different reference', () => {
    upsertReferenceByKey(P, berman());
    const other = { citeKey: 'Berman2000', title: 'A different paper', authors: ['Berman, X.'], year: 2000, doi: '10.9999/other' };
    const r1 = upsertReferenceByKey(P, other);
    expect(r1).toMatchObject({ status: 'renamed', key: 'Berman2000a' });
    // A third distinct reference wanting the same key gets the next suffix,
    // and re-sending the renamed one is a match under its new key.
    const r2 = upsertReferenceByKey(P, { ...other, title: 'Yet another', doi: '10.9999/third' });
    expect(r2).toMatchObject({ status: 'renamed', key: 'Berman2000b' });
    expect(upsertReferenceByKey(P, other)).toMatchObject({ status: 'matched', key: 'Berman2000a' });
    expect(querySync('SELECT COUNT(*) AS n FROM bib_references').rows[0].n).toBe(3);
  });

  it('never strips an identity field the bundle omits', async () => {
    upsertReferenceByKey(P, berman());
    const r = upsertReferenceByKey(P, berman({ doi: null, pmid: '10686270' })); // PMID still matches
    expect(r.status).toBe('matched');
    expect((await getReferenceByKey(P, 'Berman2000')).doi).toBe('10.1016/s0006-3223(99)00230-9');
  });

  it('refuses a malformed key', () => {
    expect(() => upsertReferenceByKey(P, berman({ citeKey: 'no spaces' }))).toThrow(/invalid cite key/);
  });
});
