import { describe, it, expect } from 'vitest';
import { normalizeArxivId, normalizeCrossrefWork, parseArxivFeed } from './search.js';

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query Results</title>
  <entry>
    <id>http://arxiv.org/abs/2401.01234v1</id>
    <published>2024-01-02T00:00:00Z</published>
    <title>Target Trial Emulation &amp; Real-World
      Evidence</title>
    <summary>A study of TTE methods
      in observational data.</summary>
    <author><name>Jane Doe</name></author>
    <author><name>Richard Roe</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.05678v2</id>
    <published>2024-02-10T00:00:00Z</published>
    <title>Second Paper</title>
    <summary>Another abstract.</summary>
    <author><name>Alice Smith</name></author>
  </entry>
</feed>`;

describe('parseArxivFeed', () => {
  it('extracts entries with decoded text and normalized whitespace', () => {
    const results = parseArxivFeed(SAMPLE_FEED);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: '2401.01234v1',
      title: 'Target Trial Emulation & Real-World Evidence',
      authors: ['Jane Doe', 'Richard Roe'],
      summary: 'A study of TTE methods in observational data.',
      published: '2024-01-02T00:00:00Z',
      url: 'http://arxiv.org/abs/2401.01234v1',
    });
    expect(results[1].authors).toEqual(['Alice Smith']);
  });

  it('returns an empty array for a feed with no entries', () => {
    expect(parseArxivFeed('<feed><title>empty</title></feed>')).toEqual([]);
  });
});

describe('normalizeArxivId (STH-49)', () => {
  it('accepts bare ids, versioned ids, abs/pdf URLs, and arXiv: prefixes', () => {
    expect(normalizeArxivId('2602.05930')).toBe('2602.05930');
    expect(normalizeArxivId('2401.01234v1')).toBe('2401.01234v1');
    expect(normalizeArxivId('http://arxiv.org/abs/2602.05930')).toBe('2602.05930');
    expect(normalizeArxivId('https://arxiv.org/pdf/2602.05930.pdf')).toBe('2602.05930');
    expect(normalizeArxivId('arXiv:2602.05930')).toBe('2602.05930');
    expect(normalizeArxivId('https://www.arxiv.org/abs/2602.05930?context=cs')).toBe('2602.05930');
  });

  it('returns an empty string for blank input', () => {
    expect(normalizeArxivId('')).toBe('');
    expect(normalizeArxivId(null)).toBe('');
  });
});

describe('normalizeCrossrefWork (STH-49)', () => {
  it('maps a Crossref message to the normalized record shape', () => {
    const work = normalizeCrossrefWork({
      type: 'journal-article',
      title: ['A  Study of\n Things'],
      author: [
        { family: 'Ansari', given: 'Samar' },
        { name: 'The Collaboration' },
        { given: 'orphan-given-only' },
      ],
      issued: { 'date-parts': [[2026, 2]] },
      'container-title': ['Journal of Examples'],
      volume: '12', issue: '3', page: '100-110',
      publisher: 'Example Press',
      DOI: '10.1000/xyz',
      URL: 'https://doi.org/10.1000/xyz',
      abstract: '<jats:p>Some <i>abstract</i> text.</jats:p>',
    });
    expect(work).toEqual({
      type: 'journal-article',
      title: 'A Study of Things',
      authors: ['Ansari, Samar', 'The Collaboration'],
      year: '2026',
      journal: 'Journal of Examples',
      volume: '12', issue: '3', pages: '100-110',
      publisher: 'Example Press',
      doi: '10.1000/xyz',
      url: 'https://doi.org/10.1000/xyz',
      abstract: 'Some abstract text.',
    });
  });

  it('handles missing fields and null message', () => {
    expect(normalizeCrossrefWork(null)).toBeNull();
    const work = normalizeCrossrefWork({ title: [], author: [] });
    expect(work.title).toBe('');
    expect(work.authors).toEqual([]);
    expect(work.year).toBeNull();
    expect(work.abstract).toBeNull();
  });
});
