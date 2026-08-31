import { describe, it, expect, vi } from 'vitest';

// The tail query is SQL substance covered in db/conversation.test.js; here
// the model call and the NONE/clipping contract are the substance.
vi.mock('../db/conversation.js', () => ({ getRecentAgentMessages: vi.fn(async () => []) }));

import { config } from '../config.js';
import { getRecentAgentMessages } from '../db/conversation.js';
import { captureHandoff } from './handoff.js';

const fakeClient = (text) => ({
  messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text }] })) },
});

describe('captureHandoff (STH-55)', () => {
  it('returns null without touching the model when there is no history', async () => {
    getRecentAgentMessages.mockResolvedValueOnce([]);
    const anthropic = fakeClient('never called');
    expect(await captureHandoff(7, 'pm', { anthropic })).toEqual({ handoff: null });
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('sends the labeled transcript tail and returns the note', async () => {
    getRecentAgentMessages.mockResolvedValueOnce([
      { role: 'user', content: 'fix the references', created_at: 't1' },
      { role: 'assistant', content: 'Want me to resume the reference-fixing now?', created_at: 't2' },
    ]);
    const anthropic = fakeClient('Resume the reference-fixing work.');
    const out = await captureHandoff(7, 'pm', { anthropic });
    expect(out).toEqual({ handoff: 'Resume the reference-fixing work.' });

    const req = anthropic.messages.create.mock.calls[0][0];
    expect(req.model).toBe(config.handoff.model);
    expect(req.system).toMatch(/hand-off/i);
    const prompt = req.messages[0].content;
    expect(prompt).toContain('[USER]\nfix the references');
    expect(prompt).toContain('[AGENT]\nWant me to resume the reference-fixing now?');
    expect(prompt.indexOf('[USER]')).toBeLessThan(prompt.indexOf('[AGENT]')); // oldest first
  });

  it('maps a NONE reply (and blank replies) to null', async () => {
    getRecentAgentMessages.mockResolvedValue([
      { role: 'assistant', content: 'All done, nothing pending.', created_at: 't' },
    ]);
    expect(await captureHandoff(7, 'pm', { anthropic: fakeClient('NONE') })).toEqual({ handoff: null });
    expect(await captureHandoff(7, 'pm', { anthropic: fakeClient('  \n') })).toEqual({ handoff: null });
  });

  it('clips oversized messages before sending', async () => {
    getRecentAgentMessages.mockResolvedValueOnce([
      { role: 'assistant', content: 'x'.repeat(config.handoff.maxCharsPerMessage + 500), created_at: 't' },
    ]);
    const anthropic = fakeClient('NONE');
    await captureHandoff(7, 'pm', { anthropic });
    const prompt = anthropic.messages.create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('[…truncated]');
    expect(prompt.length).toBeLessThan(config.handoff.maxCharsPerMessage + 1000);
  });
});
