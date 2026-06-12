import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import { listProjectConversations } from './conversation.js';

beforeEach(() => {
  query.mockReset();
});

describe('listProjectConversations (story 020)', () => {
  it('returns conversations with their messages grouped chronologically', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 11, agent_slug: 'pm', created_at: '2026-06-12T10:00:00Z' },
          { id: 10, agent_slug: 'ra', created_at: '2026-06-12T09:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { conversation_id: 10, role: 'user', content: 'find papers', created_at: '2026-06-12T09:00:01Z' },
          { conversation_id: 11, role: 'user', content: 'hello', created_at: '2026-06-12T10:00:01Z' },
          { conversation_id: 11, role: 'assistant', content: 'Hi!', created_at: '2026-06-12T10:00:02Z' },
        ],
      });

    const conversations = await listProjectConversations(3, { limit: 5 });

    expect(conversations).toEqual([
      {
        id: 11,
        agent_slug: 'pm',
        created_at: '2026-06-12T10:00:00Z',
        messages: [
          { role: 'user', content: 'hello', created_at: '2026-06-12T10:00:01Z' },
          { role: 'assistant', content: 'Hi!', created_at: '2026-06-12T10:00:02Z' },
        ],
      },
      {
        id: 10,
        agent_slug: 'ra',
        created_at: '2026-06-12T09:00:00Z',
        messages: [
          { role: 'user', content: 'find papers', created_at: '2026-06-12T09:00:01Z' },
        ],
      },
    ]);

    // Top-level conversations only — no sub-agent dispatches, no seeding-stage
    // instruction prompts (story 015) — and project-scoped
    const [conversationSql, conversationParams] = query.mock.calls[0];
    expect(conversationSql).toContain('parent_job_id IS NULL');
    expect(conversationSql).toContain("'seedStage'");
    expect(conversationParams).toEqual([3, 5]);

    // Only user/assistant messages, for the requested conversations
    const [messageSql, messageParams] = query.mock.calls[1];
    expect(messageSql).toContain("role IN ('user', 'assistant')");
    expect(messageParams).toEqual([[11, 10]]);
  });

  it('skips the message query when there are no conversations', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const conversations = await listProjectConversations(3);
    expect(conversations).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
