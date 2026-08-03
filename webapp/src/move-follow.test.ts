// Story 012-004: the client-side move interleavings, tested directly. Until
// this file the 4002 branch and the SSE moved handler were covered only by
// emulation in a backend test (move-collab.test.js), which by construction
// cannot fail for client-side orderings — the autosave debounce firing between
// the rename and the event, the SSE feed racing the WS close, the mover's own
// tab receiving its own event mid-request.

import { describe, expect, it } from 'vitest';

import {
  movedDocAction,
  performRetarget,
  resolveMovedRoom,
  type MovedRoomHost,
  type RetargetHost,
} from './move-follow';

// ---- resolveMovedRoom (the 4002 close-reason leg) ---------------------------

/** A host that records every call in order, with overridable behaviour. */
function movedRoomHost(overrides: Partial<MovedRoomHost> = {}) {
  const calls: string[] = [];
  const host: MovedRoomHost = {
    projectId: () => 7,
    currentPath: () => 'draft/main.md',
    readTextFile: async (_p, path) => {
      calls.push(`read:${path}`);
      return '# body';
    },
    cancelPendingSave: () => calls.push('cancel'),
    strand: () => calls.push('strand'),
    retarget: (path) => {
      calls.push(`retarget:${path}`);
    },
    ...overrides,
  };
  return { host, calls };
}

describe('resolveMovedRoom', () => {
  it('retargets to a readable close-reason path', async () => {
    const { host, calls } = movedRoomHost();
    await resolveMovedRoom(host, 'archive/main.md');
    expect(calls).toEqual(['cancel', 'read:archive/main.md', 'retarget:archive/main.md']);
  });

  it('cancels the save debounce before its first await — a debounce firing between the rename and the 4002 must not land on the dead path', async () => {
    // The read never resolves; the cancel must already have happened.
    const { host, calls } = movedRoomHost({
      readTextFile: () => new Promise(() => {}),
    });
    void resolveMovedRoom(host, 'archive/main.md');
    expect(calls).toEqual(['cancel']);
  });

  it('an empty reason (server had to blank an over-long path) parks the tab', async () => {
    const { host, calls } = movedRoomHost();
    await resolveMovedRoom(host, '   ');
    expect(calls).toEqual(['cancel', 'strand']);
  });

  it('a reason equal to the current path is stale, not a move — parks the tab', async () => {
    const { host, calls } = movedRoomHost();
    await resolveMovedRoom(host, 'draft/main.md');
    expect(calls).toEqual(['cancel', 'strand']);
  });

  it('a target that cannot be read back parks the tab instead of conjuring it on the next save', async () => {
    const missing = movedRoomHost({ readTextFile: async () => null });
    await resolveMovedRoom(missing.host, 'archive/main.md');
    expect(missing.calls).toContain('strand');

    const failing = movedRoomHost({
      readTextFile: async () => {
        throw new Error('offline');
      },
    });
    await resolveMovedRoom(failing.host, 'archive/main.md');
    expect(failing.calls).toContain('strand');
  });

  it('yields when the SSE feed retargets the document while the read is in flight', async () => {
    // The feed and the 4002 leg race by design (the same move arrives on
    // both); whichever loses must become a no-op, not a second retarget.
    let path = 'draft/main.md';
    const { host, calls } = movedRoomHost({
      currentPath: () => path,
      readTextFile: async () => {
        path = 'archive/main.md'; // the feed's retarget lands mid-read
        return '# body';
      },
    });
    await resolveMovedRoom(host, 'archive/main.md');
    expect(calls.filter((c) => c.startsWith('retarget'))).toEqual([]);
    expect(calls).not.toContain('strand');
  });

  it('yields when the whole project switched while the read was in flight', async () => {
    let project = 7;
    const { host, calls } = movedRoomHost({
      projectId: () => project,
      readTextFile: async () => {
        project = 8;
        return '# body';
      },
    });
    await resolveMovedRoom(host, 'archive/main.md');
    expect(calls.filter((c) => c.startsWith('retarget'))).toEqual([]);
    expect(calls).not.toContain('strand');
  });
});

// ---- performRetarget (the follow itself) ------------------------------------

