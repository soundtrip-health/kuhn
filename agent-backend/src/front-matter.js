/**
 * Leading YAML front matter of a Markdown document — the one block Kuhn
 * interprets (render.js FRONT_MATTER_KEYS: template, page_limits, marp,
 * theme). The rich editor never sees it: the client strips it before the
 * document reaches Crepe and writes the BODY back, and the server re-attaches
 * whatever block the stored file currently carries (routes/files.js and
 * routes/review.js, `?body=1`). Doing the re-attach server-side means every
 * collaborative surface — member editor, reviewer edit link — preserves the
 * block without each keeping its own copy, and a front-matter edit made in
 * source mode is never overwritten by another tab's stale copy.
 *
 * Same regex as render.js: only a block that starts on line 1 counts.
 */

const FRONT_MATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/;

/**
 * @param {string|Buffer|null|undefined} text
 * @returns {{ frontMatter: string, body: string }} frontMatter is '' when absent
 */
export function splitFrontMatter(text) {
  const s = text == null ? '' : (Buffer.isBuffer(text) ? text.toString('utf-8') : String(text));
  const m = FRONT_MATTER_RE.exec(s);
  return m ? { frontMatter: m[1], body: s.slice(m[1].length) } : { frontMatter: '', body: s };
}

/**
 * The bytes to store for a body-only write: the stored file's leading front
 * matter (if any) followed by the new body. A body that itself starts with a
 * front-matter block is taken whole — the client did not strip, so nothing
 * is re-attached (keeps the operation idempotent).
 * @param {string|Buffer|null} existing - current stored content, null when the file is new
 * @param {string|Buffer} body
 * @returns {string}
 */
export function withStoredFrontMatter(existing, body) {
  const incoming = Buffer.isBuffer(body) ? body.toString('utf-8') : String(body ?? '');
  if (FRONT_MATTER_RE.test(incoming)) return incoming;
  const { frontMatter } = splitFrontMatter(existing);
  return frontMatter + incoming;
}
