// Token-free browser check for the Canopy-R01 duplication fix: a tab that
// was away while its collab room was rebuilt and re-seeded by someone else
// must RELOAD the document on reconnect, not merge its stale Yjs history
// (which concatenated two copies). Also checks that rich-mode autosaves keep
// the document's front matter (body-only writes, server re-attach).
//
// Self-contained: starts an isolated backend + vite pair on its own ports
// and data dir, so it never touches the :3002 deployment.
//
//   node scripts/stale-room-check.mjs
//
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const BACKEND_PORT = Number(process.env.STALE_BACKEND_PORT ?? 3198);
const VITE_PORT = Number(process.env.STALE_VITE_PORT ?? 5197);
const BACKEND = `http://localhost:${BACKEND_PORT}`;
const WEBAPP = `http://localhost:${VITE_PORT}`;
const REPO = resolve(new URL('../..', import.meta.url).pathname);
const DATA_DIR = process.env.STALE_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'kuhn-stale-'));
const CHROME = process.env.CHROME_PATH
  ?? join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');

const FRONT_MATTER = '---\ntemplate: nih-grant\npage_limits:\n  Specific Aims: 1\n---\n';
const MARKER = `STALE-ROOM-MARKER-${Date.now()}`;
const BODY = `# Specific Aims ${MARKER}\n\nFirst paragraph of the aims.\n\nSecond paragraph, with detail.\n`;

let backend = null;
let vite = null;
const children = new Set();

function startBackend() {
  const child = spawn('node', ['src/index.js'], {
    cwd: join(REPO, 'agent-backend'),
    env: {
      ...process.env,
      PORT: String(BACKEND_PORT),
      KUHN_AUTH_MODE: 'dev',
      KUHN_DATA_DIR: DATA_DIR,
      CORS_ORIGIN: WEBAPP,
      KUHN_WEBAPP_DIST: '',
      KUHN_LOG_LEVEL: process.env.KUHN_LOG_LEVEL ?? 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(`[backend] ${d}`); });
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

async function waitFor(fn, { timeout = 20000, every = 250, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

const healthy = () => fetch(`${BACKEND}/health`).then((r) => r.ok).catch(() => false);

async function stopBackend() {
  if (!backend) return;
  const child = backend;
  backend = null;
  await new Promise((done) => {
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  });
  await waitFor(async () => !(await healthy()), { label: 'backend to stop', timeout: 10000 });
}

async function restartBackend() {
  await stopBackend();
  backend = startBackend();
  await waitFor(healthy, { label: 'backend restart' });
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const countIn = (text, needle) => text.split(needle).length - 1;

async function main() {
  backend = startBackend();
  await waitFor(healthy, { label: 'backend' });
  vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
    cwd: join(REPO, 'webapp'),
    env: { ...process.env, VITE_BACKEND_URL: BACKEND },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(vite);
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await waitFor(() => fetch(WEBAPP).then((r) => r.ok).catch(() => false), { label: 'vite' });

  // Fixture: a project with one document that carries front matter.
  const created = await fetch(`${BACKEND}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `stale-room-${Date.now()}` }),
  });
  if (!created.ok) throw new Error(`create project: ${created.status} ${await created.text()}`);
  const project = (await created.json()).project ?? (await created.json());
  const projectId = project.id ?? project.project?.id;
  const path = `draft/aims-${Date.now()}.md`;
  const fileUrl = `${BACKEND}/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`;
  await fetch(fileUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: FRONT_MATTER + BODY });
  await fetch(`${BACKEND}/api/projects/${projectId}/active-document`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  });
  const storedText = async () => (await fetch(fileUrl)).text();

  const browser = await chromium.launch({ executablePath: CHROME });
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  const logsA = [];
  pageA.on('console', (m) => logsA.push(m.text()));
  await pageA.goto(WEBAPP);
  const editorSel = '#editor .milkdown [contenteditable]';
  await pageA.waitForSelector(editorSel, { timeout: 20000 });
  await pageA.waitForFunction((m) => document.querySelector('#editor')?.textContent?.includes(m), MARKER, { timeout: 15000 });
  const textA0 = await pageA.evaluate(() => document.querySelector('#editor')?.textContent ?? '');
  check('tab A shows the document once', countIn(textA0, MARKER) === 1, `${countIn(textA0, MARKER)} copies`);
  check('tab A hides the front matter', !textA0.includes('nih-grant'));

  // Tab A goes away (frozen laptop) while the room is torn down by a backend
  // restart and REBUILT + re-seeded from storage by a second opener (tab B).
  await ctxA.setOffline(true);
  await restartBackend();
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(WEBAPP);
  await pageB.waitForSelector(editorSel, { timeout: 20000 });
  await pageB.waitForFunction((m) => document.querySelector('#editor')?.textContent?.includes(m), MARKER, { timeout: 15000 });
  await pageB.waitForTimeout(1500); // B is the seeder of the new room; let it settle

  // A comes back: it must notice the new room generation and reload, never
  // merge. Pre-fix this produced two copies of the whole document in both tabs.
  await ctxA.setOffline(false);
  await pageA.waitForFunction(() => document.querySelector('#editor .milkdown [contenteditable]') != null, null, { timeout: 20000 });
  const sawNotice = await waitFor(() => logsA.some((l) => l.includes('[collab] room rebuilt')), { label: 'tab A stale-room notice', timeout: 20000 })
    .catch(() => false);
  await pageA.waitForFunction((m) => document.querySelector('#editor')?.textContent?.includes(m), MARKER, { timeout: 20000 });
  await pageA.waitForTimeout(2500); // any (wrong) merge would have landed by now
  const textA1 = await pageA.evaluate(() => document.querySelector('#editor')?.textContent ?? '');
  const textB1 = await pageB.evaluate(() => document.querySelector('#editor')?.textContent ?? '');
  check('tab A logged the stale-room reopen', sawNotice === true);
  check('tab A still shows the document once after reconnect', countIn(textA1, MARKER) === 1, `${countIn(textA1, MARKER)} copies`);
  check('tab B still shows the document once', countIn(textB1, MARKER) === 1, `${countIn(textB1, MARKER)} copies`);
  check('stored file has one copy', countIn(await storedText(), MARKER) === 1);

  // Rich-mode autosave keeps the front matter (body-only write + server re-attach).
  await pageB.click(editorSel);
  await pageB.keyboard.press('Control+End');
  await pageB.keyboard.press('End');
  const typed = ` TYPED-${Date.now()}`;
  await pageB.keyboard.type(typed);
  const saved = await waitFor(async () => {
    const t = await storedText();
    return t.includes(typed.trim()) ? t : null;
  }, { label: 'autosave with typed text', timeout: 20000 });
  check('autosave kept the front matter', saved.startsWith(FRONT_MATTER), saved.slice(0, 80).replace(/\n/g, '\\n'));
  check('autosave wrote one copy', countIn(saved, MARKER) === 1);
  check('autosave carried the typed text', saved.includes(typed.trim()));
  await pageA.waitForFunction((t) => document.querySelector('#editor')?.textContent?.includes(t), typed.trim(), { timeout: 10000 })
    .then(() => check('tab A received tab B\'s edit through the rebuilt room', true))
    .catch(() => check('tab A received tab B\'s edit through the rebuilt room', false));

  await browser.close();
}

try {
  await main();
} catch (err) {
  failures += 1;
  console.error('FAIL', err);
} finally {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }
  setTimeout(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }, 2000).unref();
}
console.log(failures === 0 ? 'stale-room-check: all checks passed' : `stale-room-check: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
