import { describe, expect, it } from 'vitest';

import {
  formatBibEntry,
  makeCitekey,
  parseBibEntries,
  parseNbib,
  upsertBibText,
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

describe('parseBibEntries / upsertBibText', () => {
  const record = () => parseNbib(NBIB_SAMPLE)[0];

  it('appends a new entry to empty and non-empty files', () => {
    const first = upsertBibText('', record());
    expect(first.created).toBe(true);
    expect(first.key).toBe('lincoff2024');
    expect(first.bibText.startsWith('@article{lincoff2024,')).toBe(true);
    expect(first.bibText.endsWith('\n')).toBe(true);

    const second = upsertBibText(first.bibText, { authors: ['Other, Ann'], year: '2020', title: 'T', pmid: '99' });
    expect(second.created).toBe(true);
    expect(second.bibText).toContain('@article{lincoff2024,');
    expect(second.bibText).toContain('\n\n@article{other2020,');
  });

  it('reuses the existing key when the same work is cited again (PMID match)', () => {
    const { bibText } = upsertBibText('', record());
    const again = upsertBibText(bibText, record());
    expect(again.created).toBe(false);
    expect(again.key).toBe('lincoff2024');
    expect(again.bibText).toBe(bibText);
  });

  it('dedupes by DOI when the PMID is absent, case-insensitively', () => {
    const { bibText } = upsertBibText('', record());
    const byDoi = upsertBibText(bibText, {
      authors: ['Lincoff, A Michael'],
      year: '2024',
      title: 'Same paper from another source',
      doi: '10.1056/nejmoa2307563',
    });
    expect(byDoi.created).toBe(false);
    expect(byDoi.key).toBe('lincoff2024');
  });

  it('disambiguates a different work that collides on author+year', () => {
    const { bibText } = upsertBibText('', record());
    const collision = upsertBibText(bibText, {
      authors: ['Lincoff, A Michael'],
      year: '2024',
      title: 'A different 2024 paper',
      pmid: '38099999',
    });
    expect(collision.created).toBe(true);
    expect(collision.key).toBe('lincoff2024a');
  });

  it('tolerates hand-written entries it cannot fully parse', () => {
    const handWritten = '% comment line\n@misc{note1,\n  title = {Lab notebook}\n}\n';
    const entries = parseBibEntries(handWritten);
    expect(entries).toEqual([{ type: 'misc', key: 'note1', doi: null, pmid: null }]);

    const result = upsertBibText(handWritten, record());
    expect(result.created).toBe(true);
    expect(result.bibText).toContain('@misc{note1,');
    expect(result.bibText).toContain('@article{lincoff2024,');
  });
});
