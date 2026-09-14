import { describe, expect, it } from 'vitest';
import { splitFrontMatter, stripFrontMatter } from './front-matter';

const FM = '---\ntemplate: nih-grant\npage_limits:\n  Specific Aims: 1\n---\n';

describe('front matter (client side)', () => {
  it('splits only a block that starts on line 1', () => {
    expect(splitFrontMatter(`${FM}# Title\n`)).toEqual({ frontMatter: FM, body: '# Title\n' });
    expect(splitFrontMatter('# Title\n\n---\n\ntext\n').frontMatter).toBe('');
    expect(splitFrontMatter('')).toEqual({ frontMatter: '', body: '' });
  });

  it('strips for the editor and passes null through', () => {
    expect(stripFrontMatter(`${FM}body`)).toBe('body');
    expect(stripFrontMatter('body')).toBe('body');
    expect(stripFrontMatter(null)).toBeNull();
  });
});
