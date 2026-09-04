import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import { createConversation, logMessage, listProjectConversations, getRecentAgentMessages, getSessionTranscript } from './conversation.js';

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

describe('getRecentAgentMessages (STH-55)', () => {
  it('queries one agent\'s top-level tail and maps rows', async () => {
    query.mockResolvedValueOnce({ rows: [
      { role: 'user', content: 'fix refs', created_at: 't1' },
      { role: 'assistant', content: 'Want me to resume?', created_at: 't2' },
    ] });
    const out = await getRecentAgentMessages(7, 'pm', { limit: 5 });
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([7, 'pm', 5]);
    expect(sql).toContain('agent_slug');
    expect(sql).toContain('parent_job_id IS NULL'); // sub-agent dispatches excluded
    expect(sql).toContain('seedStage'); // seeding-stage conversations excluded
    expect(out).toEqual([
      { role: 'user', content: 'fix refs', created_at: 't1' },
      { role: 'assistant', content: 'Want me to resume?', created_at: 't2' },
    ]);
  });
});

describe('getSessionTranscript (issue #109)', () => {
  it('returns the messages of every top-level job on the session, oldest first, with the latest job', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 9, status: 'error', error: 'token budget exceeded', created_at: 't' }] })
      .mockResolvedValueOnce({ rows: [
        { role: 'user', content: 'go', tool_calls: null, tool_call_id: null, is_error: null },
        { role: 'assistant', content: 'ok', tool_calls: '[{"id":"t1","name":"read_file","input":{"path":"a.md"}}]', tool_call_id: null, is_error: null },
        { role: 'tool', content: 'body', tool_calls: null, tool_call_id: 't1', is_error: 0 },
      ] });

    const result = await getSessionTranscript('sess-dead', { limit: 50 });

    const [jobSql, jobParams] = query.mock.calls[0];
    expect(jobSql).toMatch(/FROM jobs/);
    expect(jobSql).toMatch(/session_id = \$1/);
    expect(jobSql).toMatch(/parent_job_id IS NULL/);
    expect(jobParams).toEqual(['sess-dead']);
    const [msgSql, msgParams] = query.mock.calls[1];
    expect(msgSql).toMatch(/FROM messages m/);
    expect(msgSql).toMatch(/j\.session_id = \$1/);
    expect(msgSql).toMatch(/ORDER BY m\.id DESC\s+LIMIT \$2/);
    expect(msgSql).toMatch(/ORDER BY id ASC/);
    expect(msgParams).toEqual(['sess-dead', 50]);

    expect(result.job).toMatchObject({ id: 9, error: 'token budget exceeded' });
    expect(result.messages).toHaveLength(3);
    // tool_calls JSON is parsed like every other message read
    expect(result.messages[1].tool_calls).toEqual([{ id: 't1', name: 'read_file', input: { path: 'a.md' } }]);
  });

  it('reports no job and no messages for an unknown session', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getSessionTranscript('nope')).toEqual({ messages: [], job: null });
  });
});
