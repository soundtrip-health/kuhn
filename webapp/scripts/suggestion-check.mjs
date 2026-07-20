// Browser check for story 008-001: suggestion mode for agent edits. A pending
// edit is created through the contract's REST create endpoint
// (POST /api/projects/:id/pending-edits) — the same row the agent tool path
// writes — so this needs no LLM tokens, only the backend (agent-backend:
// npm run dev) and the webapp (npm run dev).
//   node scripts/suggestion-check.mjs
//
// Verifies: the tree shows the 'suggested' badge, the open doc renders per-hunk
// decorations (struck deletions, green insertion previews, header bar with the
// hunk count), accepting one hunk via the UI writes the file server-side and
// reconciles the remaining count, rejecting the rest leaves the document
// untouched and clears badge + decorations.
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const PATH = 'draft/main.md';

// Two edits far enough apart (context: 2) to derive two hunks: a replacement
// (hunk 0: strike + preview) and a pure insertion (hunk 1: preview only).
const REVISED = 'Bravo paragraph now argues the opposite.';
const INSERTED = 'Golf paragraph is entirely new.';
const BASE = [
  '# Suggestion check',
  '',
  'Alpha paragraph stays untouched.',
  '',
  'Bravo paragraph will be revised.',
  '',
  'Charlie paragraph stays untouched.',
  '',
  'Delta paragraph stays untouched.',
  '',
  'Echo paragraph stays untouched.',
  '',
  'Foxtrot paragraph anchors the tail.',
  '',
].join('\n');
const PROPOSED = BASE
  .replace('Bravo paragraph will be revised.', REVISED)
  .replace('Foxtrot paragraph anchors the tail.', `${INSERTED}\n\nFoxtrot paragraph anchors the tail.`);

const errors = [];
const fail = (msg) => errors.push(msg);

const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const projectId = projects[0].id;
const docUrl = `${BACKEND}/api/projects/${projectId}/file?path=${encodeURIComponent(PATH)}`;
const pendingUrl = `${BACKEND}/api/projects/${projectId}/pending-edits`;
const originalDoc = await (await fetch(docUrl)).text();

const fetchDoc = async () => (await fetch(docUrl)).text();
const putDoc = async (content) =>
  fetch(docUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content });
const fetchPending = async () => (await (await fetch(pendingUrl)).json()).edits;

// Reject every pending edit for the path (test cleanup, and pre-test reset).
async function clearPending() {
  for (const edit of await fetchPending()) {
    if (edit.path !== PATH) continue;
    await fetch(`${pendingUrl}/${edit.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }
}

// Poll until a condition holds (the accept flow is event-driven end to end).
async function until(label, fn, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > deadline) {
      fail(`timed out: ${label}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---- Seed the row over a known base ----
await clearPending();
await putDoc(BASE);
const createRes = await fetch(pendingUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: PATH, proposedContent: PROPOSED, agent: 'reviewer' }),
});
if (!createRes.ok) {
  console.error(`POST /pending-edits failed: ${createRes.status} ${await createRes.text()}`);
  process.exit(1);
}
const createBody = await createRes.json();
const created = createBody.edit ?? createBody;
console.log('created pending edit:', created.id, 'hunks:', created.hunks?.length);
if (created.hunks?.length !== 2) fail(`expected 2 derived hunks, got ${created.hunks?.length}`);

// The proposal must not touch the stored bytes.
if ((await fetchDoc()) !== BASE) fail('creating a pending edit changed the stored file');

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));

// The empty-state hero is not under test; remove it so it can't intercept
// clicks (same guard as write-check.mjs). Re-run after every (re)load.
const killHero = () => page.evaluate(() => document.getElementById('editor-hero')?.remove());

try {
  await page.goto(WEBAPP);
  await page.waitForSelector('#editor .milkdown', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await killHero();

  // ---- Tree badge: 'suggested' (wins over the modified badge from our PUT) ----
  const badgeSel = `.file-entry[data-path="${PATH}"] .file-badge.is-suggested`;
  await page.waitForSelector(badgeSel, { timeout: 8000 })
    .catch(() => fail('tree does not show the suggested badge'));
  console.log('suggested badge shown:', (await page.locator(badgeSel).count()) > 0);

  // ---- Inline decorations on the open doc ----
  await page.waitForSelector('.suggestion-bar', { timeout: 8000 })
    .catch(() => fail('suggestion header bar did not render'));
  const barText = await page.textContent('.suggestion-bar').catch(() => '');
  if (!/2 suggested changes from Reviewer/.test(barText ?? '')) {
    fail(`header bar text unexpected: "${barText}"`);
  }
  console.log('header bar:', barText?.trim());
  if ((await page.locator('.sh-del').count()) < 1) fail('no struck-through deletion decoration');
  if ((await page.locator('.suggestion-hunk').count()) !== 2) {
    fail(`expected 2 hunk widgets, got ${await page.locator('.suggestion-hunk').count()}`);
  }
  const insTexts = await page.locator('.sh-ins').allTextContents();
  if (!insTexts.some((t) => t.includes(REVISED))) fail('replacement hunk preview missing');
  if (!insTexts.some((t) => t.includes(INSERTED))) fail('insertion hunk preview missing');
  console.log('hunk previews:', insTexts.map((t) => t.slice(0, 40)));

  // Buttons must not have applied anything client-side yet.
  if ((await fetchDoc()) !== BASE) fail('rendering suggestions changed the stored file');

  // ---- Accept one hunk (the replacement) via the UI ----
  await page.click('.suggestion-hunk .sh-accept');
  await until('accepted hunk written server-side', async () => {
    const doc = await fetchDoc();
    return doc.includes(REVISED) && !doc.includes('will be revised');
  });
  const midDoc = await fetchDoc();
  if (midDoc.includes(INSERTED)) fail('unaccepted hunk leaked into the file');
  console.log('accepted hunk persisted:', midDoc.includes(REVISED));

  // Editor content refreshes through the file_change path; decorations
  // reconcile to the one remaining hunk.
  await until('editor shows the accepted text', async () =>
    ((await page.textContent('#editor .milkdown')) ?? '').includes(REVISED));
  await until('header bar reconciles to 1 remaining change', async () =>
    /1 suggested change\b/.test((await page.textContent('.suggestion-bar').catch(() => '')) ?? ''));
  await page.screenshot({ path: '/tmp/kuhn-suggestion-check.png' });

  // ---- Reject the remaining hunk via the UI ----
  await page.click('.suggestion-hunk .sh-reject');
  await until('pending edit row removed after reject', async () =>
    (await fetchPending()).every((e) => e.path !== PATH));
  const afterReject = await fetchDoc();
  if (afterReject.includes(INSERTED)) fail('rejected hunk left a trace in the document');
  console.log('reject left no trace:', !afterReject.includes(INSERTED));
  await until('decorations cleared after reject', async () =>
    (await page.locator('.suggestion-bar').count()) === 0 &&
    (await page.locator('.suggestion-hunk').count()) === 0);
  await until('suggested badge cleared', async () =>
    (await page.locator(badgeSel).count()) === 0);
  console.log('badge and decorations reconciled');
} finally {
  await browser.close();
  // Restore state after the client disconnects (a live Yjs room would
  // otherwise sync the test edits straight back over the file).
  await clearPending();
  await putDoc(originalDoc);
}

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
