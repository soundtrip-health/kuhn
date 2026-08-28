import { describe, expect, it } from 'vitest';

import { authorsLine, referenceLinks, shortAuthor, sourceLine, summaryLine } from './reference-format';

describe('shortAuthor', () => {
  it('collapses "Family, Given Middle" to family + initials', () => {
    expect(shortAuthor('Smith, John A')).toBe('Smith JA');
    expect(shortAuthor('van der Berg, Anna-Maria')).toBe('van der Berg AM');
    expect(shortAuthor('Doe, J.')).toBe('Doe J');
  });

  it('leaves names without a comma alone', () => {
    expect(shortAuthor('John Smith')).toBe('John Smith');
    expect(shortAuthor('  Consortium X ')).toBe('Consortium X');
  });
});

describe('authorsLine', () => {
  const names = ['Smith, John', 'Doe, Anna', 'Lee, Kim', 'Park, Min', 'Ng, Sam', 'Wu, Li', 'Ito, Ken'];

  it('lists everyone when at or under the limit', () => {
    expect(authorsLine(names.slice(0, 5))).toBe('Smith J, Doe A, Lee K, Park M, Ng S');
  });

  it('truncates to the limit and counts the rest', () => {
    expect(authorsLine(names)).toBe('Smith J, Doe A, Lee K, Park M, Ng S, … et al. (2 more)');
  });

  it('is empty for no authors', () => {
    expect(authorsLine([])).toBe('');
  });
});

describe('summaryLine', () => {
  it('uses et al. beyond two authors and & for two', () => {
    expect(summaryLine({ authors: ['Smith, J', 'Doe, A', 'Lee, K'], year: '2024' })).toBe('Smith et al. (2024)');
    expect(summaryLine({ authors: ['Smith, J', 'Doe, A'], year: '2024' })).toBe('Smith & Doe (2024)');
    expect(summaryLine({ authors: ['Smith, J'], year: '' })).toBe('Smith');
    expect(summaryLine({ authors: ['John Smith'], year: '2020' })).toBe('Smith (2020)');
  });
});

describe('sourceLine', () => {
  it('assembles journal, year, volume(issue):pages', () => {
    expect(sourceLine({ journal: 'Nature', year: '2024', volume: '12', issue: '3', pages: '45-67' }))
      .toBe('Nature. 2024;12(3):45–67');
    expect(sourceLine({ journal: 'Nature', year: '2024' })).toBe('Nature. 2024');
    expect(sourceLine({ journal: '', year: '2024' })).toBe('2024');
  });
});

describe('referenceLinks', () => {
  it('orders DOI, PubMed, then a distinct source URL', () => {
    expect(referenceLinks({ doi: '10.1/abc', pmid: '123', url: 'https://x.org/p' })).toEqual([
      { label: 'doi:10.1/abc', href: 'https://doi.org/10.1/abc' },
      { label: 'PubMed 123', href: 'https://pubmed.ncbi.nlm.nih.gov/123/' },
      { label: 'Source', href: 'https://x.org/p' },
    ]);
  });

  it('drops a URL that duplicates the DOI link', () => {
    expect(referenceLinks({ doi: '10.1/abc', url: 'https://doi.org/10.1/abc' })).toHaveLength(1);
    expect(referenceLinks({})).toEqual([]);
  });
});
