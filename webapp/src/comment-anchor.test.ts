// Issue #149: agent comments (quotes sliced from the markdown source) must
// anchor in the rendered doc — including across citation chips, which used
// to drop out of the flattened text and orphan every thread that quoted one.

import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/kit/prose/model';

import { anchorInDoc, docTextOf, stripMarkdown } from './comment-anchor';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    citation: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { group: { default: '' } },
      leafText: (node) => `[${node.attrs.group}]`,
    },
  },
  marks: { strong: {} },
});

const p = (...content: Array<string | ReturnType<typeof schema.node>>) =>
  schema.node('paragraph', null, content.map((c) => (typeof c === 'string' ? schema.text(c) : c)));
const cite = (group: string) => schema.node('citation', { group });
const doc = (...paras: ReturnType<typeof schema.node>[]) => schema.node('doc', null, paras);

describe('docTextOf', () => {
  it('flattens text blocks and includes atom leafText mapped to the atom position', () => {
    const d = doc(p('as shown ', cite('@lewis2023'), ' before'), p('next'));
    const flat = docTextOf(d);
    expect(flat.text).toBe('as shown [@lewis2023] before\nnext\n');
    // 'a' of 'as' sits at pos 1; the chip occupies one position after 9 chars.
    expect(flat.pos[0]).toBe(1);
    const chipStart = flat.text.indexOf('[');
    const chipEnd = flat.text.indexOf(']');
    expect(flat.pos[chipStart]).toBe(10);
    expect(flat.pos[chipEnd]).toBe(10);
    expect(flat.pos[chipEnd + 1]).toBe(11);
  });
});

describe('anchorInDoc', () => {
  const d = doc(
    p('Detection at scale and its evasion of expert review ', cite('@sallam2023; @adel2025'), ', with correction.'),
    p('A second paragraph that is long enough to matter.'),
  );
  const flat = docTextOf(d);

  it('anchors an agent quote that spans a citation chip', () => {
    const range = anchorInDoc(flat, 'evasion of expert review [@sallam2023; @adel2025], with', null);
    expect(range).not.toBeNull();
    expect(d.textBetween(range!.from, range!.to, '\n', '')).toBe('evasion of expert review [@sallam2023; @adel2025], with');
  });

  it('anchors a PI selection quote taken from textBetween', () => {
    const quote = d.textBetween(38, 60, '\n', '');
    const range = anchorInDoc(flat, quote, 38);
    expect(range).toEqual({ from: 38, to: 60 });
  });

  it('strips markdown emphasis and headings from source quotes', () => {
    expect(anchorInDoc(flat, '**Detection at scale** and its evasion', null)).toEqual({ from: 1, to: 35 });
    expect(anchorInDoc(flat, '## A second paragraph', null)).not.toBeNull();
  });

  it('falls back to the longest line of a quote it cannot fully reduce', () => {
    const quote = '| col | col |\n|---|---|\nA second paragraph that is long enough to matter.';
    const range = anchorInDoc(flat, quote, null);
    expect(range).not.toBeNull();
    expect(d.textBetween(range!.from, range!.to, '\n', '')).toBe('A second paragraph that is long enough to matter.');
  });

  it('returns null when nothing recognisable is in the doc', () => {
    expect(anchorInDoc(flat, 'text that was deleted', null)).toBeNull();
    expect(anchorInDoc(flat, '| only | a |\n| table | here |', null)).toBeNull();
  });
});

describe('stripMarkdown', () => {
  it('keeps citation groups so they match the chip leafText', () => {
    expect(stripMarkdown('see **this** [@a; @b] and [a link](http://x)')).toBe('see this [@a; @b] and a link');
  });
});
