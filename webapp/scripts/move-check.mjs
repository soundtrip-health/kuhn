// Story 012-002: token-free end-to-end check that a move carries a file's
// identity with it. Everything runs through the REST surface the UI uses — no
// browser, no LLM tokens; only the backend needs to be up (agent-backend:
// npm run dev).
//   node scripts/move-check.mjs
//
// Verifies (AC 1, 2, 4, 5):
//   1. comment threads (roots + replies), the unresolved-count map and a
//      pending edit all follow a moved FILE; the old path 404s cleanly
//   2. a FOLDER move re-keys every descendant in one shot and leaves a
//      prefix look-alike (`move-check-directive.md` vs `move-check-dir`)
//      completely untouched
//   3. each move writes exactly ONE 'moved' activity entry carrying
//      meta.from — never the delete+create pair that used to orphan
//      everything, and never one entry per descendant
//
// Runs against projects[0] (override with PROJECT_ID). The local data
// directory is disposable — every project in it is a test project — so no
// ceremony is needed. Paths are still `move-check`-prefixed and purge()d at
// startup and from a finally block, purely so repeated runs stay readable.

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, label) => {
  console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`);
  if (!cond) fail(label);
};

const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const projectId = Number(process.env.PROJECT_ID) || projects[0].id;
const api = (p) => `${BACKEND}/api/projects/${projectId}${p}`;
const fileApi = (path) => api(`/file?path=${encodeURIComponent(path)}`);
const getJson = async (url) => (await fetch(url)).json();

// --- The paths this script owns, and nothing else ---------------------------
// The file leg stays inside draft/** because that is the suggestion scope
// (pending-edits.js isSuggestionPath), so the pending edit is legal at both
// ends of the move.
const SRC = 'draft/move-check-src.md';
const DST = 'draft/move-check-archive/move-check-src.md';
const DIR = 'move-check-dir';
const DIR_A = `${DIR}/a.md`;
const DIR_B = `${DIR}/sub/b.md`;
const DIR_DST = 'move-check-archive/move-check-dir';
const DIR_DST_A = `${DIR_DST}/a.md`;
const DIR_DST_B = `${DIR_DST}/sub/b.md`;
// The prefix look-alike: `move-check-dir` must not match this on the way past.
const DECOY = 'move-check-directive.md';

const OWNED = [SRC, 'draft/move-check-archive', DIR, 'move-check-archive', DECOY];
const owned = (path) =>
  typeof path === 'string' && OWNED.some((p) => path === p || path.startsWith(`${p}/`));

const flatten = (nodes) =>
  nodes.flatMap((n) => (n.type === 'dir' ? flatten(n.children ?? []) : [n]));
const treePaths = async () => flatten((await getJson(api('/files'))).tree).map((n) => n.path);

const putFile = (path, body) =>
  fetch(fileApi(path), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
const moveEntry = (from, to) =>
  fetch(api('/files/move'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
const postJson = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const threadsAt = async (path) =>
  (await getJson(api(`/comments?path=${encodeURIComponent(path)}`))).threads ?? [];
const pendingAt = async (path) =>
  (await getJson(api(`/pending-edits?path=${encodeURIComponent(path)}`))).edits ?? [];
const activity = async () => (await getJson(api('/files/activity?limit=200'))).events ?? [];
const latestEventId = async () => (await activity()).reduce((max, e) => Math.max(max, e.id), 0);
const eventsSince = async (id) => (await activity()).filter((e) => e.id > id);
const status = async (url) => (await fetch(url)).status;

/** Remove every row and every byte this script owns. Safe to run twice. */
async function purge() {
  for (const t of (await getJson(api('/comments'))).threads ?? []) {
    if (owned(t.path)) await fetch(api(`/comments/${t.id}`), { method: 'DELETE' }).catch(() => {});
  }
  for (const e of (await getJson(api('/pending-edits'))).edits ?? []) {
    if (owned(e.path)) await postJson(api(`/pending-edits/${e.id}/reject`), {}).catch(() => {});
  }
  // Directories delete recursively, so the destination trees go with them.
  for (const p of OWNED) await fetch(fileApi(p), { method: 'DELETE' }).catch(() => {});
}

const comment = async (path, body, quote) => {
  const res = await postJson(api('/comments'), {
    path,
    body,
    anchor: { quote, start: 0, end: quote.length },
  });
  if (!res.ok) {
    console.error(`POST /comments failed for ${path}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
};

