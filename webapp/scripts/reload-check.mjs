// Story 024: reloading against a warm Yjs room must not throw (the collab
// plugin used to dispatch into an editor whose ctx lacked `editorState`),
// and content typed immediately before reload must survive. Needs only the
// backend and webapp dev servers — no LLM tokens.
//   node scripts/reload-check.mjs
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';
const SENTINEL = 'RELOAD-SURVIVAL-CHECK';

const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const projectId = projects[0].id;
const docUrl = `${BACKEND}/api/projects/${projectId}/file?path=${encodeURIComponent('draft/main.md')}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
});

await page.goto(WEBAPP);
await page.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
await page.waitForTimeout(1500);

// Type a sentinel and reload before the debounced save (1.5s) can fire —
// survival must come from the warm Yjs room or the unload flush, not luck.
await page.click('#editor .milkdown [contenteditable]');
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
await page.keyboard.type(SENTINEL);
await page.reload();
await page.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
await page.waitForTimeout(2000);

const survived = (await page.textContent('#editor .milkdown')).includes(SENTINEL);
console.log('content survived reload:', survived);
if (!survived) errors.push('content typed before reload was lost');

// Reload a few more times against the now-definitely-warm room.
for (let i = 0; i < 3; i++) {
  await page.reload();
  await page.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
  await page.waitForTimeout(1500);
}

console.log('errors:', errors.length ? errors : 'none');
await browser.close();

// Strip the sentinel after the browser closes — a connected client would
// sync the old Yjs room state right back over the file.
const finalDoc = await (await fetch(docUrl)).text();
const cleaned = finalDoc
  .split('\n')
  .filter((line) => !line.includes(SENTINEL))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n');
if (cleaned !== finalDoc && cleaned.trim().length > 0) {
  await fetch(docUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: cleaned });
}

if (errors.length) process.exit(1);
