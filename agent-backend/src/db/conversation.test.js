import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import { createConversation, logMessage, listProjectConversations } from './conversation.js';

beforeEach(() => {
  query.mockReset();
});

describe('user attribution (story 007-001)', () => {
  beforeEach(() => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
  });

  it('createConversation stamps the starting user (NULL when absent)', async () => {
    await createConversation('pm', 3, 4);
    expect(query.mock.calls[0][1]).toEqual(['pm', 3, 4]);
    await createConversation('pm', 3);
    expect(query.mock.calls[1][1]).toEqual(['pm', 3, null]);
  });

  it('logMessage stamps the user on any role\'s row', async () => {
    await logMessage({ conversationId: 1, role: 'assistant', content: 'hi', userId: 4 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('user_id');
    expect(params.at(-2)).toBe(4);
  });
});

describe('tool-result error flag (issue #42)', () => {
  beforeEach(() => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
  });

  it('logMessage records is_error as 1/0 and NULL when not given', async () => {
    await logMessage({ conversationId: 1, role: 'tool', content: 'boom', toolCallId: 't1', isError: true });
    expect(query.mock.calls[0][1].at(-1)).toBe(1);
    await logMessage({ conversationId: 1, role: 'tool', content: 'ok', toolCallId: 't2', isError: false });
    expect(query.mock.calls[1][1].at(-1)).toBe(0);
    await logMessage({ conversationId: 1, role: 'assistant', content: 'hi' });
    expect(query.mock.calls[2][1].at(-1)).toBeNull();
  });
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
    expect(conversationSql).toContain('seedStage');
    expect(conversationSql).toContain('c.user_id'); // attribution for turn labels (007-001)
    expect(conversationParams).toEqual([3, 5]);

    // Only user/assistant messages, for the requested conversations (the
    // conversation ids are spread as positional params into an IN (...) list)
    const [messageSql, messageParams] = query.mock.calls[1];
    expect(messageSql).toContain("role IN ('user', 'assistant')");
    expect(messageSql).toContain('user_id');
    expect(messageParams).toEqual([11, 10]);
  });

  it('skips the message query when there are no conversations', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const conversations = await listProjectConversations(3);
    expect(conversations).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
