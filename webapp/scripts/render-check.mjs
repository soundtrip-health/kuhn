// Story 019: render & export checks. API side: markdown → PDF (magic bytes,
// cache header), docx/tex exports, readable compile errors. Browser side:
// Preview button renders into the iframe, export buttons download. Needs the
// backend + webapp dev servers and Docker (typst + pandoc images) — no LLM
// tokens.
//   node scripts/render-check.mjs
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, label) => {
  console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`);
  if (!cond) fail(label);
};

const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const projectId = projects[0].id;
const api = (p) => `${BACKEND}/api/projects/${projectId}${p}`;

// --- API: render to PDF ---
const renderRes = await fetch(api('/render'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: 'draft/main.md' }),
});
const pdf = Buffer.from(await renderRes.arrayBuffer());
check(renderRes.status === 200, `render returns 200 (got ${renderRes.status})`);
check(pdf.subarray(0, 5).toString() === '%PDF-', 'render output has PDF magic bytes');

const cachedRes = await fetch(api('/render'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: 'draft/main.md' }),
});
await cachedRes.arrayBuffer();
check(cachedRes.headers.get('x-render-cache') === 'hit', 'unchanged content is a cache hit');

// --- API: exports ---
const docxRes = await fetch(api('/export?path=draft%2Fmain.md&format=docx'));
const docx = Buffer.from(await docxRes.arrayBuffer());
check(docx.subarray(0, 2).toString() === 'PK', 'docx export is a zip container');
check(
  (docxRes.headers.get('content-disposition') ?? '').includes('main.docx'),
  'docx export downloads as main.docx',
);

const texRes = await fetch(api('/export?path=draft%2Fmain.md&format=tex'));
const tex = await texRes.text();
check(tex.includes('\\documentclass'), 'tex export contains \\documentclass');

// --- API: readable errors ---
const brokenPath = 'draft/.render-check-broken.md';
await fetch(api(`/file?path=${encodeURIComponent(brokenPath)}`), {
  method: 'PUT',
  headers: { 'Content-Type': 'text/plain' },
  body: '# Broken\n\n```{=typst}\n#assert(false, message: "render-check-failure")\n```\n',
});
const brokenRes = await fetch(api('/render'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: brokenPath }),
});
const brokenBody = await brokenRes.json();
check(brokenRes.status === 422, `compile failure returns 422 (got ${brokenRes.status})`);
check(brokenBody.error?.includes('render-check-failure'), 'compile error carries the stderr excerpt');
await fetch(api(`/file?path=${encodeURIComponent(brokenPath)}`), { method: 'DELETE' });

const missingRes = await fetch(api('/render'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: 'draft/no-such-file.md' }),
});
check(missingRes.status === 404, `missing source returns 404 (got ${missingRes.status})`);

// --- Browser: preview pane + export download ---
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));

await page.goto(WEBAPP);
await page.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
await page.waitForTimeout(1500);

await page.click('#toggle-preview');
check(
  await page.locator('#preview-panel:not(.collapsed)').count() === 1,
  'preview panel opens on toggle',
);
await page.waitForFunction(
  () => (document.getElementById('preview-frame'))?.src?.startsWith('blob:'),
  { timeout: 60000 },
).catch(() => fail('preview iframe did not receive a rendered PDF'));
const statusText = await page.textContent('#preview-status');
check(statusText?.includes('draft/main.md') ?? false, `preview status shows the document (got "${statusText}")`);

const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
// Export buttons live in the top-bar Export dropdown (story 025) — open it first.
await page.click('#export-menu-btn');
await page.click('#export-docx');
const download = await downloadPromise;
check(download?.suggestedFilename() === 'main.docx', 'export button downloads main.docx');

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
