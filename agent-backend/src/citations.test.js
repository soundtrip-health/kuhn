import { describe, expect, it } from 'vitest';

import {
  arxivToRef,
  crossrefToRef,
  diffReferenceRecord,
  extractArxivId,
  formatBibEntry,
  makeCitekey,
  parseNbib,
  toFamilyFirst,
} from './citations.js';

const NBIB_SAMPLE = `
PMID- 38000001
DP  - 2024 Mar 15
TI  - Semaglutide and cardiovascular outcomes in obesity without
      diabetes: a randomized trial.
AB  - Background: Semaglutide reduces cardiovascular risk.
FAU - Lincoff, A Michael
AU  - Lincoff AM
FAU - Brown-Frandsen, Kirstine
AU  - Brown-Frandsen K
TA  - N Engl J Med
JT  - The New England journal of medicine
VI  - 389
IP  - 24
PG  - 2221-2232
LID - 10.1056/NEJMoa2307563 [doi]

PMID- 38000002
DP  - 2023
TI  - A second record.
AU  - Smith J
TA  - Nature
`;

describe('parseNbib', () => {
  it('parses tagged fields and joins continuation lines', () => {
    const [rec] = parseNbib(NBIB_SAMPLE);
    expect(rec.pmid).toBe('38000001');
    expect(rec.title).toBe(
      'Semaglutide and cardiovascular outcomes in obesity without diabetes: a randomized trial.',
    );
    expect(rec.year).toBe('2024');
    expect(rec.journal).toBe('The New England journal of medicine');
    expect(rec.journalAbbrev).toBe('N Engl J Med');
    expect(rec.volume).toBe('389');
    expect(rec.issue).toBe('24');
    expect(rec.pages).toBe('2221-2232');
    expect(rec.doi).toBe('10.1056/NEJMoa2307563');
  });

  it('prefers full author names (FAU) over abbreviated (AU)', () => {
    const [rec] = parseNbib(NBIB_SAMPLE);
    expect(rec.authors).toEqual(['Lincoff, A Michael', 'Brown-Frandsen, Kirstine']);
  });

  it('falls back to AU when no FAU lines exist and splits records on blank lines', () => {
    const records = parseNbib(NBIB_SAMPLE);
    expect(records).toHaveLength(2);
    expect(records[1].authors).toEqual(['Smith J']);
    expect(records[1].year).toBe('2023');
  });

  it('returns no records for empty input', () => {
    expect(parseNbib('')).toEqual([]);
    expect(parseNbib('\n\n')).toEqual([]);
  });
});

describe('makeCitekey', () => {
  it('builds lastname+year, lowercased and ASCII-folded', () => {
    expect(makeCitekey({ authors: ['Lincoff, A Michael'], year: '2024' }, new Set())).toBe('lincoff2024');
    expect(makeCitekey({ authors: ['Brown-Frandsen, Kirstine'], year: '2023' }, new Set())).toBe('brownfrandsen2023');
    expect(makeCitekey({ authors: ['Gómez, Ana'], year: '2022' }, new Set())).toBe('gomez2022');
  });

  it('falls back for missing author or year', () => {
    expect(makeCitekey({ authors: [], year: '2024' }, new Set())).toBe('anon2024');
    expect(makeCitekey({ authors: ['Smith, Jane'], year: null }, new Set())).toBe('smithnd');
  });

  it('disambiguates collisions with letter suffixes', () => {
    const taken = new Set(['smith2024', 'smith2024a']);
    expect(makeCitekey({ authors: ['Smith, Jane'], year: '2024' }, taken)).toBe('smith2024b');
  });
});

describe('formatBibEntry', () => {
  it('renders an @article entry with the available fields', () => {
    const [rec] = parseNbib(NBIB_SAMPLE);
    const entry = formatBibEntry(rec, 'lincoff2024');
    expect(entry).toContain('@article{lincoff2024,');
    expect(entry).toContain('author = {Lincoff, A Michael and Brown-Frandsen, Kirstine}');
    expect(entry).toContain('journal = {The New England journal of medicine}');
    expect(entry).toContain('pages = {2221--2232}');
    expect(entry).toContain('doi = {10.1056/NEJMoa2307563}');
    expect(entry).toContain('pmid = {38000001}');
    expect(entry.endsWith('}')).toBe(true);
  });

  it('escapes BibTeX-special characters and omits empty fields', () => {
    const entry = formatBibEntry(
      { authors: ['Smith, Jane'], title: 'Risk & reward: 100% of #cases', year: '2024' },
      'smith2024',
    );
    expect(entry).toContain('title = {Risk \\& reward: 100\\% of \\#cases}');
    expect(entry).not.toContain('journal =');
    expect(entry).not.toContain('doi =');
  });
});


