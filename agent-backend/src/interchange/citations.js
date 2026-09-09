// Pandoc citation keys in markdown (issue #153): find them, and rewrite the
// ones an import had to rename (docs/specs/interchange-bundle.md §3).
//
// Key grammar follows Pandoc: a letter, digit or `_`, then letters, digits,
// `_`, or internal punctuation (`:.#$%&-+?<>~/`) that must be followed by an
// alphanumeric — so the `.` in `[@smith2020.]` is not part of the key. An `@`
// only starts a citation when it is not glued to a preceding word character
// (emails like bob@lab.org are left alone), a backslash (`\@` is escaped), or
// another `@`.

const KEY_BODY = String.raw`[A-Za-z0-9_](?:[A-Za-z0-9_]|[:.#$%&\-+?<>~/](?=[A-Za-z0-9_]))*`;
const CITATION_RE = new RegExp(String.raw`(^|[^\w\\@])@(${KEY_BODY})`, 'g');
/** Boundary after a key: nothing that could extend it. */
const KEY_TAIL_RE = /(?![A-Za-z0-9_]|[:.#$%&\-+?<>~/][A-Za-z0-9_])/;

/** Every distinct citation key in `text`. */
export function extractCitationKeys(text) {
  const keys = new Set();
  for (const m of String(text ?? '').matchAll(CITATION_RE)) keys.add(m[2]);
  return keys;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Replace `@old` with `@new` for every pair in `keyMap`, in all Pandoc forms
 * (`[@k]`, `[@a; @b]`, `[-@k]`, `[@k, p. 3]`, bare `@k`).
 * @param {string} text
 * @param {Record<string, string>} keyMap old key → new key
 * @returns {{text: string, counts: Record<string, number>}} counts per OLD key
 */
export function rewriteCitations(text, keyMap) {
  const pairs = Object.entries(keyMap ?? {}).filter(([from, to]) => from && to && from !== to);
  if (pairs.length === 0) return { text, counts: {} };
  const counts = {};
  let out = String(text ?? '');
  // Longest keys first so `smith2020a` is never partially matched by `smith2020`
  // (the tail boundary already prevents it; the ordering is belt and braces).
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) {
    const re = new RegExp(String.raw`(^|[^\w\\@])@${escapeRe(from)}${KEY_TAIL_RE.source}`, 'g');
    out = out.replace(re, (_m, lead) => {
      counts[from] = (counts[from] ?? 0) + 1;
      return `${lead}@${to}`;
    });
  }
  return { text: out, counts };
}
