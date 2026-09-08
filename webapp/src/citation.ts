// Citation chips (story 016): a Pandoc citation group in markdown source —
// `[@citekey]`, or `[@a; @b]`, or `[see @a, p. 3; -@b]` — renders as one
// inline atom chip in WYSIWYG mode and serializes back to the same text.
//
// Round trip: a remark transform splits text nodes on the group pattern
// (citation-syntax.ts) into custom `citation` mdast nodes whose value is the
// raw inner text (parse side), and a toMarkdown handler emits the brackets
// around it again (serialize side — a plain text node would get its `[`
// backslash-escaped by remark-stringify, which is exactly what happened to
// multi-key groups before issue #146: they never became chips, so every save
// wrote `\[@a; @b]` and Pandoc citeproc stopped seeing a citation). The
// ProseMirror node is an inline atom; hovering a key inside it opens the
// citation card (cite-card.ts), which resolves the key against the loaded
// bibliography (STH-42).

import { $nodeSchema, $remark } from '@milkdown/kit/utils';

import { citationKeys, restoreTodoMarkers, splitCitations, splitGroup } from './citation-syntax';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** The slice of mdast-util-to-markdown's State a text handler needs. */
interface SerializeState {
  safe: (value: string, info: unknown) => string;
}

function transformTree(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') {
      return (splitCitations(child.value ?? '') as MdNode[] | null) ?? [child];
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
      handlers: {
        citation: (node: MdNode) => `[${node.value ?? ''}]`,
        // The stock text handler plus un-escaping of `[TODO: ...]` markers,
        // which stay editable plain text (see citation-syntax.ts).
        text: (node: MdNode, _parent: unknown, state: SerializeState, info: unknown) =>
          restoreTodoMarkers(state.safe(node.value ?? '', info)),
      },
    });
    // Parse-side transform: groups arrive as plain text inside text nodes
    return (tree: MdNode) => transformTree(tree);
  } as never,
);

/** The chip's DOM: literal runs as text, each `@key` as a hoverable span. */
function chipDom(group: string): [string, Record<string, string>, ...unknown[]] {
  const keys = citationKeys(group);
  const attrs: Record<string, string> = { class: 'citation-chip', 'data-citation-group': group };
  // Single-key chips also carry the key on the chip itself, for selectors
  // that predate groups (cite-check.mjs).
  if (keys.length === 1 && group.trim() === `@${keys[0]}`) attrs['data-citation-key'] = keys[0];
  const parts = splitGroup(group).map((part) =>
    part.kind === 'key'
      ? ['span', { class: 'citation-key', 'data-citation-key': part.key }, part.text]
      : part.text,
  );
  return ['span', attrs, ...parts];
}

export const citationSchema = $nodeSchema('citation', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  marks: '',
  // `group` is the raw text between the brackets, e.g. `@a; @b`.
  attrs: { group: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-citation-group]',
      getAttrs: (dom) => ({ group: (dom as HTMLElement).getAttribute('data-citation-group') ?? '' }),
    },
    {
      // Pre-#146 chips pasted from another editor tab.
      tag: 'span.citation-chip[data-citation-key]',
      getAttrs: (dom) => ({ group: `@${(dom as HTMLElement).getAttribute('data-citation-key') ?? ''}` }),
    },
  ],
  toDOM: (node) => chipDom(node.attrs.group as string) as never,
  leafText: (node) => `[${node.attrs.group}]`,
  parseMarkdown: {
    match: (node) => node.type === 'citation',
    runner: (state, node, type) => {
      state.addNode(type, { group: (node.value as string) ?? '' });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'citation',
    runner: (state, node) => {
      state.addNode('citation', undefined, node.attrs.group as string);
    },
  },
}));

/** All plugins the citation chip needs; spread into Editor.use(). */
export const citationPlugins = [remarkCitation, citationSchema].flat();