/** Simulates the editor: saves land wherever `path` points WHEN they run. */
function retargetHost(opts: { dirty: string | null }) {
  const calls: string[] = [];
  let path = 'draft/main.md';
  const savedTo: string[] = [];
  const host: RetargetHost = {
    setCurrentPath: (p) => {
      path = p;
      calls.push(`setPath:${p}`);
    },
    announce: (p) => calls.push(`announce:${p}`),
    pendingMarkdown: () => {
      calls.push('readPending');
      return opts.dirty;
    },
    cancelPendingSave: () => calls.push('cancel'),
    clearMovedAway: () => calls.push('clearMoved'),
    flushSave: async () => {
      savedTo.push(path); // like the real flushSave: writes to the CURRENT path
      calls.push(`flush:${path}`);
    },
    reopen: async (p, restore) => {
      calls.push(`reopen:${p}:${restore ?? '∅'}`);
    },
  };
  return { host, calls, savedTo, currentPath: () => path };
}

describe('performRetarget', () => {
  it('clean: no flush, reopen with no restore payload', async () => {
    const { host, calls } = retargetHost({ dirty: null });
    await performRetarget(host, 'archive/main.md');
    expect(calls).toEqual([
      'setPath:archive/main.md',
      'announce:archive/main.md',
      'readPending',
      'cancel',
      'clearMoved',
      'reopen:archive/main.md:∅',
    ]);
  });

  it('dirty: flushes, then reopens with the buffer as the restore payload', async () => {
    const { host, calls } = retargetHost({ dirty: '# edited but unsaved' });
    await performRetarget(host, 'archive/main.md');
    expect(calls).toContain('flush:archive/main.md');
    expect(calls.at(-1)).toBe('reopen:archive/main.md:# edited but unsaved');
  });

  it('rule 1 — the path moves before anything else, so a racing save lands on the NEW path, never resurrecting the old one', async () => {
    // This is the rename-vs-agent-write / autosave race deferred from story
    // 012-001: any save that runs after the retarget begins must write to the
    // destination. The host's flushSave writes to wherever the path points at
    // flush time — if setCurrentPath were not first, this would be the dead path.
    const { host, calls, savedTo } = retargetHost({ dirty: '# racing buffer' });
    await performRetarget(host, 'archive/main.md');
    expect(calls[0]).toBe('setPath:archive/main.md');
    expect(savedTo).toEqual(['archive/main.md']);
    expect(savedTo).not.toContain('draft/main.md');
  });

  it('leaves the parked "moved away" state before reopening', async () => {
    const { host, calls } = retargetHost({ dirty: null });
    await performRetarget(host, 'archive/main.md');
    expect(calls.indexOf('clearMoved')).toBeLessThan(calls.indexOf('reopen:archive/main.md:∅'));
  });
});

// ---- movedDocAction (the SSE moved-event leg) -------------------------------

describe('movedDocAction', () => {
  it('does nothing with no open document', () => {
    expect(movedDocAction(null, { path: 'b.md', from: 'a.md' })).toEqual({ kind: 'none' });
    expect(movedDocAction('', { path: 'b.md', from: 'a.md' })).toEqual({ kind: 'none' });
  });

  it('a missing meta.from falls back to tree inspection, never a guessed target', () => {
    expect(movedDocAction('draft/main.md', { path: 'archive/main.md' })).toEqual({ kind: 'follow-blind' });
    expect(movedDocAction('draft/main.md', { path: 'archive/main.md', from: '' })).toEqual({ kind: 'follow-blind' });
  });

  it('retargets the open document when it IS the moved file', () => {
    expect(
      movedDocAction('draft/main.md', { path: 'archive/main.md', from: 'draft/main.md' }),
    ).toEqual({ kind: 'retarget', to: 'archive/main.md' });
  });

  it('a folder move retargets a descendant to its OWN new path, not the folder\'s', () => {
    expect(
      movedDocAction('draft/ch1/intro.md', { path: 'archive/draft', from: 'draft' }),
    ).toEqual({ kind: 'retarget', to: 'archive/draft/ch1/intro.md' });
  });

  it('ignores moves of unrelated files — including lookalike prefixes', () => {
    expect(
      movedDocAction('draft/main.md', { path: 'archive/notes.md', from: 'notes.md' }),
    ).toEqual({ kind: 'none' });
    // 'draftier' starts with 'draft' but is not under it.
    expect(
      movedDocAction('draftier/main.md', { path: 'archive/draft', from: 'draft' }),
    ).toEqual({ kind: 'none' });
  });

  it('the mover\'s own tab sees its own event as a plain retarget to where it already is heading', () => {
    // The server fans the event out before the move response returns, so the
    // initiating tab receives it mid-request; the action is the same retarget
    // the response handler would perform, and the re-entrancy guards in the
    // hosts make the double arrival a no-op.
    expect(
      movedDocAction('draft/main.md', { path: 'archive/main.md', from: 'draft/main.md' }),
    ).toEqual({ kind: 'retarget', to: 'archive/main.md' });
  });
});
