// Word- and sentence-level diff refinement for suggestion review (STH-41,
// STH-44). The pending-edit hunks are line-based, and a markdown paragraph is
// one line — so a few changed words used to render as "whole paragraph struck
// + whole paragraph green", leaving the reader to eyeball what actually
// changed. This module compares the old and new text of one paragraph pair
// and reports changes at word granularity (a few words here and there) or,
// when a paragraph was substantially rewritten, at sentence granularity —
// untouched sentences stay plain and only rewritten ones are struck/added.
// suggestion-hunks.ts picks the level and renders it. Pure and deterministic
// — no dependencies (the webapp deliberately carries no diff library).

export interface Span {
  /** Char offsets into the OLD text: [start, end). */
  start: number;
  end: number;
}

export interface Segment {
  text: string;
  added: boolean;
}

export interface WordRefinement {
  /** Old-text char spans covering changed/removed words (adjacent merged). */
  removed: Span[];
  /** The new text as alternating kept/added word runs, in order. */
  segments: Segment[];
  /** Kept words / max(old words, new words) — 1 means identical. */
  similarity: number;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

/** Beyond this many words per side the DP table isn't worth building — a
 *  paragraph that long that ALSO changed is better reviewed as a block. */
const MAX_WORDS = 400;
/** Sentences are far fewer than words; the same cap is plenty. */
const MAX_SENTENCES = 400;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/**
 * Split into sentences: a run of text up to a terminator (. ! ?) plus any
 * closing quotes/brackets, or to the end. Offsets cover the trimmed sentence;
 * `text` is whitespace-normalized so a re-wrapped sentence still matches.
 * Abbreviations ("e.g.", "Fig. 2") over-split — harmless: both sides split the
 * same way, so an unchanged abbreviation stays a kept run either way.
 */
function tokenizeSentences(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) break;
    const lead = m[0].match(/^\s*/)![0].length;
    const trimmed = m[0].trim();
    if (!trimmed) continue;
    const start = m.index + lead;
    tokens.push({ text: trimmed.replace(/\s+/g, ' '), start, end: start + trimmed.length });
  }
  return tokens;
}

/**
 * Word-level LCS refinement of one old/new text pair. Returns null when either
 * side is empty or too long to diff — callers fall back to block rendering.
 */
export function refineWords(oldText: string, newText: string): WordRefinement | null {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length === 0 || b.length === 0) return null;
  if (a.length > MAX_WORDS || b.length > MAX_WORDS) return null;
  return refineTokens(a, b, newText);
}

/** Below this share of kept words a sentence pair reads as a rewrite rather
 *  than a touch-up; strike the whole sentence instead of confetti. */
export const WORD_MIN_SIMILARITY = 0.4;

/**
 * Hierarchical refinement of one paragraph pair (STH-44): sentences first,
 * then words. Sentences kept verbatim (modulo whitespace) stay plain. Where
 * a run of changed sentences pairs up one-to-one and a pair still shares
 * most of its words, only the changed words are struck/added (a few words
 * here and there); a sentence that was genuinely rewritten is struck whole
 * and its replacement shown whole. Null when either side is empty, too long,
 * or NOTHING survives at either level — a full rewrite is shown most
 * honestly as whole-block strike + full green preview.
 *
 * `similarity` is the share of old-side characters that stay plain.
 */
