// Page-break lines in the rich editor. The PDF preview is the ground truth
// for pagination (Typst, with the document's template); after each render the
// backend returns a page map — the page and vertical offset where every
// top-level Pandoc block starts (pandoc-filters/blockmarks.lua). This module
// matches those blocks to the editor's top-level nodes by a text fingerprint
// and draws a dashed "Page N" line before each block that starts a new page.
// The lines are exact for the render they came from; edits after it make
// them stale (dimmed) until the next render. Slide decks get none.

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';

export interface PageMapBlock {
  key: string;
  page: number;
  y: number;
}

/** A heading with a `page_limits:` budget, measured by the backend (fractional pages). */
export interface PageMapSection {
  /** Index into `blocks` of the heading. */
  index: number;
  title: string;
  key: string;
  page: number;
  pages: number;
  limit: number;
  over: boolean;
}

export interface PageMap {
  pages: number;
  pageHeight: number | null;
  blocks: PageMapBlock[];
  end: { page: number; y: number };
  sections?: PageMapSection[];
}

const key = new PluginKey<DecorationSet>('kuhn-page-breaks');
type Meta = { type: 'set'; decos: Decoration[] } | { type: 'clear' };

const STALE_CLASS = 'pb-stale';
/** Fingerprint length — must match KEY_LEN in blockmarks.lua. */
export const KEY_LEN = 24;
/** How far ahead in the page map a block may be matched (Pandoc may see blocks the editor does not, and vice versa). */
const MATCH_WINDOW = 4;

/** Same normalization as blockmarks.lua: lower-case, ASCII letters/digits only, first KEY_LEN. */
export function blockKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, KEY_LEN);
}

export const pageBreaksPlugin = $prose(() => new Plugin<DecorationSet>({
  key,
  state: {
    init: () => DecorationSet.empty,
    apply(tr: Transaction, set: DecorationSet): DecorationSet {
      const meta = tr.getMeta(key) as Meta | undefined;
      if (meta?.type === 'set') return DecorationSet.create(tr.doc, meta.decos);
      if (meta?.type === 'clear') return DecorationSet.empty;
      return set.map(tr.mapping, tr.doc);
    },
  },
  props: { decorations: (state: EditorState) => key.getState(state) },
  view: () => ({
    update: (view: EditorView, prevState: EditorState): void => {
      // Any edit after a render may move the breaks: dim the lines until the
      // next render replaces them.
      if (!prevState.doc.eq(view.state.doc) && (key.getState(view.state)?.find().length ?? 0) > 0) {
        view.dom.classList.add(STALE_CLASS);
      }
    },
  }),
}));

/** Editor-side view of one page break: draw the line before the node at `pos`. */
export interface PageBreakLine {
  pos: number;
  page: number;
  /** Pages that started inside the previous block (a long paragraph spanning a break). */
  skipped: number;
}

/** One editor block matched to one page-map block. */
export interface Aligned {
  /** Index into map.blocks. */
  index: number;
  pos: number;
  nodeSize: number;
}

/**
 * Align the page map with the editor's top-level blocks. Greedy, in order:
 * each editor block looks a few map entries ahead for its fingerprint;
 * blocks Pandoc merged, split or invented (bibliography, raw markers) are
 * skipped on whichever side lacks them. Pure — exported for tests.
 */
export function alignBlocks(doc: EditorState['doc'], map: PageMap): Aligned[] {
  const out: Aligned[] = [];
  let j = 0;
  doc.forEach((node, offset) => {
    const k = blockKey(node.textContent);
    if (!k) return;
    for (let m = j; m < map.blocks.length && m < j + MATCH_WINDOW; m += 1) {
      if (map.blocks[m].key === k) {
        out.push({ index: m, pos: offset, nodeSize: node.nodeSize });
        j = m + 1;
        return;
      }
    }
  });
  return out;
}

/** The page-break lines: one before each matched block that starts a later page than the last matched one. */
export function computeLines(doc: EditorState['doc'], map: PageMap): PageBreakLine[] {
  const lines: PageBreakLine[] = [];
  let lastPage = 1;
  for (const a of alignBlocks(doc, map)) {
    const page = map.blocks[a.index].page;
    if (page > lastPage) {
      lines.push({ pos: a.pos, page, skipped: page - lastPage - 1 });
      lastPage = page;
    }
  }
  return lines;
}

