import { describe, it, expect } from 'vitest';
import { renderSessionHandoff } from './session-handoff.js';

const caps = { maxChars: 10_000, maxCharsPerMessage: 200 };

const transcript = () => ({
  job: { id: 9, status: 'error', error: 'token budget exceeded' },
  messages: [
    { role: 'user', content: 'Draft the intro', tool_calls: null, tool_call_id: null, is_error: null },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', name: 'read_file', input: { path: 'draft/main.md' } }], tool_call_id: null, is_error: null },
    { role: 'tool', content: '# Intro\n\nold text', tool_calls: null, tool_call_id: 't1', is_error: 0 },
    { role: 'assistant', content: 'Reading the outline next.', tool_calls: [{ id: 't2', name: 'read_file', input: { path: 'notes/outline.md' } }], tool_call_id: null, is_error: null },
    { role: 'tool', content: 'Turn ended before this tool call was executed.', tool_calls: null, tool_call_id: 't2', is_error: 1 },
    { role: 'system', content: 'ignored', tool_calls: null, tool_call_id: null, is_error: null },
  ],
});

describe('renderSessionHandoff (issue #109)', () => {
  it('wraps the record in a hand-off block ahead of the user input, naming why the session stopped', () => {
    const out = renderSessionHandoff({ transcript: transcript(), input: 'continue please', ...caps });
    expect(out.startsWith('<session_handoff>')).toBe(true);
    expect(out.endsWith("The user's next message follows.\n\ncontinue please")).toBe(true);
    expect(out).toContain('It stopped with: token budget exceeded.');
    expect(out).toContain('[USER]\nDraft the intro');
    // Tool calls and their results are labelled by tool name, errors marked.
    expect(out).toContain('[AGENT → tool read_file] {"path":"draft/main.md"}');
    expect(out).toContain('[read_file result]\n# Intro\n\nold text');
    expect(out).toContain('[AGENT]\nReading the outline next.');
    expect(out).toContain('[read_file result (error)]\nTurn ended before this tool call was executed.');
    expect(out).not.toContain('ignored');
    expect(out).not.toContain('[earlier turns omitted]');
  });

  it('clips long rows and keeps the most recent turns under the total cap', () => {
    const t = transcript();
    t.messages[4].content = 'x'.repeat(5000);
    const out = renderSessionHandoff({ transcript: t, input: 'go', maxChars: 220, maxCharsPerMessage: 100 });
    expect(out).toContain('[…truncated]');
    expect(out).not.toContain('x'.repeat(101));
    expect(out).toContain('[earlier turns omitted]');
    // The tail survives; the head is what gets dropped.
    expect(out).toContain('[read_file result (error)]');
    expect(out).not.toContain('[USER]\nDraft the intro');
  });

  it('always keeps at least the last row even when it alone exceeds the cap', () => {
    const t = { job: null, messages: [{ role: 'user', content: 'y'.repeat(50) }] };
    const out = renderSessionHandoff({ transcript: t, input: 'go', maxChars: 10, maxCharsPerMessage: 1000 });
    expect(out).toContain('y'.repeat(50));
  });

  it('degrades to a bare note when Kuhn has no record either', () => {
    for (const transcript of [null, { messages: [], job: null }]) {
      const out = renderSessionHandoff({ transcript, input: 'go', ...caps });
      expect(out).toContain('Kuhn has no record of that session either');
      expect(out).not.toContain('[USER]');
      expect(out.endsWith('\n\ngo')).toBe(true);
    }
  });
});
