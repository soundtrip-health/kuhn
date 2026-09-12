import { describe, expect, it } from 'vitest';
import { pageBreakMarker, transformPageBreaks } from './page-break-chip';

const para = (text: string) => ({ type: 'paragraph', children: [{ type: 'text', value: text }] });

describe('page-break chip (remark side)', () => {
  it('recognizes a paragraph that is exactly one marker', () => {
    expect(pageBreakMarker(para('\\newpage'))).toBe('\\newpage');
    expect(pageBreakMarker(para('  \\pagebreak\n'))).toBe('\\pagebreak');
    expect(pageBreakMarker(para('\\clearpage'))).toBe('\\clearpage');
    expect(pageBreakMarker(para('Inline \\newpage here'))).toBe(null);
    expect(pageBreakMarker(para('\\newpages'))).toBe(null);
    expect(pageBreakMarker({ type: 'paragraph', children: [{ type: 'text', value: '\\newpage' }, { type: 'emphasis', children: [] }] })).toBe(null);
    expect(pageBreakMarker({ type: 'heading', children: [{ type: 'text', value: '\\newpage' }] })).toBe(null);
  });

  it('rewrites marker paragraphs anywhere in the tree, leaving the rest alone', () => {
    const tree = {
      type: 'root',
      children: [para('Intro'), para('\\newpage'), { type: 'blockquote', children: [para('\\pagebreak')] }, para('End')],
    };
    transformPageBreaks(tree);
    expect(tree.children.map((c) => c.type)).toEqual(['paragraph', 'pageBreak', 'blockquote', 'paragraph']);
    expect((tree.children[1] as { value?: string }).value).toBe('\\newpage');
    expect((tree.children[2] as { children: { type: string }[] }).children[0].type).toBe('pageBreak');
  });
});
