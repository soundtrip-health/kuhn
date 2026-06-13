// Browser check for story 017: /write slash command → streamed suggestion
// block → accept/reject. The agent task stream is intercepted with a canned
// SSE response (the suggestion echoes the typed instruction), so this needs no
// LLM tokens and no live writer — only the backend (agent-backend: npm run dev)
// and the webapp (npm run dev). A live SDK run is deferred to story 022.
//   node scripts/write-check.mjs
//
// Verifies: the block streams, the document stays unchanged while a suggestion
// is pending (it lives in a widget decoration, not the doc), Accept inserts +
// persists + survives reload, Reject leaves no trace, and no file_change ever
// reaches the editor for a /write task.
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const ACCEPT_TOKEN = 'alpha-accept-7f3';
const REJECT_TOKEN = 'beta-reject-9k2';
const ERROR_TOKEN = 'gamma-error-4m8';
const draft = (token) => `Drafted passage for ${token}.`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const fail = (msg) => errors.push(msg);
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));

// Stub the agent task SSE stream: echo the instruction back as a one-paragraph
// suggestion, then a done event. No file_change is ever emitted (the /write
// contract — compose mode withholds file tools server-side).
await page.route('**/api/agent/task', (route) => {
  let instruction = 'unknown';
  try {
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (!body.compose) fail('agent task was not dispatched in compose mode');
    instruction = (body.input ?? '').split('\n')[0].trim() || 'unknown';
  } catch {
    fail('could not parse the agent task request body');
  }
  let frames;
  if (instruction.includes(ERROR_TOKEN)) {
    frames = [{ type: 'error', agent: 'writer', message: 'Stubbed writer failure.' }];
  } else {
    const token = instruction.includes(ACCEPT_TOKEN) ? ACCEPT_TOKEN : REJECT_TOKEN;
    const text = draft(token);
    frames = [
      { type: 'text_delta', agent: 'writer', content: text.slice(0, 8) },
      { type: 'text_delta', agent: 'writer', content: text.slice(8) },
      { type: 'text', agent: 'writer', content: text },
      { type: 'done', agent: 'writer', sessionId: 'sess-stub', usage: { inputTokens: 12, outputTokens: 6 } },
    ];
  }
  const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
  route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
});

const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const projectId = projects[0].id;
const docUrl = `${BACKEND}/api/projects/${projectId}/file?path=${encodeURIComponent('draft/main.md')}`;
const originalDoc = await (await fetch(docUrl)).text();

// The empty-state hero is not under test here; remove it so its opaque overlay
// can't intercept clicks (a warm/stale Yjs room can leave it up even when the
// doc has content — the story-024 collab race). updateDocMeta guards on the
// element existing, so removal is safe. Re-run after every (re)load.
const killHero = () => page.evaluate(() => document.getElementById('editor-hero')?.remove());

const fetchDoc = async () => (await fetch(docUrl)).text();
const restoreDoc = async () =>
  fetch(docUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: originalDoc });

// Open a /write block and dispatch an instruction; returns once it has streamed.
async function openWrite(instruction) {
  // Crepe's slash menu (story 003, Notion-style) only opens when the block text
  // starts with "/", so position on a guaranteed-empty block: clear the doc to a
  // single empty paragraph first. (The old slash.ts matched "/" after any
  // whitespace mid-block; Crepe does not.)
  await page.click('#editor .milkdown .ProseMirror');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  await page.keyboard.type('/write');
  // Crepe's unified block-edit menu (story 003) filters down to the Write agent
  // command; the highlighted item runs on Enter.
  await page.waitForSelector('.milkdown-slash-menu[data-show="true"]', { timeout: 5000 })
    .catch(() => fail('slash menu did not open on "/write"'));
  await page.waitForTimeout(300);
  const menuText = await page.textContent('.milkdown-slash-menu').catch(() => null);
  if (!/Write/.test(menuText ?? '')) fail(`expected Write in the filtered menu, got ${menuText}`);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.write-suggestion .ws-input', { timeout: 5000 })
    .catch(() => fail('suggestion block did not open with an instruction input'));
  await page.fill('.write-suggestion .ws-input', instruction);
  await page.press('.write-suggestion .ws-input', 'Enter');
}

