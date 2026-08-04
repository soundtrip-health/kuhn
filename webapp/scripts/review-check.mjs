// Browser check for epic 013 (external review via magic links). Token-free:
// links are minted/revoked through the member REST surface (dev mode), and
// each reviewer runs in a FRESH browser context — the actual logged-out
// reviewer experience. Needs the backend (agent-backend: npm run dev) and the
// webapp (npm run dev).
//   node scripts/review-check.mjs
//
// Verifies, per mode:
//   view    — claim screen → doc renders read-only, no composer; a crafted
//             Yjs write sent over a raw WebSocket holding the view session is
//             DROPPED server-side (asserted via a sync probe — the positive
//             control in the edit section proves the crafted bytes are valid,
//             so the drop is the gate, not a broken payload); revoking the
//             link flips the open page to the revoked overlay WITHOUT a
//             reload (4003), and the member banner clears.
//   comment — floating Comment affordance files an anchored thread
//             (attributed to the link), reply + resolve-own work through the
//             UI, the member-authored thread shows no resolve affordance and
//             direct REST resolve of it 403s; a second fresh context on the
//             claimed link gets the "already in use" screen.
//   edit    — typing autosaves through /api/review/file (bytes assert via the
//             member file route), Cmd+S checkpoints, and the version history
//             entry is external-attributed.
// Throughout: the member tab shows the server-attributed MSG_REVIEWERS banner
// (dev-mode member resolution always succeeds, so these reviewer-branch
// assertions only pass if the reviewer-cookie-wins rule works in dev), and
// every request a reviewer context makes stays inside the allowlist —
// static assets, /api/review/*, /yjs-websocket/* — plus, explicitly, the two
// Google Fonts hosts review.html links (fonts.googleapis.com/fonts.gstatic.com;
// backend endpoints stay strictly allowlisted).
import { chromium } from 'playwright';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';
const BACKEND_WS = BACKEND.replace(/^http/, 'ws');

const PATH = 'draft/main.md';
const MEMBER_QUOTE = 'Alpha paragraph anchors the member thread.';
const REVIEW_QUOTE = 'Bravo paragraph gets the reviewer comment.';
const BASE = [
  '# Review check',
  '',
  MEMBER_QUOTE,
  '',
  REVIEW_QUOTE,
  '',
  'Charlie paragraph stays untouched.',
  '',
].join('\n');
const EDIT_MARKER = 'EXTERNAL-EDIT-CHECK';

const errors = [];
const fail = (msg) => errors.push(msg);

const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const projectId = projects[0].id;
const room = `project-${projectId}/${PATH}`;
const docUrl = `${BACKEND}/api/projects/${projectId}/file?path=${encodeURIComponent(PATH)}`;
const commentsUrl = `${BACKEND}/api/projects/${projectId}/comments`;
const linksUrl = `${BACKEND}/api/projects/${projectId}/review-links`;
const originalDoc = await (await fetch(docUrl)).text();

const fetchDoc = async () => (await fetch(docUrl)).text();
// DELETE then PUT: the delete publishes a real file_change, which force-closes
// any warm Yjs room from a previous run (comments-check.mjs rationale).
const putDoc = async (content) => {
  await fetch(docUrl, { method: 'DELETE' });
  return fetch(docUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content });
};
const fetchThreads = async () =>
  (await (await fetch(`${commentsUrl}?path=${encodeURIComponent(PATH)}`)).json()).threads;

async function clearComments() {
  for (const t of await fetchThreads()) {
    await fetch(`${commentsUrl}/${t.id}`, { method: 'DELETE' });
  }
}

/** Delete the reviewer's own threads through the review API (delete-own). */
async function purgeReviewerThreads(page) {
  const cookies = await page.context().cookies(BACKEND);
  const session = cookies.find((c) => c.name === 'kuhn_review_session');
  if (!session) return;
  const headers = { Cookie: `kuhn_review_session=${session.value}` };
  const { threads } = await (await fetch(`${BACKEND}/api/review/comments`, { headers })).json();
  for (const t of threads ?? []) {
    // 403s (someone else's thread) are fine — delete-own is the point.
    await fetch(`${BACKEND}/api/review/comments/${t.id}`, { method: 'DELETE', headers });
  }
}

