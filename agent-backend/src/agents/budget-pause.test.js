import { describe, it, expect } from 'vitest';
import { BUDGET_EXCEEDED_ERROR, isBudgetPaused, renderResumeInput } from './budget-pause.js';

describe('budget pause vocabulary (issue #110)', () => {
  it('recognises a paused run by status + the exact error text', () => {
    expect(isBudgetPaused({ status: 'error', error: BUDGET_EXCEEDED_ERROR })).toBe(true);
    expect(isBudgetPaused({ status: 'error', error: 'during execution' })).toBe(false);
    expect(isBudgetPaused({ status: 'done', error: null })).toBe(false);
    expect(isBudgetPaused({ status: 'interrupted', error: BUDGET_EXCEEDED_ERROR })).toBe(false);
    expect(isBudgetPaused(undefined)).toBe(false);
  });

  it('renders the resume prompt around the hand-off note', () => {
    const input = renderResumeInput({ handoff: '  In progress: §2. Next: §3.  ' });
    expect(input).toMatch(/^\[Resuming after a token-budget pause\]/);
    expect(input).toContain('Hand-off note written at the pause:\n\nIn progress: §2. Next: §3.');
    expect(input).toMatch(/fresh budget/);
    expect(input).toMatch(/Re-read a file before editing it/);
  });

  it('says so when no note was captured', () => {
    for (const job of [{ handoff: null }, { handoff: '   ' }, {}]) {
      const input = renderResumeInput(job);
      expect(input).toContain('No hand-off note could be written at the pause');
      expect(input).not.toContain('Hand-off note written at the pause');
    }
  });
});
