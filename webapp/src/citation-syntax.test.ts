// Issue #146: multi-key citation groups (`[@a; @b]`) never became chips, so
// the markdown serializer escaped their `[` on every save and Pandoc stopped
// seeing a citation. These pin the group grammar the chip parser now uses.

import { describe, expect, it } from 'vitest';

import { citationKeys, restoreTodoMarkers, splitCitations, splitGroup } from './citation-syntax';

describe('restoreTodoMarkers', () => {
  it('un-escapes the bracket of a TODO marker and nothing else', () => {
    expect(restoreTodoMarkers('a \\[TODO: verify] marker and \\[TODO] and \\[other]')).toBe(
      'a [TODO: verify] marker and [TODO] and \\[other]',
    );
    expect(restoreTodoMarkers('\\[TODOS are not markers]')).toBe('\\[TODOS are not markers]');
  });
});

describe('splitCitations', () => {
  it('leaves text without a citation untouched', () => {
    expect(splitCitations('plain prose, [TODO: verify] and a [link](x)')).toBeNull();
    expect(splitCitations('an email me@example.com')).toBeNull();
  });

  it('splits a single-key citation out of surrounding text', () => {
    expect(splitCitations('as shown [@lewis2023] before.')).toEqual([
      { type: 'text', value: 'as shown ' },
      { type: 'citation', value: '@lewis2023' },
      { type: 'text', value: ' before.' },
    ]);
  });

  it('keeps a multi-key group as one citation with its inner text verbatim', () => {
    expect(splitCitations('review [@sallam2023; @adel2025; @ansari2026], with')).toEqual([
      { type: 'text', value: 'review ' },
      { type: 'citation', value: '@sallam2023; @adel2025; @ansari2026' },
      { type: 'text', value: ', with' },
    ]);
  });

  it('accepts prefixes, locators and suppressed authors', () => {
    const [, cite] = splitCitations('x [see @doe99, pp. 33-35; also -@smith04, chap. 1] y')!;
    expect(cite).toEqual({ type: 'citation', value: 'see @doe99, pp. 33-35; also -@smith04, chap. 1' });
  });

  it('handles several groups in one run and keys with punctuation', () => {
    expect(splitCitations('[@a.b:c+d-e][@f]')).toEqual([
      { type: 'citation', value: '@a.b:c+d-e' },
      { type: 'citation', value: '@f' },
    ]);
  });

  it('does not match brackets that lack a key or nest', () => {
    expect(splitCitations('[no key here]')).toBeNull();
    expect(splitCitations('[@]')).toBeNull();
    expect(splitCitations('[[@a]]')).toEqual([
      { type: 'text', value: '[' },
      { type: 'citation', value: '@a' },
      { type: 'text', value: ']' },
    ]);
  });
});

describe('citationKeys / splitGroup', () => {
  it('lists every key in order, without the @ or the suppress marker', () => {
    expect(citationKeys('@a')).toEqual(['a']);
    expect(citationKeys('see @doe99, p. 3; also -@smith04')).toEqual(['doe99', 'smith04']);
  });

  it('splits a group into literal runs and key tokens for the chip label', () => {
    expect(splitGroup('@sallam2023; @adel2025')).toEqual([
      { kind: 'key', key: 'sallam2023', text: '@sallam2023' },
      { kind: 'text', text: '; ' },
      { kind: 'key', key: 'adel2025', text: '@adel2025' },
    ]);
    expect(splitGroup('see -@x, p. 1')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'key', key: 'x', text: '-@x' },
      { kind: 'text', text: ', p. 1' },
    ]);
  });
});