const revokeLink = (id) => fetch(`${linksUrl}/${id}/revoke`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});

/** Self-purge: revoke every still-live link for the doc from previous runs. */
async function purgeLinks() {
  const { links } = await (await fetch(`${linksUrl}?path=${encodeURIComponent(PATH)}`)).json();
  for (const link of links ?? []) await revokeLink(link.id);
}

async function mintLink(mode) {
  const res = await fetch(linksUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: PATH, mode }),
  });
  if (!res.ok) {
    console.error(`mint ${mode} failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { url, link } = await res.json();
  const token = url.split('/review/')[1];
  // Open via the webapp origin: in dev the minted URL carries the backend host,
  // whose static shell only exists after a build; vite serves review.html.
  return { link, reviewUrl: `${WEBAPP}/review/${token}` };
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

// ---- Crafted Yjs frames (the message-level gate probe) ----------------------

/** MSG_SYNC + messageYjsUpdate inserting `text` into Y.Text `key`. */
function craftUpdateFrame(key, text) {
  const doc = new Y.Doc();
  doc.getText(key).insert(0, text);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0); // MSG_SYNC
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return Array.from(encoding.toUint8Array(enc));
}

/** Read the server room's Y.Text `key` via a fresh sync probe. Dev mode
 *  resolves this cookie-less Node socket as the seeded member (read-only use:
 *  it sends nothing but SyncStep1). */
function probeRoomText(key) {
  return new Promise((resolvePromise, reject) => {
    const doc = new Y.Doc();
    const ws = new WebSocket(`${BACKEND_WS}/yjs-websocket/${room}`);
    ws.binaryType = 'arraybuffer';
    const finish = () => {
      try { ws.close(); } catch { /* already closed */ }
      resolvePromise(doc.getText(key).toString());
    };
    const timer = setTimeout(finish, 2000);
    ws.onopen = () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, doc);
      ws.send(encoding.toUint8Array(enc));
    };
    ws.onmessage = (ev) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data));
      if (decoding.readVarUint(dec) !== 0) return; // seed grant / reviewers / awareness
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      // Applies step2/update into `doc`; the step2 reply for the server's own
      // step1 is discarded — the probe never writes.
      syncProtocol.readSyncMessage(dec, enc, doc, null);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('probe websocket failed'));
    };
  });
}

/** From inside a reviewer page (so the httpOnly review cookie rides the
 *  upgrade), open a raw WebSocket to the doc room and send one crafted frame. */
async function sendFrameFromPage(page, bytes) {
  await page.evaluate(async ({ wsUrl, frame }) => {
    await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      const done = () => {
        try { ws.close(); } catch { /* noop */ }
        resolve(null);
      };
      ws.onopen = () => {
        ws.send(new Uint8Array(frame));
        setTimeout(done, 600);
      };
      ws.onerror = done;
      setTimeout(done, 3000);
    });
  }, { wsUrl: `${BACKEND_WS}/yjs-websocket/${room}`, frame: bytes }).catch(() => fail('raw-ws frame send failed'));
}

// ---- Reviewer contexts with hygiene collectors ------------------------------

// The zero-non-allowlisted-requests AC. Static assets come from the webapp
// origin; the ONLY backend surface a reviewer bundle may touch is
// /api/review/* (plus the doc websocket, checked separately); review.html's
// Google Fonts links are explicitly allowlisted (brief U8 — backend endpoints
// stay strict: any other ${BACKEND} URL is a failure).
const allowedRequest = (url) =>
  url.startsWith(`${WEBAPP}/`)
  || url.startsWith(`${BACKEND}/api/review/`)
  || url.startsWith('https://fonts.googleapis.com/')
  || url.startsWith('https://fonts.gstatic.com/');

const reviewerContexts = [];

async function newReviewerPage(browser, label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const record = { label, badRequests: [], badSockets: [], pageErrors: [], consoleErrors: [] };
  page.on('request', (req) => {
    const url = req.url();
    if (!allowedRequest(url) && !url.startsWith('data:')) record.badRequests.push(url);
  });
  page.on('websocket', (ws) => {
    // Doc-sync sockets only — plus vite's own HMR socket on the webapp origin.
    const url = ws.url();
    if (!url.includes('/yjs-websocket/') && !url.startsWith(`${WEBAPP.replace(/^http/, 'ws')}/`)) {
      record.badSockets.push(url);
    }
  });
  page.on('pageerror', (err) => record.pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') record.consoleErrors.push(msg.text());
  });
  reviewerContexts.push({ context, record });
  return page;
}

function settleHygiene() {
  for (const { record } of reviewerContexts) {
    for (const url of record.badRequests) {
      fail(`[${record.label}] non-allowlisted request: ${url}`);
    }
    for (const url of record.badSockets) {
      fail(`[${record.label}] non-allowlisted websocket: ${url}`);
    }
    for (const msg of record.pageErrors) {
      fail(`[${record.label}] pageerror: ${msg}`);
    }
    for (const msg of record.consoleErrors) {
      // The deliberate REST probe (resolving a member thread must 403) is the
      // one expected console error; anything else fails the check.
      if (!msg.includes('403')) fail(`[${record.label}] console error: ${msg.slice(0, 200)}`);
    }
  }
}

async function claim(page, reviewUrl, name) {
  await page.goto(reviewUrl);
  await page.waitForSelector('#rv-name-input', { timeout: 15000 });
  await page.fill('#rv-name-input', name);
  await page.click('.rv-submit');
  await page.waitForSelector('#editor .milkdown', { timeout: 15000 });
  await until(`${name}: doc content renders`, async () =>
    ((await page.textContent('#editor').catch(() => '')) ?? '').includes('Bravo paragraph'));
}

const modeBadge = async (page) => (await page.textContent('#review-mode-badge').catch(() => '')) ?? '';

async function assertReadOnly(page, label) {
  if ((await page.locator('#editor .milkdown [contenteditable="true"]').count()) > 0) {
    fail(`${label}: editor is editable`);
  }
  if ((await page.locator('#editor .milkdown [contenteditable="false"]').count()) === 0) {
    fail(`${label}: read-only editor surface missing`);
  }
}

/** DOM Selection over a paragraph (comments-check.mjs technique). */
async function selectParagraph(page, text) {
  await page.locator('#editor .milkdown p', { hasText: text }).click();
  await page.evaluate((needle) => {
    const p = [...document.querySelectorAll('#editor .milkdown p')]
      .find((el) => el.textContent?.includes(needle));
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, text);
  await page.waitForTimeout(400);
}

// ---- Fixtures ---------------------------------------------------------------

await purgeLinks();
await clearComments();
await putDoc(BASE);

const viewLink = await mintLink('view');
const commentLink = await mintLink('comment');
const editLink = await mintLink('edit');
console.log('minted links:', viewLink.link.id, commentLink.link.id, editLink.link.id);

// Member-authored fixture thread: reviewers must see it but never resolve it.
const memberThread = await (await fetch(commentsUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    path: PATH,
    body: 'Member thread — reviewers keep hands off.',
    anchor: { quote: MEMBER_QUOTE, start: BASE.indexOf(MEMBER_QUOTE), end: BASE.indexOf(MEMBER_QUOTE) + MEMBER_QUOTE.length },
  }),
})).json();

const browser = await chromium.launch();
let commentPage = null;

try {
  // ---- Member tab: seeds the room, then renders the MSG_REVIEWERS banner ----
  const memberPage = await browser.newPage();
  memberPage.on('pageerror', (err) => fail(`member pageerror: ${err.message}`));
  await memberPage.goto(WEBAPP);
  await memberPage.waitForSelector('#editor .milkdown', { timeout: 15000 });
  await until('member tab renders the doc', async () =>
    ((await memberPage.textContent('#editor').catch(() => '')) ?? '').includes('Bravo paragraph'));
  await memberPage.evaluate(() => document.getElementById('editor-hero')?.remove());

  // ---- VIEW ----------------------------------------------------------------
  const viewPage = await newReviewerPage(browser, 'view');
  await claim(viewPage, viewLink.reviewUrl, 'Vera View');
  if (!(await modeBadge(viewPage)).includes('view only')) fail('view: mode badge missing');
  await assertReadOnly(viewPage, 'view');
  if (!(await viewPage.locator('#comments-composer[hidden]').count())) {
    fail('view: comment composer is available');
  }
  console.log('view: claimed, renders read-only');

  // Server-attributed presence on the member tab — this banner comes from
  // MSG_REVIEWERS(65), which only fires for reviewer-classified sockets, so it
  // doubles as the dev-mode proof that the reviewer branch actually engaged.
  await until('member banner shows the view reviewer', async () =>
    ((await memberPage.textContent('#reviewer-banner').catch(() => '')) ?? '')
      .includes('Vera View (view)'));
  console.log('member tab: MSG_REVIEWERS banner names Vera View');

  // Message-level gate: a crafted update over a raw socket holding the VIEW
  // session must be dropped server-side (positive control in the edit section).
  await sendFrameFromPage(viewPage, craftUpdateFrame('kuhn-gate-probe-view', 'VIEW-WRITE-MUST-DROP'));
  const afterViewInjection = await probeRoomText('kuhn-gate-probe-view');
  if (afterViewInjection !== '') {
    fail(`view: crafted write reached the room ('${afterViewInjection}')`);
  } else {
    console.log('view: crafted write dropped server-side');
  }

  // Revoke while the page is open: the overlay must appear WITHOUT a reload.
  await viewPage.evaluate(() => { window.__kuhnNoReload = true; });
  await revokeLink(viewLink.link.id);
  await viewPage.waitForSelector('.rv-card[data-kind="revoked"]', { timeout: 10000 })
    .catch(() => fail('view: revoked overlay did not appear'));
  if (!(await viewPage.evaluate(() => window.__kuhnNoReload === true))) {
    fail('view: revoked overlay only appeared after a reload');
  }
  await until('member banner drops the revoked reviewer', async () =>
    !(((await memberPage.textContent('#reviewer-banner').catch(() => '')) ?? '')
      .includes('Vera View')), 8000);
  console.log('view: revoke → 4003 overlay in place, banner cleared');

  // ---- COMMENT -------------------------------------------------------------
  commentPage = await newReviewerPage(browser, 'comment');
  await claim(commentPage, commentLink.reviewUrl, 'Carl Comment');
  if (!(await modeBadge(commentPage)).includes('can comment')) fail('comment: mode badge missing');
  await assertReadOnly(commentPage, 'comment');
  await commentPage.waitForSelector('#comments-panel:not(.collapsed)', { timeout: 8000 })
    .catch(() => fail('comment: panel did not auto-open'));

  // The member thread renders but offers no resolve affordance…
  const memberCard = commentPage.locator(`.mc-card[data-mc="${memberThread.id}"]`);
  await memberCard.waitFor({ timeout: 8000 }).catch(() => fail('comment: member thread card missing'));
  if ((await memberCard.locator('button', { hasText: 'Resolve' }).count()) > 0) {
    fail('comment: member thread shows a Resolve affordance');
  }
  // …and resolving it straight through REST refuses (own-threads-only rule).
  const probeStatus = await commentPage.evaluate(async ({ backend, id }) => {
    const res = await fetch(`${backend}/api/review/comments/${id}/resolve`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return res.status;
  }, { backend: BACKEND, id: memberThread.id });
  if (probeStatus !== 403) fail(`comment: REST resolve of member thread returned ${probeStatus}, expected 403`);
  console.log('comment: member thread untouchable (no affordance; REST 403)');

  // Floating Comment affordance files an anchored thread attributed to the link.
  await selectParagraph(commentPage, 'Bravo paragraph');
  await commentPage.waitForSelector('.rv-float-comment:not([hidden])', { timeout: 6000 })
    .catch(() => fail('comment: floating Comment button did not appear'));
  await commentPage.click('.rv-float-comment');
  await commentPage.waitForSelector('#comments-composer:not([hidden])', { timeout: 4000 })
    .catch(() => fail('comment: composer did not open'));
  await commentPage.fill('#comments-composer .mc-input', 'Reviewer thread from the check script.');
  await commentPage.click('#comments-composer button[type="submit"]');
  let ownThread = null;
  await until('reviewer thread lands with link attribution', async () => {
    ownThread = (await fetchThreads()).find((t) =>
      t.reviewLinkId === commentLink.link.id && t.body.includes('Reviewer thread'));
    return ownThread != null && ownThread.reviewerName === 'Carl Comment'
      && ownThread.anchor?.quote?.includes('Bravo paragraph');
  });

  if (ownThread) {
    const ownCard = commentPage.locator(`.mc-card[data-mc="${ownThread.id}"]`);
    await ownCard.waitFor({ timeout: 8000 }).catch(() => fail('comment: own card missing'));
    await ownCard.locator('button', { hasText: 'Reply' }).click();
    await commentPage.fill(`.mc-card[data-mc="${ownThread.id}"] .mc-compose .mc-input`, 'Reviewer reply.');
    await commentPage.click(`.mc-card[data-mc="${ownThread.id}"] .mc-compose button[type="submit"]`);
    await until('reply lands server-side', async () =>
      (await fetchThreads()).some((t) => t.id === ownThread.id && t.replies.length === 1));
    await ownCard.locator('button', { hasText: 'Resolve' }).click();
    await until('own thread resolved server-side', async () =>
      (await fetchThreads()).some((t) => t.id === ownThread.id && t.resolvedAt != null));
    console.log('comment: own thread created, replied, resolved');
  }

  // Second fresh context on the claimed link → the "already in use" screen.
  const secondPage = await newReviewerPage(browser, 'second-claim');
  await secondPage.goto(commentLink.reviewUrl);
  await secondPage.waitForSelector('.rv-card[data-kind="claimed"]', { timeout: 10000 })
    .catch(() => fail('claimed link did not show the already-in-use screen'));
  console.log('claimed link: second context refused');

  // ---- EDIT ----------------------------------------------------------------
  const editPage = await newReviewerPage(browser, 'edit');
  await claim(editPage, editLink.reviewUrl, 'Edna Edit');
  if (!(await modeBadge(editPage)).includes('can edit')) fail('edit: mode badge missing');
  if ((await editPage.locator('#editor .milkdown [contenteditable="true"]').count()) === 0) {
    fail('edit: editor is not editable');
  }
  await editPage.click('#editor .milkdown [contenteditable]');
  await editPage.keyboard.press('End');
  await editPage.keyboard.type(` ${EDIT_MARKER}`);
  await editPage.keyboard.press('ControlOrMeta+s'); // checkpoint save
  await until('reviewer edit reaches storage', async () =>
    (await fetchDoc()).includes(EDIT_MARKER));
  await until('history entry is external-attributed', async () => {
    const { history } = await (await fetch(`${BACKEND}/api/projects/${projectId}/history`)).json();
    return (history ?? []).some((e) =>
      e.external === true && e.reviewerLinkId === editLink.link.id
      && String(e.authorName).includes('Edna Edit'));
  });
  console.log('edit: typing persisted via /api/review/file; history external-attributed');

  // Positive control for the view-mode drop: the same crafted-frame technique
  // over the EDIT session must land, proving the payload (and the probe) work.
  await sendFrameFromPage(editPage, craftUpdateFrame('kuhn-gate-probe-edit', 'EDIT-WRITE-APPLIES'));
  const afterEditInjection = await probeRoomText('kuhn-gate-probe-edit');
  if (afterEditInjection !== 'EDIT-WRITE-APPLIES') {
    fail(`edit: crafted-frame positive control failed ('${afterEditInjection}')`);
  } else {
    console.log('edit: crafted write applies (view-mode drop is the gate, not a dud payload)');
  }

  await editPage.screenshot({ path: '/tmp/kuhn-review-check.png' });
  settleHygiene();
} finally {
  // Reviewer-authored threads can only be deleted through the reviewer's own
  // session (the member DELETE is delete-own, and identities never cross the
  // wall) — purge them via the comment context's live cookie BEFORE closing
  // the browser and revoking the link, both of which kill that session.
  if (commentPage) await purgeReviewerThreads(commentPage).catch(() => {});
  await browser.close();
  // Self-purge (repeated runs stay readable): dead links, test threads, and
  // the original bytes back — after clients disconnect so no warm room
  // re-syncs test edits over the restore.
  await revokeLink(commentLink.link.id).catch(() => {});
  await revokeLink(editLink.link.id).catch(() => {});
  await clearComments();
  await putDoc(originalDoc);
}

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
