import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Real in-memory SQLite (slide-themes.test.js pattern): the chat SQL — the
// upsert, the status projection join, the cascade — is the substance.
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync;
let chats;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  chats = await import('./chats.js');
});

beforeEach(() => {
  querySync('DELETE FROM jobs');
  querySync('DELETE FROM chats');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'A', 'a')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'one@a.test'), (2, 'two@a.test')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (5, 1, 'Alpha', 'manuscript'), (6, 1, 'Beta', 'manuscript')");
});

const insertJob = (id, { status = 'running', error = null, chatId = null } = {}) => {
  querySync(
    'INSERT INTO jobs (id, project_id, user_id, role, status, error, input, chat_id) VALUES ($1, 5, 1, $2, $3, $4, $5, $6)',
    [id, 'pm', status, error, 'go', chatId],
  );
};

describe('getOrCreateChat', () => {
  it('is idempotent per (project, agent, user) and distinct across each', async () => {
    const a = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    const again = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    expect(again.id).toBe(a.id);
    expect(a).toMatchObject({
      project_id: 5, agent_slug: 'pm', user_id: 1, session_id: null, continuation: null,
      pinned_profile: null, pending_handoff: null, current_job_id: null, status: 'idle',
    });
    const otherAgent = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'writer', userId: 1 });
    const otherUser = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 2 });
    const otherProject = await chats.getOrCreateChat({ projectId: 6, agentSlug: 'pm', userId: 1 });
    expect(new Set([a.id, otherAgent.id, otherUser.id, otherProject.id]).size).toBe(4);
    expect(querySync('SELECT COUNT(*) AS n FROM chats').rows[0].n).toBe(4);
  });
});

describe('updateChat / getChat', () => {
  it('round-trips the JSON continuation and clears with explicit null', async () => {
    const { id } = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    const continuation = { version: 1, messages: [{ role: 'user', content: 'hi' }] };
    const updated = await chats.updateChat(id, { sessionId: 'sess-1', continuation, pinnedProfile: 'strong' });
    expect(updated).toMatchObject({ session_id: 'sess-1', continuation, pinned_profile: 'strong' });
    expect(await chats.getChat(id)).toMatchObject({ continuation });
    const cleared = await chats.updateChat(id, { continuation: null, pinnedProfile: null });
    expect(cleared.continuation).toBeNull();
    expect(cleared.pinned_profile).toBeNull();
    // No fields → a plain read.
    expect((await chats.updateChat(id, {})).session_id).toBe('sess-1');
    expect(await chats.getChat(9999)).toBeUndefined();
  });
});

describe('status projection (read-time, from current_job_id)', () => {
  it('is running while the current job is pending/running, paused on a budget pause, else idle', async () => {
    const { id } = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    expect((await chats.getChat(id)).status).toBe('idle');

    insertJob(10, { status: 'pending', chatId: id });
    await chats.startChatJob(id, 10);
    let chat = await chats.getChat(id);
    expect(chat.status).toBe('running');
    expect(chat.current_job_id).toBe(10);
    expect(chat.last_message_at).toEqual(expect.any(String));

    querySync("UPDATE jobs SET status = 'running' WHERE id = 10");
    expect((await chats.getChat(id)).status).toBe('running');

    querySync("UPDATE jobs SET status = 'error', error = 'token budget exceeded' WHERE id = 10");
    expect((await chats.getChat(id)).status).toBe('paused');

    querySync("UPDATE jobs SET status = 'error', error = 'boom' WHERE id = 10");
    expect((await chats.getChat(id)).status).toBe('idle');

    querySync("UPDATE jobs SET status = 'done', error = NULL WHERE id = 10");
    expect((await chats.getChat(id)).status).toBe('idle');

    // The projection is a pure function too (used by the list join).
    expect(chats.chatStatus(null)).toBe('idle');
    expect(chats.chatStatus({ status: 'cancelled' })).toBe('idle');
    expect(chats.chatStatus({ status: 'interrupted' })).toBe('idle');
  });

  it('lists only the caller\'s chats in the project, most recently active first', async () => {
    const pm = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    const writer = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'writer', userId: 1 });
    await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 2 });
    await chats.getOrCreateChat({ projectId: 6, agentSlug: 'pm', userId: 1 });
    insertJob(11, { status: 'running', chatId: writer.id });
    await chats.startChatJob(writer.id, 11);

    const list = await chats.listProjectChats(5, 1);
    expect(list.map((c) => [c.id, c.agent_slug, c.status])).toEqual([
      [writer.id, 'writer', 'running'],
      [pm.id, 'pm', 'idle'],
    ]);
  });
});