/** A budget badge: drawn at the end of the heading's text. */
export interface SectionBadge {
  pos: number;
  section: PageMapSection;
}

export function computeBadges(doc: EditorState['doc'], map: PageMap): SectionBadge[] {
  const sections = map.sections ?? [];
  if (sections.length === 0) return [];
  const byIndex = new Map(alignBlocks(doc, map).map((a) => [a.index, a]));
  const badges: SectionBadge[] = [];
  for (const section of sections) {
    const a = byIndex.get(section.index);
    if (a) badges.push({ pos: a.pos + a.nodeSize - 1, section });
  }
  return badges;
}

/** "1.07" → "1.07", "1.00" → "1", "0.50" → "0.5". */
const fmtPages = (n: number): string => n.toFixed(2).replace(/\.?0+$/, '');

function badgeWidget(section: PageMapSection): HTMLElement {
  const el = document.createElement('span');
  el.className = `pb-limit${section.over ? ' is-over' : ''}`;
  el.contentEditable = 'false';
  el.textContent = `${fmtPages(section.pages)} / ${section.limit} page${section.limit === 1 ? '' : 's'}`;
  el.title = section.over
    ? `"${section.title}" runs ${fmtPages(section.pages)} pages against a ${section.limit}-page limit (page_limits front matter) — from the last render`
    : `"${section.title}" fits its ${section.limit}-page limit (${fmtPages(section.pages)} pages at the last render)`;
  return el;
}

function lineWidget(line: PageBreakLine): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pb-break';
  el.contentEditable = 'false';
  el.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = line.skipped > 0
    ? `Page ${line.page} · page ${line.page - line.skipped} starts inside the block above`
    : `Page ${line.page}`;
  el.append(label);
  return el;
}

function pageCountEl(): HTMLElement | null {
  return document.getElementById('editor-pagecount');
}

/** Paint the page map's breaks into the editor and the page count into the status bar. */
export function applyPageMap(view: EditorView | null, map: PageMap | null): void {
  const el = pageCountEl();
  if (!view || !map) {
    clearPageMap(view);
    return;
  }
  const decos = computeLines(view.state.doc, map).map((line) => Decoration.widget(
    line.pos,
    () => lineWidget(line),
    { key: `pb-${line.page}`, side: -1, ignoreSelection: true, stopEvent: () => true },
  ));
  for (const badge of computeBadges(view.state.doc, map)) {
    decos.push(Decoration.widget(
      badge.pos,
      () => badgeWidget(badge.section),
      { key: `pb-limit-${badge.section.index}`, side: 1, ignoreSelection: true, stopEvent: () => true },
    ));
  }
  view.dispatch(view.state.tr.setMeta(key, { type: 'set', decos } satisfies Meta));
  view.dom.classList.remove(STALE_CLASS);
  if (el) {
    const fill = map.pageHeight ? Math.round((map.end.y / map.pageHeight) * 100) : null;
    const over = (map.sections ?? []).filter((s) => s.over);
    el.textContent = `${map.pages} page${map.pages === 1 ? '' : 's'}${fill != null ? ` (last ${fill}% full)` : ''}`
      + (over.length ? ` · over limit: ${over.map((s) => `${s.title} ${fmtPages(s.pages)}/${s.limit}`).join(', ')}` : '');
    el.classList.toggle('is-over', over.length > 0);
    el.title = 'From the last PDF render — re-render the preview after editing to refresh';
    el.hidden = false;
  }
}

/** Remove the lines and the page count (document closed, slide deck, render failed). */
export function clearPageMap(view: EditorView | null): void {
  if (view && (key.getState(view.state)?.find().length ?? 0) > 0) {
    view.dispatch(view.state.tr.setMeta(key, { type: 'clear' } satisfies Meta));
  }
  view?.dom.classList.remove(STALE_CLASS);
  const el = pageCountEl();
  if (el) {
    el.textContent = '';
    el.classList.remove('is-over');
    el.hidden = true;
  }
}
