// Browser check for story 008-004: margin comments. A thread is created
// through the REST endpoint (POST /api/projects/:id/comments) — the same rows
// the add_comment agent tool writes — so this needs no LLM tokens, only the
// backend (agent-backend: npm run dev) and the webapp (npm run dev).
//   node scripts/comments-check.mjs
//
// Verifies: the tree shows the unresolved-count badge, the open doc renders
// the anchored range decoration, the panel lists the thread (author identity +
// quote), reply and resolve work through the UI (resolve clears decoration +
// badge, thread stays browsable under Resolved), deleting the quoted text in
// the editor orphans the thread visibly (server flag round-trips), and the
// selection toolbar's Comment item opens a composer that files a new thread.
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const PATH = 'draft/main.md';
const QUOTE = 'Bravo paragraph gets a comment.';
const BASE = [
  '# Comments check',
  '',
  'Alpha paragraph stays untouched.',
  '',
  QUOTE,
  '',
  'Charlie paragraph stays untouched.',
  '',
].join('\n');

const errors = [];
const fail = (msg) => errors.push(msg);

const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const projectId = projects[0].id;
const docUrl = `${BACKEND}/api/projects/${projectId}/file?path=${encodeURIComponent(PATH)}`;
const commentsUrl = `${BACKEND}/api/projects/${projectId}/comments`;
const originalDoc = await (await fetch(docUrl)).text();

const fetchDoc = async () => (await fetch(docUrl)).text();
// DELETE then PUT: the delete publishes a real file_change, which force-closes
// any warm Yjs room from a previous run — a plain PUT (the autosave path) does
// not evict, and a stale room would replay old content over the fresh bytes.
const putDoc = async (content) => {
  await fetch(docUrl, { method: 'DELETE' });
  return fetch(docUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content });
};
const fetchThreads = async () =>
  (await (await fetch(`${commentsUrl}?path=${encodeURIComponent(PATH)}`)).json()).threads;

// Delete every thread for the path (test cleanup, and pre-test reset).
async function clearComments() {
  for (const t of await fetchThreads()) {
    await fetch(`${commentsUrl}/${t.id}`, { method: 'DELETE' });
  }
}

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

// ---- Seed a thread over a known base ----
await clearComments();
await putDoc(BASE);
const createRes = await fetch(commentsUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    path: PATH,
    body: 'Please cite a source for this claim.',
    anchor: { quote: QUOTE, start: BASE.indexOf(QUOTE), end: BASE.indexOf(QUOTE) + QUOTE.length },
  }),
});
if (!createRes.ok) {
  console.error(`POST /comments failed: ${createRes.status} ${await createRes.text()}`);
  process.exit(1);
}
const created = await createRes.json();
console.log('created thread:', created.id);

const counts = (await (await fetch(`${commentsUrl}/counts`)).json()).counts;
if (counts[PATH] !== 1) fail(`expected counts {${PATH}: 1}, got ${JSON.stringify(counts)}`);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[browser error]', msg.text().slice(0, 200));
});
page.on('response', (res) => {
  const req = res.request();
  if (req.url().includes('/comments') && req.method() !== 'GET') {
    console.log(`[api] ${req.method()} ${req.url().replace(BACKEND, '')} -> ${res.status()}`);
  }
});
const killHero = () => page.evaluate(() => document.getElementById('editor-hero')?.remove());

