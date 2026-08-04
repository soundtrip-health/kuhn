// Story 008-004: comments store + quote resolution. Real in-memory SQLite;
// pure service-level coverage — the HTTP contract lives in
// ../routes/comments.test.js.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let comments;
let PROJECT_ID;
const USER = 9;
const OTHER_USER = 10;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  comments = await import('./comments.js');
});

beforeEach(() => {
  querySync('DELETE FROM comments');
  querySync('DELETE FROM review_links');
  querySync('DELETE FROM users');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync("INSERT INTO users (id, email, display_name) VALUES ($1, 'dev@kuhn.local', 'Dev User')", [USER]);
  querySync("INSERT INTO users (id, email, display_name) VALUES ($1, 'other@kuhn.local', 'Other User')", [OTHER_USER]);
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id",
  );
  PROJECT_ID = rows[0].id;
});

describe('resolveQuote', () => {
  const DOC = 'Intro line.\n\nThe cohort was assembled from claims data.\nMore text follows here.\n';

  it('finds an exact quote', () => {
    expect(comments.resolveQuote(DOC, 'assembled from claims data')).toMatchObject({
      start: DOC.indexOf('assembled'), exact: true,
    });
  });

  it('returns null when the quote is absent', () => {
    expect(comments.resolveQuote(DOC, 'randomized controlled trial')).toBeNull();
  });

  it('picks the occurrence nearest the hint', () => {
    const doc = 'alpha beta\nfiller\nalpha beta\n';
    const second = doc.lastIndexOf('alpha beta');
    expect(comments.resolveQuote(doc, 'alpha beta', { hint: second - 2 }).start).toBe(second);
    expect(comments.resolveQuote(doc, 'alpha beta').start).toBe(0);
  });

  it('falls back to whitespace-normalized matching across reflow', () => {
    const range = comments.resolveQuote(DOC, 'claims data.  More   text');
    expect(range.exact).toBe(false);
    expect(DOC.slice(range.start, range.end)).toBe('claims data.\nMore text');
  });
});

describe('threads', () => {
  const anchor = { quote: 'target text', start: 5, end: 16 };

  const root = (over = {}) => comments.createThread(PROJECT_ID, {
    path: 'draft/main.md', body: 'Needs a citation.', ...anchor, userId: USER, ...over,
  });

  it('creates a root with anchor and author identity', () => {
    const t = root();
    expect(t).toMatchObject({
      path: 'draft/main.md', body: 'Needs a citation.', parentId: null,
      userId: USER, userName: 'Dev User', agent: null,
      anchor: { quote: 'target text', start: 5, end: 16 },
      orphaned: false, resolvedAt: null, replies: [],
    });
  });

  it('nests replies under their root and keeps thread order', () => {
    const t = root();
    comments.addReply(PROJECT_ID, t.id, { body: 'On it.', agentSlug: 'writer', userId: USER });
    const threads = comments.listThreads(PROJECT_ID, { path: 'draft/main.md' });
    expect(threads).toHaveLength(1);
    expect(threads[0].replies).toHaveLength(1);
    expect(threads[0].replies[0]).toMatchObject({ body: 'On it.', agent: 'writer', parentId: t.id, anchor: null });
  });

  it('rejects replying to a reply', () => {
    const t = root();
    const r = comments.addReply(PROJECT_ID, t.id, { body: 'reply', userId: USER });
    expect(() => comments.addReply(PROJECT_ID, r.id, { body: 'nested', userId: USER }))
      .toThrowError(/thread root/);
  });

  it('resolves and reopens the root only', () => {
    const t = root();
    const resolved = comments.setResolved(PROJECT_ID, t.id, true, { userId: USER });
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.resolvedByName).toBe('Dev User');
    const reopened = comments.setResolved(PROJECT_ID, t.id, false, {});
    expect(reopened.resolvedAt).toBeNull();
    const r = comments.addReply(PROJECT_ID, t.id, { body: 'reply', userId: USER });
    expect(() => comments.setResolved(PROJECT_ID, r.id, true, {})).toThrowError(/thread root/);
  });

  it('updates anchors partially and round-trips the orphan flag', () => {
    const t = root();
    const moved = comments.updateAnchor(PROJECT_ID, t.id, { start: 42, end: 53 });
    expect(moved.anchor).toEqual({ quote: 'target text', start: 42, end: 53 });
    expect(comments.updateAnchor(PROJECT_ID, t.id, { orphaned: true }).orphaned).toBe(true);
    expect(comments.updateAnchor(PROJECT_ID, t.id, { orphaned: false }).orphaned).toBe(false);
  });

  it('delete is author-only and cascades a root to its replies', () => {
    const t = root();
    comments.addReply(PROJECT_ID, t.id, { body: 'reply', userId: OTHER_USER });
    expect(() => comments.deleteOwn(PROJECT_ID, t.id, { userId: OTHER_USER }))
      .toThrowError(/author/);
    comments.deleteOwn(PROJECT_ID, t.id, { userId: USER });
    expect(comments.listThreads(PROJECT_ID)).toHaveLength(0);
  });

  it('counts unresolved roots per path', () => {
    const a = root();
    root({ path: 'draft/other.md' });
    root(); // second unresolved on main
    comments.setResolved(PROJECT_ID, a.id, true, { userId: USER });
    expect(comments.unresolvedCounts(PROJECT_ID)).toEqual({
      'draft/main.md': 1, 'draft/other.md': 1,
    });
  });

  it('scopes rows to the project', () => {
    root();
    expect(() => comments.setResolved(PROJECT_ID + 1, 999, true, {})).toThrowError(/No comment/);
    expect(comments.listThreads(PROJECT_ID + 1)).toHaveLength(0);
  });
});

