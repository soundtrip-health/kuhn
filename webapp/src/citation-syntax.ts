// Pandoc citation syntax (issue #146). Pure string helpers shared by the
// editor chip (citation.ts) so they can be unit-tested without Milkdown.
//
// A citation *group* is one bracketed span holding one or more `@key`
// segments separated by `;`, each optionally wrapped in prefix/suffix text
// and optionally prefixed with `-` to suppress the author:
//
//   [@lewis2023]                        single key
//   [@lewis2023; @smith2024]            group
//   [see @lewis2023, pp. 12-14; -@x]    prefix, locator, suppressed author
//
// The chip parser used to accept only the single-key form; every multi-key
// group stayed plain text and remark-stringify escaped its `[` to `\[` on
// save, which Pandoc citeproc then read as a literal bracket — no citation,
// no reference entry. The whole group is now one chip whose value is the
// raw inner text, so the source round-trips byte-for-byte.

const KEY = '[A-Za-z0-9_][A-Za-z0-9_:.+-]*';
const SEGMENT = `[^\\[\\];]*?-?@${KEY}[^\\[\\];]*?`;

/** Matches a whole bracketed citation group; capture 1 is the inner text. */
export const CITATION_GROUP_RE = new RegExp(`\\[(${SEGMENT}(?:;${SEGMENT})*)\\]`, 'g');

/** Matches one `-?@key` inside a segment; capture 1 is the key. */
export const CITATION_KEY_RE = new RegExp(`-?@(${KEY})`, 'g');

/** The cite keys of a group's inner text, in order, without `@`. */
export function citationKeys(group: string): string[] {
  return Array.from(group.matchAll(CITATION_KEY_RE), (m) => m[1]);
}

/** A run of literal text or one cite key, for rendering a chip's label. */
export type GroupPart = { kind: 'text'; text: string } | { kind: 'key'; key: string; text: string };

/** Split a group's inner text into literal runs and `@key` tokens. */
export function splitGroup(group: string): GroupPart[] {
  const parts: GroupPart[] = [];
  let last = 0;
  for (const match of group.matchAll(CITATION_KEY_RE)) {
    const index = match.index!;
    if (index > last) parts.push({ kind: 'text', text: group.slice(last, index) });
    parts.push({ kind: 'key', key: match[1], text: match[0] });
    last = index + match[0].length;
  }
  if (last < group.length) parts.push({ kind: 'text', text: group.slice(last) });
  return parts;
}

/**
 * Split a text run into literal runs and citation groups. Returns null when
 * the text holds no group, so callers can leave the node untouched.
 */
export function splitCitations(text: string): Array<{ type: 'text' | 'citation'; value: string }> | null {
  CITATION_GROUP_RE.lastIndex = 0;
  if (!CITATION_GROUP_RE.test(text)) return null;
  CITATION_GROUP_RE.lastIndex = 0;

  const out: Array<{ type: 'text' | 'citation'; value: string }> = [];
  let last = 0;
  for (const match of text.matchAll(CITATION_GROUP_RE)) {
    const index = match.index!;
    if (index > last) out.push({ type: 'text', value: text.slice(last, index) });
    out.push({ type: 'citation', value: match[1] });
    last = index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}
