// Comment anchoring (story 008-004, issue #149): find a thread's quoted text
// in the open ProseMirror doc. Pure functions — comments.ts owns the
// decorations and the panel; this module owns "where does this quote live".
//
// A quote is whatever its author saw: a PI selection is rendered editor text
// (via textBetween, which includes atom leafText), an agent quote is a slice
// of the markdown source. The doc is flattened to one string with a
// per-character map back to positions, and the quote is searched on a ladder
// from exact to increasingly forgiving. Issue #149: agent quotes that crossed
// a citation chip never matched, because the flattened text skipped atoms —
// `[@key]` was in the quote but not the haystack — so the reviewer's threads
// had no highlight and clicking them scrolled nowhere. Atoms now contribute
// their leafText, and a last rung anchors the longest line of a quote whose
// other lines (a table, say) cannot be reduced to rendered text.

import type { Node as PMNode } from '@milkdown/kit/prose/model';

export interface DocText {
  text: string;
  /** pos[i] = PM position of text[i]. */
  pos: number[];
}

export interface Range {
  from: number;
  to: number;
}

/** Shortest partial-line match that is unlikely to be a coincidence. */
const MIN_PARTIAL = 12;

/**
 * The doc's visible text as one string; blocks join with single newlines.
 * Inline leaf atoms (citation chips) contribute their leafText — the same
 * text `textBetween` gives a PI selection and the markdown source holds —
 * with every character mapped to the atom's own position.
 */
export function docTextOf(doc: PMNode): DocText {
  let text = '';
  const pos: number[] = [];
  doc.descendants((node, p) => {
    if (!node.isTextblock) return true;
    node.descendants((child, cp) => {
      const at = p + 1 + cp;
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) {
          text += child.text[i];
          pos.push(at + i);
        }
      } else if (child.isLeaf && child.type.spec.leafText) {
        const leaf = child.type.spec.leafText(child);
        for (let i = 0; i < leaf.length; i++) {
          text += leaf[i];
          pos.push(at);
        }
      }
      return true;
    });
    text += '\n';
    pos.push(p + node.nodeSize - 1);
    return false;
  });
  return { text, pos };
}

/**
 * Find a quote in the doc text. Ladder: exact (blank-line runs collapsed) →
 * whitespace-normalized → markdown-syntax-stripped (agent quotes come from
 * the markdown source; the rendered doc has no `**` or `#`) → the longest
 * single line of the stripped quote, so a passage that is only partly
 * reducible to rendered text still gets a highlight to scroll to. The
 * occurrence nearest the stored start hint wins.
 */
export function anchorInDoc(doc: DocText, quote: string, hint: number | null): Range | null {
  const exact = quote.replace(/\n{2,}/g, '\n');
  let idx = pickOccurrence(doc.text, exact, hint);
  if (idx != null) return spanToPositions(doc, idx, exact.length);

  const { norm, map } = normalizeWithMap(doc.text);
  const stripped = stripMarkdown(quote);
  const longestLine = stripped
    .split('\n')
    .map(collapseWs)
    .reduce((best, line) => (line.length > best.length ? line : best), '');
  const candidates = [collapseWs(quote), collapseWs(stripped)];
  if (longestLine.length >= MIN_PARTIAL) candidates.push(longestLine);
  for (const candidate of candidates) {
    if (!candidate) continue;
    idx = pickOccurrence(norm, candidate, hint);
    if (idx != null) {
      const start = map[idx];
      const end = map[idx + candidate.length - 1] + 1;
      return spanToPositions(doc, start, end - start);
    }
  }
  return null;
}

function spanToPositions(doc: DocText, start: number, length: number): Range {
  return { from: doc.pos[start], to: doc.pos[start + length - 1] + 1 };
}

export function pickOccurrence(haystack: string, needle: string, hint: number | null): number | null {
  const occ: number[] = [];
  let from = 0;
  while (occ.length < 50) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    occ.push(i);
    from = i + 1;
  }
  if (occ.length === 0) return null;
  if (hint == null || occ.length === 1) return occ[0];
  return occ.reduce((best, o) => (Math.abs(o - hint) < Math.abs(best - hint) ? o : best));
}

export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Strip markdown block/inline syntax so a source-quoted string can match the
 *  rendered text (same normalization family as suggestion-hunks). Citation
 *  groups are kept: the chip's leafText puts them in the doc text too. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*|__|[*_`~]/g, '');
}

/** Whitespace runs → single spaces, with map[i] = raw offset of norm[i]. */
function normalizeWithMap(content: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < content.length; i++) {
    if (/\s/.test(content[i])) {
      inSpace = true;
      continue;
    }
    if (inSpace && norm.length > 0) {
      norm += ' ';
      map.push(i - 1);
    }
    inSpace = false;
    norm += content[i];
    map.push(i);
  }
  return { norm, map };
}
