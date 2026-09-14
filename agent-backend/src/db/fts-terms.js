/**
 * FTS5 query hygiene shared by every Kuhn full-text index (the feature guide,
 * issue #170; project memory, issue #150). FTS5 has its own operator syntax
 * (AND / OR / NOT, quotes, column filters, prefix stars), so free text — a
 * user question, an agent's task text — is never passed to MATCH as is:
 * every term is stripped of operator characters and quoted so it matches
 * as a literal word.
 */

/**
 * Question words carry no signal and, with an OR fallback, would match every
 * row ("how do I export to word" must rank on export/word). Dropped only
 * when a content word remains.
 */
export const STOPWORDS = new Set((
  'a an and are as at be but by can do does for from how i in is it its my not of on or that the '
  + 'this to what when where which who why with you your'
).split(' '));

/**
 * Split free text into quoted FTS5 terms. Operator characters are removed
 * from each term; stopwords are dropped when any content word remains;
 * repeated terms are kept once.
 * @param {string} query
 * @param {{ max?: number, stopwords?: Set<string>, keepStopwords?: boolean }} [opts]
 *   - cap on the number of terms (default: all), the stopword set (default
 *   STOPWORDS), and whether a query of only stopwords falls back to them
 *   (default true — a search box query is always a search) or yields []
 * @returns {string[]} e.g. ['"arXiv"', '"references"']
 */
export function sanitizeFtsTerms(query, { max = Infinity, stopwords = STOPWORDS, keepStopwords = true } = {}) {
  const terms = String(query ?? '')
    .split(/\s+/)
    .map((term) => term.replace(/["*:^(){}?,.!;'`<>[\]\\|]/g, ''))
    .filter(Boolean);
  const content = terms.filter((t) => !stopwords.has(t.toLowerCase()));
  const chosen = content.length ? content : (keepStopwords ? terms : []);
  const unique = [];
  const seen = new Set();
  for (const term of chosen) {
    const k = term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(term);
    if (unique.length >= max) break;
  }
  return unique.map((term) => `"${term}"`);
}

/** Stem-ish prefix for coverage counting (porter does the real stemming in FTS). */
export function stemTerm(term) {
  const t = term.replace(/"/g, '').toLowerCase();
  return t.length > 5 ? t.slice(0, Math.max(4, t.length - 2)) : t.replace(/s$/, '');
}