try {
  await page.goto(WEBAPP);
  await page.waitForSelector('#editor .milkdown', { timeout: 15000 });
  await page.waitForTimeout(1500);

  // /write is a steady-state interaction over a non-empty document.
  await killHero();
  await page.click('#editor .milkdown .ProseMirror');
  await page.keyboard.type('Intro paragraph for the write check.\n');

  // ---- Accept flow ----
  await openWrite(ACCEPT_TOKEN);
  await page.waitForSelector('.write-suggestion[data-phase="done"]', { timeout: 8000 })
    .catch(() => fail('suggestion did not reach the done/action phase'));
  const streamed = await page.textContent('.write-suggestion .ws-text');
  if (!streamed?.includes(draft(ACCEPT_TOKEN))) fail(`streamed text missing: got "${streamed}"`);
  console.log('streamed suggestion:', streamed?.trim());

  // Document unchanged while the suggestion is pending (it's a widget, not doc).
  await page.waitForTimeout(1800); // outlast the save debounce
  const midDoc = await fetchDoc();
  if (midDoc.includes(draft(ACCEPT_TOKEN))) fail('pending suggestion leaked into the saved document');
  console.log('doc clean while pending:', !midDoc.includes(draft(ACCEPT_TOKEN)));

  // Accept → inserts, toast, persists.
  await page.click('.write-suggestion .ws-accept');
  await page.waitForSelector('.toast', { timeout: 4000 }).catch(() => fail('no "Suggestion accepted" toast'));
  if ((await page.locator('.write-suggestion').count()) !== 0) fail('block lingered after Accept');
  const inserted = await page.textContent('#editor .milkdown');
  if (!inserted?.includes(draft(ACCEPT_TOKEN))) fail('accepted text not in the editor');

  let saved = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    saved = await fetchDoc();
    if (saved.includes(draft(ACCEPT_TOKEN))) break;
  }
  if (!saved.includes(draft(ACCEPT_TOKEN))) fail('accepted suggestion was not persisted');
  console.log('accept persisted:', saved.includes(draft(ACCEPT_TOKEN)));

  // Survives reload.
  await page.reload();
  await page.waitForSelector('#editor .milkdown', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await killHero();
  const afterReload = await page.textContent('#editor .milkdown');
  if (!afterReload?.includes(draft(ACCEPT_TOKEN))) fail('accepted suggestion did not survive reload');
  console.log('survives reload:', afterReload?.includes(draft(ACCEPT_TOKEN)));

  // ---- Reject flow ----
  await openWrite(REJECT_TOKEN);
  await page.waitForSelector('.write-suggestion[data-phase="done"]', { timeout: 8000 })
    .catch(() => fail('reject-run suggestion did not stream'));
  await page.click('.write-suggestion .ws-reject');
  if ((await page.locator('.write-suggestion').count()) !== 0) fail('block lingered after Reject');
  await page.waitForTimeout(1800);
  const afterReject = await fetchDoc();
  if (afterReject.includes(REJECT_TOKEN)) fail('rejected suggestion left a trace in the document');
  console.log('reject left no trace:', !afterReject.includes(REJECT_TOKEN));

  // ---- Esc mid-flow aborts and leaves no trace ----
  await openWrite(REJECT_TOKEN);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if ((await page.locator('.write-suggestion').count()) !== 0) fail('Escape did not remove the block');
  console.log('esc removed block:', (await page.locator('.write-suggestion').count()) === 0);

  // ---- Error renders in-block with Retry; Retry reuses the instruction ----
  await openWrite(ERROR_TOKEN);
  await page.waitForSelector('.write-suggestion[data-phase="error"]', { timeout: 8000 })
    .catch(() => fail('error event did not render the error phase'));
  if (!(await page.isVisible('.write-suggestion .ws-retry'))) fail('error phase has no Retry control');
  // Retry re-dispatches the same instruction → back to the error phase.
  await page.click('.write-suggestion .ws-retry');
  await page.waitForSelector('.write-suggestion[data-phase="error"]', { timeout: 8000 })
    .catch(() => fail('Retry did not re-run the task'));
  console.log('error + retry:', await page.textContent('.write-suggestion .ws-error-msg'));
  await page.click('.write-suggestion .ws-dismiss');
  if ((await page.locator('.write-suggestion').count()) !== 0) fail('Dismiss did not remove the error block');

  await page.screenshot({ path: '/tmp/kuhn-write-check.png' });
} finally {
  await browser.close();
  // Restore the original document after the client disconnects (a live Yjs room
  // would otherwise sync the test edits straight back over the file).
  await restoreDoc();
}

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
