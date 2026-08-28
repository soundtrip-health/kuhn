import { describe, expect, it } from 'vitest';
import { refineParagraph, refineWords } from './word-diff';

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

describe('refineParagraph (STH-44)', () => {
  const oldText =
    'Mitochondria produce ATP. They have their own DNA. Their membranes are folded into cristae. This is the fourth sentence, kept as is.';

  it('strikes rewritten sentences whole and keeps untouched ones plain', () => {
    const newText =
      'Mitochondria produce ATP. They carry a small circular genome inherited from the mother. The inner membrane folds into cristae that house the respiratory chain. This is the fourth sentence, kept as is.';
    const r = refineParagraph(oldText, newText)!;
    // Two adjacent rewritten sentences merge into one struck span.
    expect(r.removed).toEqual([
      { start: oldText.indexOf('They have'), end: oldText.indexOf('cristae.') + 'cristae.'.length },
    ]);
    expect(r.segments.map((s) => [s.added, s.text])).toEqual([
      [false, 'Mitochondria produce ATP. '],
      [true, 'They carry a small circular genome inherited from the mother. The inner membrane folds into cristae that house the respiratory chain.'],
      [false, ' This is the fourth sentence, kept as is.'],
    ]);
    expect(r.segments.map((s) => s.text).join('')).toBe(newText);
  });

  it('refines a touched-up sentence at word level inside the sentence walk', () => {
    const newText =
      'Mitochondria produce ATP. They have their own genome. Their membranes are folded into cristae. This is the fourth sentence, kept as is.';
    const r = refineParagraph(oldText, newText)!;
    expect(r.removed).toEqual([
      { start: oldText.indexOf('DNA.'), end: oldText.indexOf('DNA.') + 'DNA.'.length },
    ]);
    expect(r.segments.filter((s) => s.added).map((s) => s.text)).toEqual(['genome.']);
    expect(r.segments.map((s) => s.text).join('')).toBe(newText);
  });

  it('handles a few words changed across several sentences without striking them whole', () => {
    const old2 = 'Alpha is first here. Beta comes second here. Gamma is third here.';
    const new2 = 'Alpha is first there. Beta comes second there. Gamma is third there.';
    const r = refineParagraph(old2, new2)!;
    expect(r.removed.map((sp) => old2.slice(sp.start, sp.end))).toEqual(['here.', 'here.', 'here.']);
    expect(r.segments.filter((s) => s.added).map((s) => s.text)).toEqual(['there.', 'there.', 'there.']);
  });

  it('treats re-wrapped whitespace as unchanged', () => {
    const r = refineParagraph('One two.  Three four.', 'One two. Three   four.')!;
    expect(r.removed).toEqual([]);
    expect(r.segments.every((s) => !s.added)).toBe(true);
  });

  it('returns null when nothing survives at either level (full rewrite)', () => {
    expect(refineParagraph('Alpha beta gamma. Delta epsilon zeta.', 'Eta theta iota. Kappa lambda mu.')).toBeNull();
    expect(refineParagraph('', 'x.')).toBeNull();
    expect(refineParagraph('x.', '   ')).toBeNull();
  });

  it('a single-sentence paragraph with a small change refines at word level', () => {
    const r = refineParagraph('The cell is the unit of life.', 'The cell is the basic unit of life.')!;
    expect(r.removed).toEqual([]);
    expect(r.segments.filter((s) => s.added).map((s) => s.text)).toEqual(['basic']);
  });
});