describe('reviewer attribution (epic 013)', () => {
  /** A claimed review link row; the store's own tests cover minting. */
  const link = (over = {}) => querySync(
    `INSERT INTO review_links
       (project_id, path, mode, token_hash, created_by, reviewer_name, claimed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '2999-01-01T00:00:00.000Z')
     RETURNING id`,
    [PROJECT_ID, over.path ?? 'draft/main.md', over.mode ?? 'comment',
     over.tokenHash ?? `hash-${Math.random()}`, USER, over.name ?? 'Jane'],
  ).rows[0].id;

  const reviewerRoot = (linkId, over = {}) => comments.createThread(PROJECT_ID, {
    path: 'draft/main.md', body: 'External note.', quote: 'target', start: 1, end: 7,
    userId: null, reviewLinkId: linkId, ...over,
  });

  it('creates reviewer-authored roots and replies with the joined display name', () => {
    const linkId = link();
    const t = reviewerRoot(linkId);
    expect(t).toMatchObject({
      userId: null, userName: null, reviewLinkId: linkId, reviewerName: 'Jane', agent: null,
    });
    const r = comments.addReply(PROJECT_ID, t.id, { body: 'more', reviewLinkId: linkId });
    expect(r).toMatchObject({ reviewLinkId: linkId, reviewerName: 'Jane', userId: null });
    // Member rows are unchanged: no reviewer fields.
    const m = comments.createThread(PROJECT_ID, { path: 'draft/main.md', body: 'member', userId: USER });
    expect(m).toMatchObject({ reviewLinkId: null, reviewerName: null, userName: 'Dev User' });
  });

  it('resolve stamps resolved_by_link_id and its reviewer name; reopen clears both', () => {
    const linkId = link();
    const t = reviewerRoot(linkId);
    const resolved = comments.setResolved(PROJECT_ID, t.id, true, { reviewLinkId: linkId });
    expect(resolved).toMatchObject({
      resolvedBy: null, resolvedByLinkId: linkId, resolvedByReviewerName: 'Jane',
    });
    expect(resolved.resolvedAt).toBeTruthy();
    const reopened = comments.setResolved(PROJECT_ID, t.id, false, {});
    expect(reopened).toMatchObject({ resolvedAt: null, resolvedByLinkId: null });
  });

  it('deleteOwn: reviewers are exact-identity; members also delete reviewer content', () => {
    const linkId = link();
    const otherLinkId = link({ name: 'Joe', tokenHash: 'hash-other' });
    const reviewer = reviewerRoot(linkId);
    const member = comments.createThread(PROJECT_ID, { path: 'draft/main.md', body: 'm', userId: USER });

    // Reviewer cannot delete a member's comment, another link's, or with no identity.
    expect(() => comments.deleteOwn(PROJECT_ID, member.id, { reviewLinkId: linkId }))
      .toThrowError(/author/);
    expect(() => comments.deleteOwn(PROJECT_ID, reviewer.id, { reviewLinkId: otherLinkId }))
      .toThrowError(/author/);
    expect(() => comments.deleteOwn(PROJECT_ID, reviewer.id, {})).toThrowError(/author/);
    // A member is NOT exact-identity against guests: reviewer-authored rows are
    // deletable by any member — otherwise a revoked link's comments would be
    // permanently undeletable (no session can ever own them again).
    comments.deleteOwn(PROJECT_ID, reviewer.id, { userId: USER });

    // Each identity deletes its own; members still can't delete other members'.
    const reviewer2 = reviewerRoot(linkId);
    expect(() => comments.deleteOwn(PROJECT_ID, member.id, { userId: OTHER_USER }))
      .toThrowError(/author/);
    comments.deleteOwn(PROJECT_ID, reviewer2.id, { reviewLinkId: linkId });
    comments.deleteOwn(PROJECT_ID, member.id, { userId: USER });
    expect(comments.listThreads(PROJECT_ID)).toHaveLength(0);
  });

  it('link deletion degrades attribution to NULL without dropping the comment', () => {
    const linkId = link();
    const t = reviewerRoot(linkId);
    querySync('DELETE FROM review_links WHERE id = $1', [linkId]);
    const [thread] = comments.listThreads(PROJECT_ID, { path: 'draft/main.md' });
    expect(thread.id).toBe(t.id);
    expect(thread).toMatchObject({ reviewLinkId: null, reviewerName: null });
  });
});
