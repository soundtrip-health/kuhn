/**
 * Issue #147: the deterministic bibliography path as a HOOK. Exercises
 * updateReference / add* against a real in-memory SQLite store with the
 * registries mocked: an identified entry can only be rewritten from its
 * registry record, typed metadata is refused, and every add/update carries
 * the post-write verification of the stored row.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

const arxivFetchById = vi.fn();
const crossrefFetchByDoi = vi.fn();
vi.mock('./agents/search.js', () => ({
  arxivFetchById: (...a) => arxivFetchById(...a),
  crossrefFetchByDoi: (...a) => crossrefFetchByDoi(...a),
  pubmedSearch: vi.fn(),
}));

let exec; let querySync; let insertReference; let getReferenceByKey;
let updateReference; let addArxivReference; let addDoiReference; let addManualReference; let upsertCitation;
let config; let savedProjectsRoot; let projectsRoot;
let PROJECT_ID;

beforeAll(async () => {
  ({ exec, querySync } = await import('./db.js'));
  ({ insertReference, getReferenceByKey } = await import('./db/references.js'));
  ({
    updateReference, addArxivReference, addDoiReference, addManualReference, upsertCitation,
  } = await import('./citations.js'));
  exec(readFileSync(resolve(__dirname, 'db/schema.sql'), 'utf-8'));
  ({ config } = await import('./config.js'));
  savedProjectsRoot = config.agent.projectsRoot;
  projectsRoot = await mkdtemp(join(tmpdir(), 'kuhn-cit-'));
  config.agent.projectsRoot = projectsRoot;
});

afterAll(async () => {
  config.agent.projectsRoot = savedProjectsRoot;
  await rm(projectsRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  querySync('DELETE FROM bib_references');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  PROJECT_ID = querySync(
    "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id",
  ).rows[0].id;
});

// The registry's truth for two works.
const LEWIS_ARXIV = {
  id: '2005.11401v4',
  title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
  authors: ['Patrick Lewis', 'Ethan Perez', 'Aleksandra Piktus'],
  published: '2020-05-22',
  url: 'http://arxiv.org/abs/2005.11401v4',
  summary: 'RAG.',
};
const MAYNEZ_CROSSREF = {
  title: 'On Faithfulness and Factuality in Abstractive Summarization',
  authors: ['Maynez, Joshua', 'Narayan, Shashi', 'Bohnet, Bernd', 'McDonald, Ryan'],
  year: '2020',
  journal: 'Proceedings of ACL',
  doi: '10.18653/v1/2020.acl-main.173',
  type: 'proceedings-article',
  url: 'https://doi.org/10.18653/v1/2020.acl-main.173',
};

// A row the way the identifier-hijack failure left it: right identifier,
// fabricated author list.
const hijacked = (over = {}) => insertReference(PROJECT_ID, {
  title: 'On Faithfulness and Factuality in Abstractive Summarization',
  authors: ['Maynez, Joshua', 'Fabricated, Author'],
  year: 2025,
  journal: 'Journal of Made-up Results',
  doi: '10.18653/v1/2020.acl-main.173',
  entryType: 'article', sourceType: 'crossref',
  ...over,
});

describe('post-write verification on add (#147)', () => {
  it('a fresh arXiv add is verified against the record just fetched', async () => {
    arxivFetchById.mockResolvedValueOnce(LEWIS_ARXIV);
    const r = await addArxivReference(PROJECT_ID, '2005.11401v4');
    expect(r).toMatchObject({ key: 'lewis2020', created: true });
    expect(r.verification).toMatchObject({ status: 'verified', checked_against: 'arXiv 2005.11401v4' });
  });

  it('a dedupe hit on a hijacked row reports the mismatch instead of silently reusing it', async () => {
    hijacked();
    crossrefFetchByDoi.mockResolvedValueOnce(MAYNEZ_CROSSREF);
    const r = await addDoiReference(PROJECT_ID, '10.18653/v1/2020.acl-main.173');
    expect(r.created).toBe(false);
    expect(r.verification.status).toBe('mismatch');
    expect(r.verification.mismatches.map((m) => m.field)).toEqual(expect.arrayContaining(['authors', 'year']));
    expect(r.verification.checked_against).toBe('Crossref 10.18653/v1/2020.acl-main.173');
  });

  it('a manual add is unverifiable', async () => {
    const r = await addManualReference(PROJECT_ID, {
      title: 'Guidance for Industry', organization: 'U.S. Food and Drug Administration', year: 2023, url: 'https://fda.gov/x',
    });
    expect(r.created).toBe(true);
    expect(r.verification.status).toBe('unverifiable');
  });

  it('a PubMed add is verified against the fetched MEDLINE record', async () => {
    const nbib = 'PMID- 38000001\nDP  - 2024 Mar 15\nTI  - Semaglutide and cardiovascular outcomes.\nFAU - Lincoff, A Michael\nTA  - N Engl J Med\nLID - 10.1056/NEJMoa2307563 [doi]\n';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, status: 200, text: async () => nbib });
    try {
      const r = await upsertCitation(PROJECT_ID, '38000001');
      expect(r).toMatchObject({ key: 'lincoff2024', created: true });
      expect(r.verification).toMatchObject({ status: 'verified', checked_against: 'PubMed 38000001' });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('updateReference is a registry resync for identified entries (#147)', () => {
  it('with only the cite key, rewrites every field from the registry and verifies clean', async () => {
    const { key } = hijacked();
    crossrefFetchByDoi.mockResolvedValueOnce(MAYNEZ_CROSSREF);
    const r = await updateReference(PROJECT_ID, key);
    expect(crossrefFetchByDoi).toHaveBeenCalledWith('10.18653/v1/2020.acl-main.173');
    expect(r.source).toBe('registry');
    expect(r.verification.status).toBe('verified');
    const row = await getReferenceByKey(PROJECT_ID, key);
    expect(row.authors).toEqual(MAYNEZ_CROSSREF.authors);
    expect(String(row.year)).toBe('2020');
    expect(row.journal).toBe('Proceedings of ACL');
    expect(row.entry_type).toBe('inproceedings');
    expect(row.cite_key).toBe(key); // the key never moves
  });

  it('refuses typed metadata on an identified entry', async () => {
    const { key } = hijacked();
    await expect(updateReference(PROJECT_ID, key, { title: 'My better title' }))
      .rejects.toThrow(/identified by Crossref .* not from typed values/);
    expect(crossrefFetchByDoi).not.toHaveBeenCalled();
    const row = await getReferenceByKey(PROJECT_ID, key);
    expect(row.authors).toContain('Fabricated, Author'); // untouched
  });

  it('a corrected identifier re-identifies the entry and clears the old registry fields', async () => {
    const { key } = hijacked();
    arxivFetchById.mockResolvedValueOnce(LEWIS_ARXIV);
    const r = await updateReference(PROJECT_ID, key, { arxiv_id: '2005.11401v4' });
    expect(r.verification).toMatchObject({ status: 'verified', checked_against: 'arXiv 2005.11401v4' });
    const row = await getReferenceByKey(PROJECT_ID, key);
    expect(row.title).toBe(LEWIS_ARXIV.title);
    expect(row.authors).toEqual(['Lewis, Patrick', 'Perez, Ethan', 'Piktus, Aleksandra']);
    expect(row.doi).toBeNull();
    expect(row.journal).toBeNull();
    expect(row.url).toBe('http://arxiv.org/abs/2005.11401v4');
    expect(row.source_type).toBe('preprint');
  });

  it('refuses an identifier plus manual fields, and more than one identifier', async () => {
    const { key } = hijacked();
    await expect(updateReference(PROJECT_ID, key, { doi: '10.1/x', title: 't' })).rejects.toThrow(/either an identifier or manual fields/);
    await expect(updateReference(PROJECT_ID, key, { doi: '10.1/x', pmid: '1' })).rejects.toThrow(/one identifier/);
  });

  it('refuses a resync that would duplicate another entry\'s identifier', async () => {
    const { key: a } = hijacked();
    const { key: b } = insertReference(PROJECT_ID, {
      title: 'Other', authors: ['Other, Ann'], year: 2021, doi: '10.1/other', entryType: 'article',
    });
    crossrefFetchByDoi.mockResolvedValueOnce(MAYNEZ_CROSSREF);
    await expect(updateReference(PROJECT_ID, b, { doi: '10.18653/v1/2020.acl-main.173' }))
      .rejects.toThrow(new RegExp(`already stored as "${a}"`));
    expect((await getReferenceByKey(PROJECT_ID, b)).doi).toBe('10.1/other');
  });

  it('reports a registry miss without touching the row', async () => {
    const { key } = hijacked();
    crossrefFetchByDoi.mockResolvedValueOnce(null);
    await expect(updateReference(PROJECT_ID, key)).rejects.toThrow(/resolves to no record/);
    expect((await getReferenceByKey(PROJECT_ID, key)).year).toBe(2025);
  });

  it('unknown cite key', async () => {
    await expect(updateReference(PROJECT_ID, 'nope2020')).rejects.toThrow(/No reference with cite key/);
  });
});

describe('updateReference on manual (identifier-less) entries (#147)', () => {
  const manual = () => insertReference(PROJECT_ID, {
    title: 'Guidance', authors: ['{FDA}'], year: 2022, url: 'https://fda.gov/g', entryType: 'misc', sourceType: 'web',
  });

  it('accepts the manual fields and stores the organization as a corporate author', async () => {
    const { key } = manual();
    const r = await updateReference(PROJECT_ID, key, { organization: 'U.S. Food and Drug Administration', year: 2023, source_type: 'government' });
    expect(r.source).toBe('manual');
    expect(r.verification.status).toBe('unverifiable');
    const row = await getReferenceByKey(PROJECT_ID, key);
    expect(row.authors).toEqual(['{U.S. Food and Drug Administration}']);
    expect(row.year).toBe(2023);
    expect(row.source_type).toBe('government');
  });

  it('has no person-author field, refuses registry source classes, and needs something to change', async () => {
    const { key } = manual();
    await expect(updateReference(PROJECT_ID, key)).rejects.toThrow(/no PMID, DOI or arXiv id to resync from/);
    await expect(updateReference(PROJECT_ID, key, { source_type: 'pubmed' })).rejects.toThrow(/must be one of web, government, manual/);
    // `authors` is not a manual field: silently nothing to change → refused, never stored.
    await expect(updateReference(PROJECT_ID, key, { authors: ['Smith, J'] })).rejects.toThrow(/no PMID, DOI or arXiv id/);
    expect((await getReferenceByKey(PROJECT_ID, key)).authors).toEqual(['{FDA}']);
  });

  it('an arXiv URL must go through arxiv_id, and an identifier promotes the entry', async () => {
    const { key } = manual();
    await expect(updateReference(PROJECT_ID, key, { url: 'https://arxiv.org/abs/2005.11401' })).rejects.toThrow(/pass it as arxiv_id/);
    crossrefFetchByDoi.mockResolvedValueOnce(MAYNEZ_CROSSREF);
    const r = await updateReference(PROJECT_ID, key, { doi: '10.18653/v1/2020.acl-main.173' });
    expect(r.verification.status).toBe('verified');
    const row = await getReferenceByKey(PROJECT_ID, key);
    expect(row.identity_status).toBe('strong');
    expect(row.authors).toEqual(MAYNEZ_CROSSREF.authors);
  });
});
