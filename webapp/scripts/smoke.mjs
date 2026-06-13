// Browser smoke test for the story 013 scaffold. Requires the backend
// (agent-backend: npm run dev) and the webapp (npm run dev) to be running.
//   node scripts/smoke.mjs
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  // A 404 for draft/main.md on first load is the legitimate "new project" path
  if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(`console: ${msg.text()}`);
});

await page.goto(WEBAPP);
await page.waitForSelector('#editor .milkdown', { timeout: 15000 });
await page.waitForTimeout(1500);

const projectName = await page.textContent('#breadcrumb .breadcrumb-project');
console.log('project:', projectName);
console.log('status-doc:', await page.textContent('#status-doc'));
console.log('editor heading:', await page.textContent('#editor h1').catch(() => '(none)'));
console.log('file tree entries:', await page.locator('#file-tree .file-entry, #file-tree summary').allTextContents());

// Type into the editor and wait for the debounced save
await page.click('#editor .milkdown [contenteditable]');
await page.keyboard.press('End');
await page.keyboard.type(' E2E-MARKER');
// Verify the debounced save persists through the storage API (poll: the
// debounce is 1.5s and a prior template save may report 'saved' first)
const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const docUrl = `${BACKEND}/api/projects/${projects[0].id}/file?path=${encodeURIComponent('draft/main.md')}`;
let persisted = false;
for (let i = 0; i < 30 && !persisted; i++) {
  await new Promise((ok) => setTimeout(ok, 500));
  persisted = (await (await fetch(docUrl)).text()).includes('E2E-MARKER');
}
console.log('persisted marker:', persisted);
if (!persisted) errors.push('debounced save never persisted E2E-MARKER');

// Panel toggles
await page.click('#toggle-chat');
console.log('chat collapsed:', (await page.locator('#chat-panel.collapsed').count()) === 1);
await page.click('#toggle-chat');

await page.screenshot({ path: '/tmp/kuhn-webapp.png' });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
