// Leading YAML front matter (STH-61). Milkdown has no front-matter node —
// the round trip rewrote the `---` fences into a thematic break and a setext
// underline — so the rich editor only ever sees the BODY: every collaborative
// surface strips the block before content reaches Crepe (and before it seeds
// a room), writes the body back with `body=1`, and the server re-attaches the
// block the stored file carries (agent-backend/src/front-matter.js). Source
// mode edits the full bytes, so front matter itself is edited there.
//
// Same regex as the backend: only a block that starts on line 1 counts.

export const FRONT_MATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/;

export function splitFrontMatter(text: string): { frontMatter: string; body: string } {
  const m = FRONT_MATTER_RE.exec(text);
  return m ? { frontMatter: m[1], body: text.slice(m[1].length) } : { frontMatter: '', body: text };
}

/** The body without its leading front matter; null passes through (file absent). */
export function stripFrontMatter(content: string | null): string | null {
  return content == null ? content : splitFrontMatter(content).body;
}
