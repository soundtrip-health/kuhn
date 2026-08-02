import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Use a real in-memory SQLite DB so identity resolution is exercised against
// actual SQL/constraints, not mocks. Must be set before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync; let insertReference; let exportBibtex; let listProjectReferences;
let updateReferenceFields; let deleteReference; let getReferenceByKey;
let PROJECT_ID;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({
    insertReference, exportBibtex, listProjectReferences,
    updateReferenceFields, deleteReference, getReferenceByKey,
  } = await import('./references.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
});

beforeEach(() => {
  querySync('DELETE FROM bib_references');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id",
  );
  PROJECT_ID = rows[0].id;
});

const lincoff = () => ({
  title: 'Semaglutide and cardiovascular outcomes',
  authors: ['Lincoff, A Michael', 'Brown-Frandsen, Kirstine'],
  year: 2024, journal: 'N Engl J Med', doi: '10.1056/NEJMoa2307563', pmid: '38000001',
  sourceType: 'pubmed',
});

describe('insertReference identity resolution', () => {
  it('inserts a fresh reference with a lastname+year cite key', () => {
    const r = insertReference(PROJECT_ID, lincoff());
    expect(r).toMatchObject({ key: 'lincoff2024', created: true });
  });

  it('reuses the key when the same PMID is added again', async () => {
    insertReference(PROJECT_ID, lincoff());
    const again = insertReference(PROJECT_ID, lincoff());
    expect(again).toMatchObject({ key: 'lincoff2024', created: false });
    expect(await listProjectReferences(PROJECT_ID)).toHaveLength(1);
  });

  it('dedupes by DOI (case-insensitive) when the PMID differs', () => {
    insertReference(PROJECT_ID, lincoff());
    const byDoi = insertReference(PROJECT_ID, {
      ...lincoff(), pmid: '99999999', title: 'Same paper, another source',
      doi: '10.1056/nejmoa2307563',
    });
    expect(byDoi).toMatchObject({ key: 'lincoff2024', created: false });
  });

  it('disambiguates a different work colliding on author+year', () => {
    insertReference(PROJECT_ID, lincoff());
    const collision = insertReference(PROJECT_ID, {
      ...lincoff(), pmid: '38099999', doi: null, title: 'A different 2024 paper',
    });
    expect(collision).toMatchObject({ key: 'lincoff2024a', created: true });
  });

  it('weak-dedupes references with neither DOI nor PMID', () => {
    const ref = { title: 'Lab notes on X', authors: ['Smith, Jane'], year: 2020 };
    const first = insertReference(PROJECT_ID, ref);
    const second = insertReference(PROJECT_ID, { ...ref });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ key: first.key, created: false });
  });

  it('scopes references per project (same key allowed in another project)', () => {
    const { rows } = querySync(
      "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P2', 'manuscript') RETURNING id",
    );
    insertReference(PROJECT_ID, lincoff());
    const other = insertReference(rows[0].id, lincoff());
    expect(other).toMatchObject({ key: 'lincoff2024', created: true });
  });
});

describe('exportBibtex', () => {
  it('renders stored references as BibTeX, sorted by cite key', async () => {
    insertReference(PROJECT_ID, lincoff());
    insertReference(PROJECT_ID, { title: 'Another', authors: ['Adams, Al'], year: 2019, pmid: '1' });
    const bib = await exportBibtex(PROJECT_ID);
    expect(bib).toContain('@article{adams2019,');
    expect(bib).toContain('@article{lincoff2024,');
    expect(bib.indexOf('adams2019')).toBeLessThan(bib.indexOf('lincoff2024'));
  });

  it('returns an empty string for a project with no references', async () => {
    expect(await exportBibtex(PROJECT_ID)).toBe('');
  });
});

describe('updateReferenceFields / deleteReference (issue #41)', () => {
  it('updates only the provided fields and keeps the cite key', async () => {
    insertReference(PROJECT_ID, lincoff());
    const row = updateReferenceFields(PROJECT_ID, 'lincoff2024', {
      pages: '2221-2232', journal: 'N Engl J Med.', sourceType: 'pubmed',
    });
    expect(row.cite_key).toBe('lincoff2024');
    expect(row.pages).toBe('2221-2232');
    expect(row.journal).toBe('N Engl J Med.');
    expect(row.title).toBe(lincoff().title); // untouched
    const bib = await exportBibtex(PROJECT_ID);
    expect(bib).toContain('@article{lincoff2024,');
    expect(bib).toContain('2221--2232');
  });

  it('normalizes DOI/PMID corrections and recomputes identity_status', async () => {
    insertReference(PROJECT_ID, { title: 'Weak entry', authors: ['Jones, Ann'], year: 2021 });
    const before = await getReferenceByKey(PROJECT_ID, 'jones2021');
    expect(before.identity_status).toBe('weak');
    const row = updateReferenceFields(PROJECT_ID, 'jones2021', { doi: '10.1000/XYZ.,' });
    expect(row.doi).toBe('10.1000/xyz');
    expect(row.identity_status).toBe('strong');
  });

  it('recomputes the weak-id hash when title/authors/year change', () => {
    insertReference(PROJECT_ID, { title: 'Old title', authors: ['Lee, Bo'], year: 2020 });
    const before = querySync(
      'SELECT weak_id_hash FROM bib_references WHERE project_id = $1', [PROJECT_ID],
    ).rows[0].weak_id_hash;
    updateReferenceFields(PROJECT_ID, 'lee2020', { title: 'Corrected title' });
    const after = querySync(
      'SELECT weak_id_hash FROM bib_references WHERE project_id = $1', [PROJECT_ID],
    ).rows[0].weak_id_hash;
    expect(after).not.toBe(before);
  });

  it('parses corrected authors back out of authors_json', () => {
    insertReference(PROJECT_ID, lincoff());
    const row = updateReferenceFields(PROJECT_ID, 'lincoff2024', {
      authors: ['Lincoff, A Michael', 'Brown-Frandsen, Kirstine', 'Kahn, Steven E'],
    });
    expect(row.authors).toHaveLength(3);
  });

  it('returns null for an unknown cite key', () => {
    expect(updateReferenceFields(PROJECT_ID, 'nope2020', { year: 2021 })).toBeNull();
  });

  it('deleteReference removes the row and reports whether one existed', async () => {
    insertReference(PROJECT_ID, lincoff());
    expect(deleteReference(PROJECT_ID, 'lincoff2024')).toBe(true);
    expect(await listProjectReferences(PROJECT_ID)).toHaveLength(0);
    expect(deleteReference(PROJECT_ID, 'lincoff2024')).toBe(false);
  });
});
