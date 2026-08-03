// Story 012-005: the folder rollup and the topbar unseen pill must agree —
// including for a pending proposal naming a file that does not exist on disk
// yet (`pending_edits.base_missing`), which has no tree node for the rollup
// walk to visit. Those paths reach rollup() as `phantoms`.

import { describe, expect, it } from 'vitest';

import type { TreeNode } from './api';
import { rollup, type RollupProbe } from './tree-state';

const file = (path: string): TreeNode => ({
  name: path.split('/').pop()!,
  path,
  type: 'file',
});
const dir = (path: string, children: TreeNode[]): TreeNode => ({
  name: path.split('/').pop()!,
  path,
  type: 'dir',
  children,
});

/** The same predicate shape files.ts wires in: flagged = status ∪ suggestions. */
const probe = (flagged: string[], comments: Record<string, number> = {}): RollupProbe => ({
  flagged: (path) => flagged.includes(path),
  comments: (path) => comments[path] ?? 0,
});

const draft = dir('draft', [
  file('draft/main.md'),
  file('draft/notes.md'),
  dir('draft/sub', [file('draft/sub/deep.md')]),
]);

describe('rollup', () => {
  it('sums files, flagged descendants and comments over the subtree', () => {
    const out = rollup(draft, probe(['draft/notes.md', 'draft/sub/deep.md'], { 'draft/main.md': 2 }));
    expect(out).toEqual({ files: 3, unseen: 2, comments: 2, phantoms: 0 });
  });

  it('counts a phantom proposal beneath the folder into unseen, but never into files', () => {
    // The story's concrete case: an agent proposes a NEW draft/methods.md.
    // The pill counts it; before 012-005 a collapsed draft/ showed one lower.
    const out = rollup(draft, probe([]), ['draft/methods.md']);
    expect(out.unseen).toBe(1);
    expect(out.phantoms).toBe(1);
    expect(out.files).toBe(3); // a proposal is not an item on disk
  });

  it('rolls a phantom into every ancestor folder, not just the immediate parent', () => {
    const phantoms = ['draft/sub/appendix.md'];
    expect(rollup(draft, probe([]), phantoms).unseen).toBe(1);
    const sub = (draft.children ?? [])[2];
    expect(rollup(sub, probe([]), phantoms).unseen).toBe(1);
  });

  it('ignores phantoms outside the subtree — including lookalike prefixes', () => {
    const out = rollup(draft, probe([]), ['sources/new.md', 'draftier/new.md']);
    expect(out.unseen).toBe(0);
    expect(out.phantoms).toBe(0);
  });

  it('agrees with the pill: flagged nodes plus phantom proposals is one number', () => {
    // The pill counts the union of flagged paths and every suggestion key
    // (files.ts updateUnseenPill). With every suggestion under one folder,
    // that folder's rollup must equal the pill — this is 012-005 AC 1.
    const suggestions = ['draft/notes.md', 'draft/methods.md']; // one real, one phantom
    const flagged = ['draft/notes.md']; // suggestMap keys are flagged too
    const pill = new Set([...flagged, ...suggestions]).size;
    const phantoms = suggestions.filter(
      (p) => !['draft/main.md', 'draft/notes.md', 'draft/sub/deep.md'].includes(p),
    );
    expect(rollup(draft, probe(flagged), phantoms).unseen).toBe(pill);
  });
});
