import { describe, expect, it } from 'vitest';
import { refineWords } from './word-diff';

describe('refineWords', () => {
  it('isolates a small in-place word change', () => {
    const oldText = 'The mitochondria is the powerhouse of the cell.';
    const newText = 'The mitochondria is the engine of the cell.';
    const r = refineWords(oldText, newText)!;
    expect(r.removed).toEqual([
      { start: oldText.indexOf('powerhouse'), end: oldText.indexOf('powerhouse') + 'powerhouse'.length },
    ]);
    expect(r.segments.filter((s) => s.added).map((s) => s.text)).toEqual(['engine']);
    expect(r.similarity).toBeGreaterThan(0.8);
  });

  it('merges adjacent removed words into one span', () => {
    const oldText = 'alpha bravo charlie delta echo';
    const r = refineWords(oldText, 'alpha xray yankee echo')!;
    expect(r.removed).toEqual([
      { start: oldText.indexOf('bravo'), end: oldText.indexOf('delta') + 'delta'.length },
    ]);
  });

  it('keeps separate spans for non-adjacent changes', () => {
    const oldText = 'one two three four five';
    const r = refineWords(oldText, 'ONE two three FOUR five')!;
    expect(r.removed).toHaveLength(2);
  });

  it('reports identical text as fully similar with nothing removed', () => {
    const r = refineWords('same words here', 'same words here')!;
    expect(r.removed).toEqual([]);
    expect(r.segments).toEqual([{ text: 'same words here', added: false }]);
    expect(r.similarity).toBe(1);
  });

  it('reports a full rewrite as low similarity', () => {
    const r = refineWords('completely original sentence', 'utterly different phrasing instead')!;
    expect(r.similarity).toBe(0);
  });

  it('preserves inter-word spacing inside new-side runs', () => {
    const r = refineWords('a b c', 'a b  x')!;
    const addedRun = r.segments.find((s) => s.added)!;
    expect(addedRun.text).toBe('x');
    expect(r.segments.map((s) => s.text).join('')).toBe('a b  x');
  });

  it('returns null for empty or oversized input', () => {
    expect(refineWords('', 'something')).toBeNull();
    expect(refineWords('something', '')).toBeNull();
    const huge = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    expect(refineWords(huge, huge)).toBeNull();
  });

  it('appends trailing glue to the previous segment at a run boundary', () => {
    const r = refineWords('keep old end', 'keep new end')!;
    // Rejoining all segments must reproduce the full new text.
    expect(r.segments.map((s) => s.text).join('')).toBe('keep new end');
  });
});