// ---- STH-49: deterministic ingestion + field-level verification ------------

describe('toFamilyFirst', () => {
  it('converts arXiv "Given Family" order to BibTeX "Family, Given"', () => {
    expect(toFamilyFirst('Samar Ansari')).toBe('Ansari, Samar');
    expect(toFamilyFirst('A Michael Lincoff')).toBe('Lincoff, A Michael');
  });

  it('leaves already family-first or single-token names alone', () => {
    expect(toFamilyFirst('Ansari, Samar')).toBe('Ansari, Samar');
    expect(toFamilyFirst('Aristotle')).toBe('Aristotle');
    expect(toFamilyFirst('')).toBe('');
  });
});

describe('arxivToRef', () => {
  it('builds the insert record entirely from the fetched arXiv entry', () => {
    const ref = arxivToRef({
      id: '2602.05930v1',
      title: 'Citation Fabrication Taxonomy',
      authors: ['Samar Ansari'],
      summary: 'An abstract.',
      published: '2026-02-09T00:00:00Z',
      url: 'http://arxiv.org/abs/2602.05930v1',
    });
    expect(ref.title).toBe('Citation Fabrication Taxonomy');
    expect(ref.authors).toEqual(['Ansari, Samar']);
    expect(ref.year).toBe('2026');
    expect(ref.url).toBe('http://arxiv.org/abs/2602.05930v1');
    expect(ref.entryType).toBe('misc');
    expect(ref.sourceType).toBe('preprint');
    // The cite key then derives from the REAL first author
    expect(makeCitekey(ref, new Set())).toBe('ansari2026');
  });
});

describe('crossrefToRef', () => {
  it('maps entry types and marks posted-content as preprint', () => {
    const article = crossrefToRef({ type: 'journal-article', title: 'T', authors: ['A, B'], year: '2025' });
    expect(article.entryType).toBe('article');
    expect(article.sourceType).toBe('crossref');
    const preprint = crossrefToRef({ type: 'posted-content', title: 'T', authors: [], year: '2025' });
    expect(preprint.entryType).toBe('misc');
    expect(preprint.sourceType).toBe('preprint');
  });
});

describe('extractArxivId', () => {
  it('pulls the id out of stored abs/pdf URLs', () => {
    expect(extractArxivId('http://arxiv.org/abs/2602.05930')).toBe('2602.05930');
    expect(extractArxivId('http://arxiv.org/pdf/2602.05930.pdf')).toBe('2602.05930');
    expect(extractArxivId('https://example.com/paper')).toBeNull();
    expect(extractArxivId(null)).toBeNull();
  });
});

describe('diffReferenceRecord', () => {
  const stored = {
    title: 'Citation Fabrication Taxonomy',
    authors: ['Ansari, Samar'],
    year: '2026',
    journal: null, volume: null, issue: null, pages: null, doi: null,
  };

  it('returns no issues when every field matches the registry record', () => {
    expect(diffReferenceRecord(stored, {
      title: 'Citation fabrication taxonomy.',
      authors: ['Samar Ansari'].map(toFamilyFirst),
      year: '2026',
    })).toEqual([]);
  });

  it('catches the bianchi2026 failure: fabricated author list on a real paper', () => {
    const corrupted = { ...stored, authors: ['Bianchi, Stefano', 'Minervini, Pasquale', 'Mohan, Ansh'] };
    const issues = diffReferenceRecord(corrupted, { title: stored.title, authors: ['Ansari, Samar'], year: '2026' });
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('authors');
    expect(issues[0].source).toBe('Ansari, Samar');
  });

  it('flags year, doi, and title mismatches', () => {
    const issues = diffReferenceRecord(
      { ...stored, doi: '10.1/aaa' },
      { title: 'A Different Paper', authors: ['Ansari, Samar'], year: '2024', doi: '10.1/bbb' },
    );
    const fields = issues.map((i) => i.field).sort();
    expect(fields).toEqual(['doi', 'title', 'year']);
  });

  it('tolerates journal abbreviations and page-range dash styles', () => {
    const issues = diffReferenceRecord(
      { ...stored, journal: 'N Engl J Med', pages: '100--110' },
      {
        title: stored.title, authors: ['Ansari, Samar'], year: '2026',
        journal: 'The New England journal of medicine', journalAbbrev: 'N Engl J Med', pages: '100-110',
      },
    );
    expect(issues).toEqual([]);
  });

  it('ignores authors when the registry record has none (no false positives)', () => {
    expect(diffReferenceRecord(stored, { title: stored.title, authors: [], year: '2026' })).toEqual([]);
  });
});
