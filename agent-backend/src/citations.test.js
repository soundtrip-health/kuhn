import { describe, expect, it } from 'vitest';

import {
  formatBibEntry,
  makeCitekey,
  parseNbib,
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