describe('startChatJob / recordChatRun', () => {
  it('consumes the parked hand-off when a job starts and records the run\'s session only for the current job', async () => {
    const { id } = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    await chats.updateChat(id, { pendingHandoff: 'Finish §3.' });
    insertJob(20, { chatId: id });
    await chats.startChatJob(id, 20);
    expect((await chats.getChat(id)).pending_handoff).toBeNull();

    await chats.recordChatRun(id, 20, { sessionId: 'sess-20', continuation: { version: 1 } });
    expect(await chats.getChat(id)).toMatchObject({ session_id: 'sess-20', continuation: { version: 1 } });

    // A stale job's late terminal must not re-seed the chat.
    insertJob(21, { chatId: id });
    await chats.startChatJob(id, 21);
    await chats.recordChatRun(id, 20, { sessionId: 'stale' });
    expect((await chats.getChat(id)).session_id).toBe('sess-20');
    await chats.recordChatRun(id, 21, { sessionId: 'sess-21' });
    expect((await chats.getChat(id)).session_id).toBe('sess-21');
  });
});

describe('resetChat / clearPendingHandoff / setPinnedProfile', () => {
  it('reset forgets the session, continuation and current job, parks the note, and keeps the pin', async () => {
    const { id } = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    insertJob(30, { status: 'done', chatId: id });
    await chats.startChatJob(id, 30);
    await chats.updateChat(id, { sessionId: 'sess-30', continuation: { version: 1 }, pinnedProfile: 'cheap' });

    const reset = await chats.resetChat(id, { handoff: 'Open: pick a journal.' });
    expect(reset).toMatchObject({
      session_id: null, continuation: null, current_job_id: null,
      pending_handoff: 'Open: pick a journal.', pinned_profile: 'cheap', status: 'idle',
    });
    // The job row is untouched — the transcript and audit trail stay.
    expect(querySync('SELECT chat_id FROM jobs WHERE id = 30').rows[0].chat_id).toBe(id);

    expect((await chats.clearPendingHandoff(id)).pending_handoff).toBeNull();
    // A reset without a note clears a stale one too.
    await chats.updateChat(id, { pendingHandoff: 'stale' });
    expect((await chats.resetChat(id)).pending_handoff).toBeNull();

    expect((await chats.setPinnedProfile(id, 'strong')).pinned_profile).toBe('strong');
    expect((await chats.setPinnedProfile(id, null)).pinned_profile).toBeNull();
  });
});

describe('referential integrity', () => {
  it('cascades on project delete and nulls jobs.chat_id when a chat goes', async () => {
    const { id } = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    insertJob(40, { status: 'done', chatId: id });
    await chats.startChatJob(id, 40);
    // Deleting the chat alone leaves the job, unlinked.
    querySync('DELETE FROM chats WHERE id = $1', [id]);
    expect(querySync('SELECT chat_id FROM jobs WHERE id = 40').rows[0].chat_id).toBeNull();

    const again = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 2 });
    expect(again.id).not.toBe(id);
    querySync('DELETE FROM projects WHERE id = 5');
    expect(querySync('SELECT COUNT(*) AS n FROM chats').rows[0].n).toBe(0);
  });

  it('a job that ends the current job link on delete leaves the chat idle', async () => {
    const { id } = await chats.getOrCreateChat({ projectId: 5, agentSlug: 'pm', userId: 1 });
    insertJob(50, { status: 'running', chatId: id });
    await chats.startChatJob(id, 50);
    querySync('DELETE FROM jobs WHERE id = 50');
    expect(await chats.getChat(id)).toMatchObject({ current_job_id: null, status: 'idle' });
  });
});
