// Story 014: file-manager checks. API side (the path the UI uses): multipart
// upload, tree listing, raw content, rename via move, delete. Browser side: the
// uploaded file previews in the pane on click. Needs the backend + webapp dev
// servers — no LLM tokens.
//   node scripts/files-check.mjs
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
const fileApi = (path) => api(`/file?path=${encodeURIComponent(path)}`);

const UPLOADED = 'files-check-upload.txt';
const RENAMED = 'files-check-renamed.txt';
const CONTENT = `files-check content ${'x'.repeat(40)}`;

const flatten = (nodes) =>
  nodes.flatMap((n) => (n.type === 'dir' ? flatten(n.children ?? []) : [n]));
const treePaths = async () => flatten((await (await fetch(api('/files'))).json()).tree).map((n) => n.path);

// Clean up any leftovers from a prior run.
for (const p of [UPLOADED, RENAMED]) await fetch(fileApi(p), { method: 'DELETE' }).catch(() => {});

// --- API: multipart upload (one batch request, like uploadFiles) ---
const form = new FormData();
form.append('files', new Blob([CONTENT], { type: 'text/plain' }), UPLOADED);
const upRes = await fetch(api('/files/upload'), { method: 'POST', body: form });
check(upRes.status === 201, `upload returns 201 (got ${upRes.status})`);

check((await treePaths()).includes(UPLOADED), 'uploaded file appears in the tree');

const stored = await (await fetch(fileApi(UPLOADED))).text();
check(stored === CONTENT, 'stored content matches the uploaded bytes');

// --- Browser: click the file → it previews in the pane ---
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));

await page.goto(WEBAPP);
await page.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
await page.waitForTimeout(1000);

const entry = `.file-entry[data-path="${UPLOADED}"]`;
await page.waitForSelector(entry, { timeout: 10000 }).catch(() => fail('uploaded file not listed in the panel'));
await page.click(entry).catch(() => {});
await page
  .waitForFunction(
    (text) => document.querySelector('#preview-alt .preview-text')?.textContent?.includes(text) ?? false,
    CONTENT,
    { timeout: 10000 },
  )
  .catch(() => fail('clicking the file did not show its content in the preview pane'));
check(
  (await page.locator('#preview-panel:not(.collapsed)').count()) === 1,
  'preview panel opens when a file is previewed',
);
await browser.close();

// --- API: rename via move ---
const mvRes = await fetch(api('/files/move'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: UPLOADED, to: RENAMED }),
});
check(mvRes.status === 200, `rename returns 200 (got ${mvRes.status})`);
const afterRename = await treePaths();
check(afterRename.includes(RENAMED) && !afterRename.includes(UPLOADED), 'rename is reflected in the tree');

// --- API: rename onto an existing path is a readable 409 ---
await fetch(api('/files/upload'), {
  method: 'POST',
  body: (() => {
    const f = new FormData();
    f.append('files', new Blob(['conflict probe'], { type: 'text/plain' }), UPLOADED);
    return f;
  })(),
});
const conflictRes = await fetch(api('/files/move'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: UPLOADED, to: RENAMED }),
});
const conflictBody = await conflictRes.json();
check(conflictRes.status === 409, `rename onto an existing path is 409 (got ${conflictRes.status})`);
check(typeof conflictBody.error === 'string' && conflictBody.error.length > 0, 'conflict carries a readable error');

// --- API: delete (clean up both) ---
const delRes = await fetch(fileApi(RENAMED), { method: 'DELETE' });
check(delRes.status === 200, `delete returns 200 (got ${delRes.status})`);
await fetch(fileApi(UPLOADED), { method: 'DELETE' }).catch(() => {});
const afterDelete = await treePaths();
check(!afterDelete.includes(RENAMED) && !afterDelete.includes(UPLOADED), 'deleted files are gone from the tree');

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
