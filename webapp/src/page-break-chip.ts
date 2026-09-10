// Page-break chips: a `\newpage` line in markdown (Pandoc / R Markdown's
// explicit page break — pagebreak.lua turns it into a Typst/docx/LaTeX break)
// renders as one block atom chip in the rich editor instead of a bare
// "\newpage" paragraph, and serializes back to the same line. `\pagebreak`
// and `\clearpage` are accepted on the way in and preserved on the way out.
//
// Round trip (same shape as citation.ts): a remark transform turns a
// paragraph whose only content is the marker into a custom `pageBreak` mdast
// node (parse side); a toMarkdown handler emits the raw marker (serialize
// side). The block-edit menu's "Page break" item (editor.ts) inserts the node.

import { $nodeSchema, $remark } from '@milkdown/kit/utils';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: unknown;
}

const MARKER = /^\\(newpage|pagebreak|clearpage)\s*$/;
export const DEFAULT_MARKER = '\\newpage';

/** The raw marker when a paragraph is exactly one, else null. */
export function pageBreakMarker(paragraph: MdNode): string | null {
  const kids = paragraph.children ?? [];
  if (paragraph.type !== 'paragraph' || kids.length !== 1 || kids[0].type !== 'text') return null;
  const value = (kids[0].value ?? '').trim();
  return MARKER.test(value) ? value : null;
}

/** Parse-side transform (exported for tests): marker paragraphs → pageBreak nodes. */
export function transformPageBreaks(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    const marker = pageBreakMarker(child);
    if (marker) return { type: 'pageBreak', value: marker } as MdNode;
    transformPageBreaks(child);
    return child;
  });
}

export const remarkPageBreak = $remark('remark-page-break', () =>
  function (this: { data: (key?: string) => unknown }) {
    const data = this.data() as Record<string, unknown[]>;
    const extensions = (data.toMarkdownExtensions ??= []);
    extensions.push({ handlers: { pageBreak: (node: MdNode) => node.value ?? DEFAULT_MARKER } });
    return (tree: MdNode) => transformPageBreaks(tree);
  } as never,
);

export const pageBreakSchema = $nodeSchema('page_break', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  marks: '',
  attrs: { marker: { default: DEFAULT_MARKER } },
  parseDOM: [{
    tag: 'div[data-page-break]',
    getAttrs: (dom) => ({ marker: (dom as HTMLElement).getAttribute('data-page-break') || DEFAULT_MARKER }),
  }],
  toDOM: (node) => [
    'div',
    { class: 'page-break-chip', 'data-page-break': node.attrs.marker as string, contenteditable: 'false' },
    ['span', { class: 'page-break-chip-label' }, 'Page break'],
  ] as never,
  parseMarkdown: {
    match: (node) => node.type === 'pageBreak',
    runner: (state, node, type) => {
      state.addNode(type, { marker: (node.value as string) || DEFAULT_MARKER });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'page_break',
    runner: (state, node) => {
      state.addNode('pageBreak', undefined, (node.attrs.marker as string) || DEFAULT_MARKER);
    },
  },
}));

/** All plugins the page-break chip needs; spread into Editor.use(). */
export const pageBreakPlugins = [remarkPageBreak, pageBreakSchema].flat();
