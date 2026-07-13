import { describe, it, expect } from 'vitest';
import { waitForReply, deliverReply, cancelQuestion, hasPendingQuestion, getPendingQuestion } from './questions.js';

describe('question registry', () => {
  it('delivers a reply to the waiting job', async () => {
    const wait = waitForReply(1, 1000);
    expect(hasPendingQuestion(1)).toBe(true);
    expect(deliverReply(1, 'yes')).toBe(true);
    await expect(wait).resolves.toBe('yes');
    expect(hasPendingQuestion(1)).toBe(false);
  });

  it('returns false when no question is pending', () => {
    expect(deliverReply(99, 'hello')).toBe(false);
  });

  it('resolves null on timeout and clears the entry', async () => {
    const wait = waitForReply(2, 5);
    await expect(wait).resolves.toBeNull();
    expect(hasPendingQuestion(2)).toBe(false);
    expect(deliverReply(2, 'late')).toBe(false);
  });

  it('cancelQuestion unblocks the waiter without a reply', async () => {
    const wait = waitForReply(3, 1000);
    cancelQuestion(3);
    await expect(wait).resolves.toBeNull();
    expect(hasPendingQuestion(3)).toBe(false);
  });

  it('a new question supersedes a prior pending one for the same job', async () => {
    const first = waitForReply(4, 1000);
    const second = waitForReply(4, 1000);
    await expect(first).resolves.toBeNull();
    deliverReply(4, 'answer');
    await expect(second).resolves.toBe('answer');
  });

  it('exposes the pending question text and agent for reconnect (story 027)', async () => {
    const wait = waitForReply(5, 1000, { question: 'What type of document?', agent: 'pm' });
    expect(getPendingQuestion(5)).toEqual({ question: 'What type of document?', agent: 'pm' });
    deliverReply(5, 'manuscript');
    await wait;
    expect(getPendingQuestion(5)).toBeNull();
  });

  it('getPendingQuestion is null when nothing is pending', () => {
    expect(getPendingQuestion(123)).toBeNull();
  });

  it('waits indefinitely when timeoutMs is null (no auto-resolve)', async () => {
    const wait = waitForReply(6, null);
    expect(hasPendingQuestion(6)).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // a tick passes…
    expect(hasPendingQuestion(6)).toBe(true);    // …still parked
    deliverReply(6, 'eventually');
    await expect(wait).resolves.toBe('eventually');
  });
});
