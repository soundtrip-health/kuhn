// Citation chips (story 016): `[@citekey]` in markdown source renders as an
// inline atom chip in WYSIWYG mode and serializes back to plain `[@citekey]`.
//
// Round trip: a remark transform splits text nodes on the [@key] pattern into
// custom `citation` mdast nodes (parse side), and a toMarkdown handler emits
// the raw text again (serialize side — a plain text node would get its `[`
// backslash-escaped by remark-stringify). The ProseMirror node is an inline
// atom; hover tooltips resolve the key against the loaded bibliography.

import { $nodeSchema, $remark } from '@milkdown/kit/utils';

import { bibTooltip, currentBibPath } from './bib';

const CITATION_RE = /\[@([A-Za-z0-9_][A-Za-z0-9_:.+-]*)\]/g;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

function splitTextNode(node: MdNode): MdNode[] | null {
  const text = node.value ?? '';
  CITATION_RE.lastIndex = 0;
  if (!CITATION_RE.test(text)) return null;
  CITATION_RE.lastIndex = 0;

  const out: MdNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION_RE)) {
    const index = match.index!;
    if (index > last) out.push({ type: 'text', value: text.slice(last, index) });
    out.push({ type: 'citation', value: match[1] });
    last = index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

function transformTree(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') {
      return splitTextNode(child) ?? [child];
    }
    transformTree(child);
    return [child];
  });
}

export const remarkCitation = $remark('remark-citation', () =>
  function (this: { data: (key?: string) => unknown }) {
    // Register the serializer for citation mdast nodes on this processor
    const data = this.data() as Record<string, unknown[]>;
    const extensions = (data.toMarkdownExtensions ??= []);
    extensions.push({
      handlers: { citation: (node: MdNode) => `[@${node.value ?? ''}]` },
    });
    // Parse-side transform: [@key] arrives as plain text inside text nodes
    return (tree: MdNode) => transformTree(tree);
  } as never,
);

export const citationSchema = $nodeSchema('citation', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  marks: '',
  attrs: { key: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-citation-key]',
      getAttrs: (dom) => ({ key: (dom as HTMLElement).getAttribute('data-citation-key') ?? '' }),
    },
  ],
  toDOM: (node) => [
    'span',
    { class: 'citation-chip', 'data-citation-key': node.attrs.key as string },
    `@${node.attrs.key}`,
  ],
  leafText: (node) => `[@${node.attrs.key}]`,
  parseMarkdown: {
    match: (node) => node.type === 'citation',
    runner: (state, node, type) => {
      state.addNode(type, { key: (node.value as string) ?? '' });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'citation',
    runner: (state, node) => {
      state.addNode('citation', undefined, node.attrs.key as string);
    },
  },
}));

/** All plugins the citation chip needs; spread into Editor.use(). */
export const citationPlugins = [remarkCitation, citationSchema].flat();

/**
 * Hover tooltips via event delegation on the editor container — chips are
 * re-rendered by ProseMirror at will, so per-node listeners would leak.
 */
export function installCitationTooltips(container: HTMLElement): void {
  container.addEventListener('mouseover', (event) => {
    const chip = (event.target as HTMLElement).closest?.('.citation-chip');
    if (!(chip instanceof HTMLElement)) return;
    const key = chip.getAttribute('data-citation-key') ?? '';
    // Name the bibliography the project actually uses — it is no longer fixed
    // at draft/references.bib (story 012-001).
    chip.title = bibTooltip(key) ?? `@${key} — not found in ${currentBibPath()}`;
  });
}
