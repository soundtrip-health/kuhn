// Crepe editor check (epic 004, stories 001/003): on a fresh, un-polluted
// document the Crepe shell renders, the unified block-edit slash menu shows
// Crepe's block groups AND the Kuhn "AI commands" group, and typing `/cite`
// filters down to the Cite agent command. Requires the backend (:3002) and the
// webapp dev server (:5174) running.
//   node scripts/editor-check.mjs
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exitCode = 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(`console: ${m.text()}`);
});

// Loads the default project's draft/main.md (a disposable test fixture the
// smoke/collab checks already mutate). We clear it to a clean block so the menu
// shows — Crepe only opens it when the block text is exactly "/...".
await page.goto(WEBAPP);
await page.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
await page.waitForTimeout(1500);

await page.click('#editor .milkdown [contenteditable]');
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
await page.keyboard.type('/');
await page.waitForTimeout(500);

if ((await page.getAttribute('.milkdown-slash-menu', 'data-show')) !== 'true')
  fail('slash menu did not show on "/"');

const items = await page.evaluate(() =>
  [...document.querySelectorAll('.milkdown-slash-menu')].map((m) => m.textContent ?? '').join(' '));
for (const expected of ['Heading 1', 'Table', 'AI commands', 'Cite', 'Write'])
  if (!items.includes(expected)) fail(`menu missing "${expected}"`);
console.log('slash menu shows Crepe blocks + AI commands group');

// Filter to the agent command.
await page.keyboard.type('cite');
await page.waitForTimeout(400);
const filtered = await page.textContent('.milkdown-slash-menu');
if (!/Cite/.test(filtered ?? '') || /Heading 1/.test(filtered ?? ''))
  fail('"/cite" did not filter down to the Cite command');
else console.log('"/cite" filters to the Cite agent command');

if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
else console.log('no page errors');

await browser.close();
console.log(process.exitCode ? 'editor-check: FAILED' : 'editor-check: OK');
