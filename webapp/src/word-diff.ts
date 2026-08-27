// Word-level diff refinement for suggestion review (STH-41). The pending-edit
// hunks are line-based, and a markdown paragraph is one line — so a few
// changed words used to render as "whole paragraph struck + whole paragraph
// green", leaving the reader to eyeball what actually changed. This module
// compares the old and new text of one paragraph pair and reports word-level
// changes; suggestion-hunks.ts uses it to strike only the changed words and
// to elide unchanged runs in the insertion preview. Pure and deterministic —
// no dependencies (the webapp deliberately carries no diff library).

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

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
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

  // LCS length table (m+1 × n+1), then backtrack into per-side kept flags.
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

/** True when old-token k is adjacent (whitespace apart) to the span's end. */
function spanTouches(tokens: Token[], k: number, span: Span): boolean {
  return k > 0 && tokens[k - 1].end === span.end;
}
