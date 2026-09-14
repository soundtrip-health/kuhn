import { describe, expect, it } from 'vitest';
import { splitFrontMatter, withStoredFrontMatter } from './front-matter.js';

const FM = '---\npage_limits:\n  Specific Aims: 1\ntemplate: nih-grant\n---\n';

describe('front matter', () => {
  it('splits a leading block and leaves everything else alone', () => {
    expect(splitFrontMatter(`${FM}# Title\n\nBody.\n`)).toEqual({ frontMatter: FM, body: '# Title\n\nBody.\n' });
    expect(splitFrontMatter('# Title\n\n---\n\nnot front matter\n')).toEqual({ frontMatter: '', body: '# Title\n\n---\n\nnot front matter\n' });
    expect(splitFrontMatter(null)).toEqual({ frontMatter: '', body: '' });
    expect(splitFrontMatter(Buffer.from(`${FM}x`))).toEqual({ frontMatter: FM, body: 'x' });
    // CRLF files keep their block byte-for-byte.
    const crlf = '---\r\ntemplate: nih-grant\r\n---\r\n';
    expect(splitFrontMatter(`${crlf}Body`).frontMatter).toBe(crlf);
  });

  it('re-attaches the stored block to a body-only write', () => {
    expect(withStoredFrontMatter(`${FM}old body`, '# New body\n')).toBe(`${FM}# New body\n`);
    expect(withStoredFrontMatter('no block here', '# New body\n')).toBe('# New body\n');
    expect(withStoredFrontMatter(null, '# New body\n')).toBe('# New body\n');
    expect(withStoredFrontMatter(Buffer.from(`${FM}old`), Buffer.from('new'))).toBe(`${FM}new`);
  });

  it('never doubles a block the client did not strip', () => {
    expect(withStoredFrontMatter(`${FM}old`, `${FM}full write`)).toBe(`${FM}full write`);
    const other = '---\ntemplate: manuscript\n---\n';
    expect(withStoredFrontMatter(`${FM}old`, `${other}full write`)).toBe(`${other}full write`);
  });
});
