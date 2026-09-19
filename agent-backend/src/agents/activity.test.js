import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/chats.js', () => ({ listChatActivity: vi.fn(async () => []) }));
vi.mock('../project-events.js', () => ({ publishOrgEvent: vi.fn() }));

import { listChatActivity } from '../db/chats.js';
import { publishOrgEvent } from '../project-events.js';
import { deliverReply, waitForReply } from './questions.js';
import { chatActivitySnapshot, publishChatActivity, visibleActivity } from './activity.js';

beforeEach(() => {
  listChatActivity.mockReset();
  listChatActivity.mockResolvedValue([]);
  publishOrgEvent.mockClear();
});

describe('publishChatActivity', () => {
  it('publishes a typed chat record on the org hub, question null unless given', () => {
    publishChatActivity(3, { chatId: 9, projectId: 5, userId: 1, agent: 'pm', status: 'running', jobId: 42 });
    expect(publishOrgEvent).toHaveBeenCalledWith(3, { type: 'chat', chatId: 9, projectId: 5, userId: 1, agent: 'pm', status: 'running', jobId: 42, question: null });
    publishChatActivity(null, { chatId: 9 });
    publishChatActivity(3, { chatId: null });
    expect(publishOrgEvent).toHaveBeenCalledTimes(1);
  });
});

describe('chatActivitySnapshot', () => {
  it('folds the pending question text into the user\'s own parked chats only', async () => {
    listChatActivity.mockResolvedValue([
      { chatId: 1, projectId: 5, userId: 1, agent: 'pm', status: 'waiting_for_user', jobId: 30, waitingJobId: 31 },
      { chatId: 2, projectId: 5, userId: 2, agent: 'pm', status: 'waiting_for_user', jobId: 40, waitingJobId: null },
      { chatId: 3, projectId: 6, userId: 1, agent: 'writer', status: 'running', jobId: 50, waitingJobId: null },
    ]);
    waitForReply(31, 10000, { question: 'Which journal?', agent: 'ra' });
    waitForReply(40, 10000, { question: 'Theirs', agent: 'pm' });
    try {
      const snap = await chatActivitySnapshot(3, { userId: 1, everyone: true });
      expect(listChatActivity).toHaveBeenCalledWith(3, { userId: 1, everyone: true });
      expect(snap).toEqual([
        { type: 'chat', chatId: 1, projectId: 5, userId: 1, agent: 'pm', status: 'waiting_for_user', jobId: 30, question: 'Which journal?' },
        { type: 'chat', chatId: 2, projectId: 5, userId: 2, agent: 'pm', status: 'waiting_for_user', jobId: 40, question: null },
        { type: 'chat', chatId: 3, projectId: 6, userId: 1, agent: 'writer', status: 'running', jobId: 50, question: null },
      ]);
    } finally {
      deliverReply(31, 'x');
      deliverReply(40, 'x');
    }
  });
});

describe('visibleActivity', () => {
  const mine = { type: 'chat', chatId: 1, projectId: 5, userId: 1, agent: 'pm', status: 'waiting_for_user', jobId: 30, question: 'Q?' };
  const theirs = { ...mine, chatId: 2, userId: 2 };
  it('passes own records whole, withholds others from members, strips the question for owners', () => {
    expect(visibleActivity(mine, { userId: 1, everyone: false })).toBe(mine);
    expect(visibleActivity(theirs, { userId: 1, everyone: false })).toBeNull();
    expect(visibleActivity(theirs, { userId: 1, everyone: true })).toEqual({ ...theirs, question: null });
    expect(visibleActivity({ type: 'doc_status', id: 1 }, { userId: 1, everyone: true })).toBeNull();
  });
});
