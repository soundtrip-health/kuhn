// reanchorPath (issue #153): server-side anchor maintenance after an import
// replaces a document underneath its comments.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';
const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync; let comments; let P;
const USER = 9;
const PATH = 'draft/main.md';
const V1 = 'Intro line.\n\nResponse rates exceeded 60% at week 1.\nMore text follows here.\n';

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  comments = await import('./comments.js');
});

beforeEach(() => {
  querySync('DELETE FROM comments');
  querySync('DELETE FROM users');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync("INSERT INTO users (id, email, display_name) VALUES ($1, 'dev@kuhn.local', 'Dev')", [USER]);
  P = querySync("INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id").rows[0].id;
});

function thread(quote, content = V1) {
  const start = content.indexOf(quote);
  return comments.createThread(P, { path: PATH, body: 'b', quote, start, end: start + quote.length, userId: USER });
}

describe('reanchorPath', () => {
  it('moves anchors whose quote shifted and leaves exact ones alone', () => {
    const t = thread('exceeded 60%');
    const v2 = `# New heading\n\n${V1}`;
    const r = comments.reanchorPath(P, PATH, v2);
    expect(r).toEqual({ reanchored: 1, orphaned: 0, unchanged: 0 });
    const [got] = comments.listThreads(P, { path: PATH });
    expect(got.anchor.start).toBe(v2.indexOf('exceeded 60%'));
    expect(got.anchor.end).toBe(v2.indexOf('exceeded 60%') + 'exceeded 60%'.length);
    expect(got.orphaned).toBe(false);
    expect(got.id).toBe(t.id);
    expect(comments.reanchorPath(P, PATH, v2)).toEqual({ reanchored: 0, orphaned: 0, unchanged: 1 });
  });

  it('orphans a missing quote, and un-orphans it when the text returns', () => {
    thread('exceeded 60%');
    expect(comments.reanchorPath(P, PATH, 'Completely different text.\n')).toEqual({ reanchored: 0, orphaned: 1, unchanged: 0 });
    expect(comments.listThreads(P, { path: PATH })[0].orphaned).toBe(true);
    expect(comments.reanchorPath(P, PATH, V1)).toEqual({ reanchored: 1, orphaned: 0, unchanged: 0 });
    expect(comments.listThreads(P, { path: PATH })[0].orphaned).toBe(false);
  });

  it('uses the whitespace-normalized fallback when the quote was reflowed', () => {
    thread('More text follows here.');
    const v2 = V1.replace('More text follows here.', 'More  text\nfollows here.');
    const r = comments.reanchorPath(P, PATH, v2);
    expect(r.reanchored).toBe(1);
    const [got] = comments.listThreads(P, { path: PATH });
    expect(v2.slice(got.anchor.start, got.anchor.end)).toBe('More  text\nfollows here.');
    expect(got.orphaned).toBe(false);
  });

  it('ignores replies and other paths, and counts quote-less roots as unchanged', () => {
    const t = thread('Intro line.');
    comments.addReply(P, t.id, { body: 'r', userId: USER });
    comments.createThread(P, { path: PATH, body: 'general', userId: USER });
    comments.createThread(P, { path: 'draft/other.md', body: 'x', quote: 'Intro line.', start: 0, end: 11, userId: USER });
    expect(comments.reanchorPath(P, PATH, 'nothing here')).toEqual({ reanchored: 0, orphaned: 1, unchanged: 1 });
    expect(comments.listThreads(P, { path: 'draft/other.md' })[0].orphaned).toBe(false);
  });
});