// Select a paragraph through the DOM Selection API (ProseMirror's observer
// maps it into state.selection) — synthetic triple-clicks race Crepe's own
// selection toolbar, which pops over the text and swallows the later clicks.
async function selectParagraph(text) {
  await page.locator('#editor .milkdown p', { hasText: text }).click(); // focus
  await page.evaluate((needle) => {
    const p = [...document.querySelectorAll('#editor .milkdown p')]
      .find((el) => el.textContent?.includes(needle));
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, text);
  await page.waitForTimeout(400); // let ProseMirror sync the selection
}

try {
  await page.goto(WEBAPP);
  await page.waitForSelector('#editor .milkdown', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await killHero();

  // ---- Tree badge: unresolved-comment count ----
  const badgeSel = `.file-entry[data-path="${PATH}"] .file-badge.is-comment`;
  await page.waitForSelector(badgeSel, { timeout: 8000 })
    .catch(() => fail('tree does not show the comment-count badge'));

  // ---- Range decoration + panel card ----
  await page.waitForSelector('.mc-range', { timeout: 8000 })
    .catch(() => fail('commented range decoration did not render'));
  await page.click('#editor-comments-btn');
  await page.waitForSelector('#comments-panel:not(.collapsed)', { timeout: 4000 })
    .catch(() => fail('comments panel did not open'));
  const card = page.locator(`.mc-card[data-mc="${created.id}"]`);
  if ((await card.count()) !== 1) fail('thread card missing from the panel');
  const cardText = (await card.textContent().catch(() => '')) ?? '';
  if (!cardText.includes('Please cite a source')) fail('card is missing the comment body');
  if (!cardText.includes('Bravo paragraph')) fail('card is missing the anchor quote');
  console.log('badge, decoration, and panel card all render');

  // ---- Reply via the UI ----
  await card.locator('button', { hasText: 'Reply' }).click();
  await page.fill('.mc-card .mc-compose .mc-input', 'Working on it.');
  await page.click('.mc-card .mc-compose button[type="submit"]');
  await until('reply lands server-side', async () =>
    (await fetchThreads()).some((t) => t.id === created.id && t.replies.length === 1));
  await until('reply renders in the panel', async () =>
    ((await card.textContent().catch(() => '')) ?? '').includes('Working on it.'));
  console.log('reply round-trips');

  // ---- Resolve via the UI: leaves the margin, stays browsable ----
  await card.locator('button', { hasText: 'Resolve' }).click();
  await until('thread resolved server-side', async () =>
    (await fetchThreads()).every((t) => t.id !== created.id || t.resolvedAt != null));
  await until('decoration cleared after resolve', async () =>
    (await page.locator('.mc-range').count()) === 0);
  await until('badge cleared after resolve', async () =>
    (await page.locator(badgeSel).count()) === 0);
  const resolvedGroup = (await page.textContent('.mc-resolved').catch(() => '')) ?? '';
  if (!resolvedGroup.includes('Resolved (1)')) fail('resolved thread not browsable in the panel');
  console.log('resolve clears margin + badge; thread browsable under Resolved');

  // ---- Orphaning: reopen, then delete the quoted paragraph IN the editor
  // (the realistic path — the doc-change hook must catch it) ----
  await fetch(`${commentsUrl}/${created.id}/reopen`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  await until('reopen re-decorates the range', async () =>
    (await page.locator('.mc-range').count()) > 0);
  await selectParagraph('Bravo paragraph');
  await page.keyboard.press('Backspace');
  await until('orphan flag round-trips to the server', async () =>
    (await fetchThreads()).some((t) => t.id === created.id && t.orphaned));
  await until('panel shows the orphan chip', async () =>
    ((await page.textContent(`.mc-card[data-mc="${created.id}"]`).catch(() => '')) ?? '')
      .includes('Original text was removed'));
  await until('orphaned range no longer decorated', async () =>
    (await page.locator('.mc-range').count()) === 0);
  console.log('deleting the target text orphans the thread visibly');

  // ---- Select text → toolbar Comment item → composer files a new thread ----
  await selectParagraph('Alpha paragraph');
  const toolbarItem = page.locator('.milkdown-toolbar[data-show="true"] .toolbar-item').last();
  await toolbarItem.waitFor({ timeout: 4000 })
    .catch(() => fail('selection toolbar did not show the comment item'));
  await toolbarItem.click();
  await page.waitForSelector('#comments-composer:not([hidden])', { timeout: 4000 })
    .catch(() => fail('bubble did not open the composer'));
  console.log('composer quote:', await page.textContent('#comments-composer .mc-quote').catch(() => '(missing)'));
  await page.fill('#comments-composer .mc-input', 'Selection comment from the check script.');
  await page.click('#comments-composer button[type="submit"]');
  const landed = await until('selection comment lands server-side', async () =>
    (await fetchThreads()).some((t) =>
      t.body.includes('Selection comment') && t.anchor?.quote?.includes('Alpha paragraph')));
  if (!landed) {
    console.log('threads snapshot:', JSON.stringify(
      (await fetchThreads()).map((t) => ({ id: t.id, body: t.body.slice(0, 40), anchor: t.anchor })), null, 2));
  }
  await until('selection comment decorates its range', async () =>
    (await page.locator('.mc-range').count()) > 0);
  console.log('select → bubble → composer files an anchored thread');

  await page.screenshot({ path: '/tmp/kuhn-comments-check.png' });
} finally {
  await browser.close();
  // Restore state after the client disconnects (a live Yjs room would
  // otherwise sync the test edits straight back over the file).
  await clearComments();
  await putDoc(originalDoc);
}

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
