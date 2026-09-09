import { describe, expect, it } from 'vitest';
import { blockKey, computeLines, type PageMap } from './page-breaks';

// A minimal stand-in for a ProseMirror doc: top-level blocks with textContent.
const doc = (texts: string[]) => ({
  forEach(fn: (node: { textContent: string }, offset: number) => void) {
    let offset = 0;
    for (const t of texts) { fn({ textContent: t }, offset); offset += t.length + 2; }
  },
}) as unknown as Parameters<typeof computeLines>[0];

const map = (blocks: [string, number][]): PageMap => ({
  pages: Math.max(...blocks.map(([, p]) => p)),
  pageHeight: 792,
  blocks: blocks.map(([key, page]) => ({ key, page, y: 0 })),
  end: { page: 1, y: 0 },
});

describe('blockKey', () => {
  it('matches blockmarks.lua: lower-case alphanumerics, first 24', () => {
    expect(blockKey('Specific Aims: a study — of things!')).toBe('specificaimsastudyofthin');
    expect(blockKey('  \\newpage ')).toBe('newpage');
    expect(blockKey('')).toBe('');
  });
});

describe('computeLines', () => {
  it('draws a line before each block that starts a new page', () => {
    const lines = computeLines(doc(['Intro para.', 'Second para.', 'Third para.']), map([
      ['intropara', 1], ['secondpara', 1], ['thirdpara', 2],
    ]));
    expect(lines).toEqual([{ pos: 13 + 14, page: 2, skipped: 0 }]);
  });

  it('skips blocks only one side has, and empty fingerprints (raw page breaks)', () => {
    // Editor has a `\newpage` paragraph the map records as a keyless raw block;
    // the map has a bibliography the editor does not.
    const lines = computeLines(doc(['Intro.', '\\newpage', 'Body.']), map([
      ['intro', 1], ['', 1], ['body', 2], ['references', 2], ['smith2024', 3],
    ]));
    expect(lines).toEqual([{ pos: 8 + 10, page: 2, skipped: 0 }]);
  });

  it('reports pages that begin inside a long block', () => {
    const lines = computeLines(doc(['A', 'B']), map([['a', 1], ['b', 3]]));
    expect(lines).toEqual([{ pos: 3, page: 3, skipped: 1 }]);
  });

  it('gives up on a block it cannot find within the window instead of mis-aligning', () => {
    const lines = computeLines(doc(['Alpha', 'Beta', 'Gamma']), map([
      ['alpha', 1], ['x1', 1], ['x2', 1], ['x3', 1], ['x4', 1], ['beta', 2], ['gamma', 2],
    ]));
    // beta is 5 entries ahead — outside the window — so its page is unknown;
    // gamma then matches (window slides from alpha) … no: gamma is 6 ahead. Nothing drawn.
    expect(lines).toEqual([]);
  });
});