export function refineParagraph(oldText: string, newText: string): WordRefinement | null {
  const a = tokenizeSentences(oldText);
  const b = tokenizeSentences(newText);
  if (a.length === 0 || b.length === 0) return null;
  if (a.length > MAX_SENTENCES || b.length > MAX_SENTENCES) return null;
  const { keptOld, keptNew } = lcsFlags(a, b);

  const removed: Span[] = [];
  const segments: Segment[] = [];
  let lastNewEnd = 0;
  let plainChars = 0;
  const push = (text: string, added: boolean, glue: string): void => {
    const prev = segments[segments.length - 1];
    if (prev && prev.added === added) prev.text += glue + text;
    else if (!added) segments.push({ text: (prev ? glue : '') + text, added });
    else {
      if (prev) prev.text += glue;
      segments.push({ text, added });
    }
  };
  const emitNew = (tok: Token, parts: Segment[] | null): void => {
    const glue = newText.slice(lastNewEnd, tok.start);
    if (parts) parts.forEach((seg, idx) => push(seg.text, seg.added, idx === 0 ? glue : ''));
    else push(newText.slice(tok.start, tok.end), true, glue);
    lastNewEnd = tok.end;
  };
  const strike = (start: number, end: number): void => {
    const last = removed[removed.length - 1];
    if (last && /^\s*$/.test(oldText.slice(last.end, start))) last.end = end;
    else removed.push({ start, end });
  };

  let i = 0;
  let j = 0;
  const m = a.length;
  const n = b.length;
  while (i < m || j < n) {
    if (i < m && j < n && keptOld[i] && keptNew[j]) {
      plainChars += a[i].end - a[i].start;
      emitNew(b[j], [{ text: newText.slice(b[j].start, b[j].end), added: false }]);
      i++;
      j++;
      continue;
    }
    const oldRun: Token[] = [];
    while (i < m && !keptOld[i]) oldRun.push(a[i++]);
    const newRun: Token[] = [];
    while (j < n && !keptNew[j]) newRun.push(b[j++]);

    if (oldRun.length === newRun.length) {
      // One-to-one: refine each pair at word level when it mostly survives.
      oldRun.forEach((oldTok, k) => {
        const newTok = newRun[k];
        const words = refineWords(oldText.slice(oldTok.start, oldTok.end), newText.slice(newTok.start, newTok.end));
        if (words && words.similarity >= WORD_MIN_SIMILARITY) {
          for (const span of words.removed) {
            removed.push({ start: oldTok.start + span.start, end: oldTok.start + span.end });
          }
          plainChars += (oldTok.end - oldTok.start) - words.removed.reduce((sum, sp) => sum + (sp.end - sp.start), 0);
          emitNew(newTok, words.segments);
        } else {
          strike(oldTok.start, oldTok.end);
          emitNew(newTok, null);
        }
      });
    } else {
      if (oldRun.length > 0) strike(oldRun[0].start, oldRun[oldRun.length - 1].end);
      for (const tok of newRun) emitNew(tok, null);
    }
  }

  const similarity = plainChars / Math.max(1, oldText.trim().length);
  if (plainChars === 0) return null;
  return { removed, segments, similarity };
}

/** Shared LCS core: tokens compare by `text`; the new side's segments keep
 *  the real inter-token glue from `newText` so a rejoin reads naturally. */
function refineTokens(a: Token[], b: Token[], newText: string): WordRefinement {
  const { keptOld, keptNew, kept } = lcsFlags(a, b);
  const m = a.length;
  const n = b.length;

  // Removed word runs → merged char spans (the gap between two adjacent
  // removed words is part of the change, so it merges into one span).
  const removed: Span[] = [];
  for (let k = 0; k < m; k++) {
    if (keptOld[k]) continue;
    const last = removed[removed.length - 1];
    if (last && removed.length > 0 && spanTouches(a, k, last)) last.end = a[k].end;
    else removed.push({ start: a[k].start, end: a[k].end });
  }

  // New side → alternating kept/added runs, preserving inter-word spacing.
  // Boundary whitespace always joins the KEPT side so added runs stay clean.
  const segments: Segment[] = [];
  for (let k = 0; k < n; k++) {
    const added = !keptNew[k];
    const prev = segments[segments.length - 1];
    const glue = k > 0 ? newText.slice(b[k - 1].end, b[k].start) : '';
    if (prev && prev.added === added) prev.text += glue + b[k].text;
    else if (!added) segments.push({ text: (prev ? glue : '') + b[k].text, added });
    else {
      if (prev) prev.text += glue;
      segments.push({ text: b[k].text, added });
    }
  }

  return { removed, segments, similarity: kept / Math.max(m, n) };
}

/** LCS over token text: which tokens on each side are kept, and how many. */
function lcsFlags(a: Token[], b: Token[]): { keptOld: boolean[]; keptNew: boolean[]; kept: number } {
  const m = a.length;
  const n = b.length;
  const width = n + 1;
  const dp = new Uint16Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i].text === b[j].text
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const keptOld = new Array<boolean>(m).fill(false);
  const keptNew = new Array<boolean>(n).fill(false);
  let i = 0;
  let j = 0;
  let kept = 0;
  while (i < m && j < n) {
    if (a[i].text === b[j].text) {
      keptOld[i] = true;
      keptNew[j] = true;
      kept++;
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { keptOld, keptNew, kept };
}

/** True when old-token k is adjacent (whitespace apart) to the span's end. */
function spanTouches(tokens: Token[], k: number, span: Span): boolean {
  return k > 0 && tokens[k - 1].end === span.end;
}
