import { describe, expect, it } from 'vitest';
import { extractCitationKeys, rewriteCitations } from './citations.js';

const DOC = [
  'Rapid effects [@Berman2000] were replicated [@Zarate2006; @Berman2000].',
  'Suppressed author [-@Berman2000] and a locator [@Zarate2006, p. 858].',
  'Bare @Berman2000 mid-sentence, and one at the end of a sentence @Zarate2006.',
  'Not citations: trial-office@example.org, an escaped \\@Berman2000, and @@Berman2000.',
  'Longer key [@Berman2000a] must not be clipped; internal dots [@smith.2020] survive.',
].join('\n');

describe('extractCitationKeys', () => {
  it('finds every Pandoc form and skips emails, escapes and doubled @', () => {
    expect([...extractCitationKeys(DOC)].sort()).toEqual(
      ['Berman2000', 'Berman2000a', 'Zarate2006', 'smith.2020'].sort(),
    );
  });

  it('stops a key before trailing punctuation', () => {
    expect([...extractCitationKeys('See @Zarate2006. Also [@x:y].')]).toEqual(['Zarate2006', 'x:y']);
  });
});

describe('rewriteCitations', () => {
  it('rewrites all forms of a renamed key and nothing else', () => {
    const { text, counts } = rewriteCitations(DOC, { Berman2000: 'Berman2000b', Zarate2006: 'zarate2006' });
    expect(counts).toEqual({ Berman2000: 4, Zarate2006: 3 });
    expect(text).toContain('[@Berman2000b] were replicated [@zarate2006; @Berman2000b]');
    expect(text).toContain('[-@Berman2000b] and a locator [@zarate2006, p. 858]');
    expect(text).toContain('Bare @Berman2000b mid-sentence');
    expect(text).toContain('end of a sentence @zarate2006.');
    // untouched
    expect(text).toContain('trial-office@example.org');
    expect(text).toContain('\\@Berman2000,');
    expect(text).toContain('@@Berman2000.');
    expect(text).toContain('[@Berman2000a]');
    expect(text).toContain('[@smith.2020]');
  });

  it('is a no-op for an empty or identity map', () => {
    expect(rewriteCitations(DOC, {})).toEqual({ text: DOC, counts: {} });
    expect(rewriteCitations(DOC, { Berman2000: 'Berman2000' })).toEqual({ text: DOC, counts: {} });
  });

  it('handles keys with regex metacharacters', () => {
    const { text } = rewriteCitations('[@a.b+c]', { 'a.b+c': 'abc' });
    expect(text).toBe('[@abc]');
  });
});