await purge();

try {
  // ==========================================================================
  // 1. FILE MOVE — comments, unresolved counts and pending edits follow
  // ==========================================================================
  const QUOTE = 'Bravo paragraph carries the thread.';
  const BASE = ['# Move check', '', 'Alpha paragraph stays put.', '', QUOTE, ''].join('\n');
  // PUT is deliberately unpublished (routes/files.js: the autosave path), so
  // every activity row observed after the marker below comes from the move.
  await putFile(SRC, BASE);

  const thread = await comment(SRC, 'Does this survive the move?', QUOTE);
  const replyRes = await postJson(api(`/comments/${thread.id}/replies`), { body: 'It had better.' });
  check(replyRes.status === 201, `reply created (got ${replyRes.status})`);

  const proposeRes = await postJson(api('/pending-edits'), {
    path: SRC,
    proposedContent: `${BASE}\nCharlie paragraph is proposed.\n`,
    agent: 'reviewer',
  });
  const proposeBody = await proposeRes.json();
  const pending = proposeBody.edit ?? proposeBody;
  check(proposeRes.status === 201 && pending.id != null, `pending edit created (got ${proposeRes.status})`);

  const countsBefore = (await getJson(api('/comments/counts'))).counts;
  check(countsBefore[SRC] === 1, `unresolved count is keyed by the old path before the move`);

  const marker = await latestEventId();
  const mvRes = await moveEntry(SRC, DST);
  const mvBody = await mvRes.json();
  check(mvRes.status === 200, `move returns 200 (got ${mvRes.status})`);
  check(
    mvBody.from === SRC && mvBody.to === DST,
    `move echoes the canonical paths (got ${JSON.stringify([mvBody.from, mvBody.to])})`,
  );

  // --- consumers re-keyed, nothing orphaned (AC 1) ---
  const movedThreads = await threadsAt(DST);
  check(
    movedThreads.length === 1 && movedThreads[0].id === thread.id,
    'comment thread follows the file to the new path',
  );
  check(movedThreads[0]?.replies?.length === 1, 'the reply follows the root thread');
  check((await threadsAt(SRC)).length === 0, 'no comment thread is left behind at the old path');

  const countsAfter = (await getJson(api('/comments/counts'))).counts;
  check(countsAfter[DST] === 1, 'unresolved count is re-keyed to the new path');
  check(countsAfter[SRC] === undefined, 'unresolved count no longer mentions the old path');

  const movedPending = await pendingAt(DST);
  check(
    movedPending.length === 1 && movedPending[0].id === pending.id,
    'pending edit follows the file (same row, not a new proposal)',
  );
  check((await pendingAt(SRC)).length === 0, 'no pending edit is left behind at the old path');

  // --- old path 404s cleanly, new path serves the same bytes (AC 5) ---
  check(await status(fileApi(SRC)) === 404, 'old path 404s after the move');
  const newRes = await fetch(fileApi(DST));
  check(newRes.status === 200, `new path serves the file (got ${newRes.status})`);
  check((await newRes.text()) === BASE, 'moved file keeps its bytes');
  const afterMove = await treePaths();
  check(afterMove.includes(DST) && !afterMove.includes(SRC), 'the tree shows only the new path');

  // --- exactly one 'moved' entry, no delete+create pair (AC 4) ---
  const fileEvents = await eventsSince(marker);
  check(
    fileEvents.length === 1,
    `the move wrote exactly one activity row (got ${JSON.stringify(fileEvents.map((e) => [e.kind, e.path]))})`,
  );
  check(fileEvents[0]?.kind === 'moved', `the row is kind 'moved' (got ${fileEvents[0]?.kind})`);
  check(fileEvents[0]?.path === DST, 'the row is keyed by the NEW path');
  check(fileEvents[0]?.meta?.from === SRC, `the row carries meta.from (got ${JSON.stringify(fileEvents[0]?.meta)})`);

  // ==========================================================================
  // 2. FOLDER MOVE — every descendant re-keyed, the look-alike untouched
  // ==========================================================================
  const A_QUOTE = 'Descendant A is commented.';
  const B_QUOTE = 'Descendant B is commented.';
  const D_QUOTE = 'The decoy is commented.';
  await putFile(DIR_A, `# a\n\n${A_QUOTE}\n`);
  await putFile(DIR_B, `# b\n\n${B_QUOTE}\n`);
  await putFile(DECOY, `# decoy\n\n${D_QUOTE}\n`);

  const threadA = await comment(DIR_A, 'Thread on a.md.', A_QUOTE);
  const threadB = await comment(DIR_B, 'Thread on sub/b.md.', B_QUOTE);
  const threadDecoy = await comment(DECOY, 'Thread on the prefix look-alike.', D_QUOTE);

  const dirMarker = await latestEventId();
  const dirRes = await moveEntry(DIR, DIR_DST);
  check(dirRes.status === 200, `folder move returns 200 (got ${dirRes.status})`);

  const threadsA = await threadsAt(DIR_DST_A);
  const threadsB = await threadsAt(DIR_DST_B);
  check(threadsA.length === 1 && threadsA[0].id === threadA.id, 'descendant a.md keeps its thread under the new prefix');
  check(threadsB.length === 1 && threadsB[0].id === threadB.id, 'nested descendant sub/b.md keeps its thread too');
  check(
    (await threadsAt(DIR_A)).length === 0 && (await threadsAt(DIR_B)).length === 0,
    'no descendant thread is stranded at an old path',
  );

  // The whole point of the `|| '/'` prefix predicate: `move-check-dir` must
  // not drag `move-check-directive.md` along with it.
  const decoyThreads = await threadsAt(DECOY);
  check(
    decoyThreads.length === 1 && decoyThreads[0].id === threadDecoy.id,
    'the prefix look-alike keeps its comment thread',
  );
  check(await status(fileApi(DECOY)) === 200, 'the prefix look-alike file is untouched on disk');

  const afterDirMove = await treePaths();
  check(
    afterDirMove.includes(DIR_DST_A) && afterDirMove.includes(DIR_DST_B),
    'both descendants appear under the new folder path',
  );
  check(
    !afterDirMove.includes(DIR_A) && !afterDirMove.includes(DIR_B),
    'no descendant is left at the old folder path',
  );
  check(afterDirMove.includes(DECOY), 'the prefix look-alike is still in the tree');
  check(await status(fileApi(DIR_A)) === 404, 'an old descendant path 404s after the folder move');

  // One event for the FOLDER itself; descendants are implied by prefix.
  const dirEvents = await eventsSince(dirMarker);
  check(
    dirEvents.length === 1,
    `the folder move wrote exactly one activity row (got ${JSON.stringify(dirEvents.map((e) => [e.kind, e.path]))})`,
  );
  check(
    dirEvents[0]?.kind === 'moved' && dirEvents[0]?.path === DIR_DST && dirEvents[0]?.meta?.from === DIR,
    `the row is the folder's own 'moved' entry (got ${JSON.stringify(dirEvents[0]?.meta)})`,
  );
} finally {
  // Always — leftover fixtures make the next run's output confusing.
  await purge();
  const leftovers = (await treePaths()).filter(owned);
  check(leftovers.length === 0, `cleanup left nothing behind (${JSON.stringify(leftovers)})`);
}

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
