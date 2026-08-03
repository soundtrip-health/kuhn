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

// --- API: activity log + unseen flags (stories 005-002/003) ---
const findNode = async (p) => flatten((await (await fetch(api('/files'))).json()).tree).find((n) => n.path === p);
const uploadedNode = await findNode(UPLOADED);
check(uploadedNode?.unseen === true, 'uploaded file is flagged unseen in the tree');
check(typeof uploadedNode?.mtime === 'string', 'tree file nodes carry mtime');
const activity = (await (await fetch(api('/files/activity?limit=20'))).json()).events;
check(
  activity.some((e) => e.path === UPLOADED && e.kind === 'create' && e.agent_slug === null),
  'activity log records the upload as a user action',
);

// --- API: oversize upload is a readable 413, all-or-nothing (story 026) ---
const LIMIT_BYTES = 20 * 1024 * 1024; // backend default; see STORAGE_MAX_FILE_BYTES
const MIXED_OK = 'files-check-mixed-ok.txt';
try {
  const bigForm = new FormData();
  bigForm.append('files', new Blob(['small sibling'], { type: 'text/plain' }), MIXED_OK);
  bigForm.append(
    'files',
    new Blob([new Uint8Array(LIMIT_BYTES + 1024)], { type: 'application/octet-stream' }),
    'files-check-too-big.bin',
  );
  const bigRes = await fetch(api('/files/upload'), { method: 'POST', body: bigForm });
  const bigBody = await bigRes.json().catch(() => ({}));
  check(bigRes.status === 413, `oversize upload returns 413 (got ${bigRes.status})`);
  check(
    bigBody.code === 'too_large' && typeof bigBody.error === 'string' && bigBody.error.length > 0,
    'oversize upload carries a readable too_large error',
  );
  check(!(await treePaths()).includes(MIXED_OK), 'mixed batch is all-or-nothing (valid sibling did not land)');
} catch (err) {
  fail(`oversize upload probe threw instead of returning 413: ${err.message}`);
}
await fetch(fileApi(MIXED_OK), { method: 'DELETE' }).catch(() => {});

// --- Browser: click the .txt → it opens in the editor as raw text (issue #44) ---
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));

await page.goto(WEBAPP);
// The recorded active document may itself be a raw-text file (issue #44) —
// accept either editor as the booted state.
await page.waitForSelector('#editor .milkdown [contenteditable], #editor.editor-source .cm-content', { timeout: 15000 });
await page.waitForTimeout(1000);

const entry = `.file-entry[data-path="${UPLOADED}"]`;
await page.waitForSelector(entry, { timeout: 10000 }).catch(() => fail('uploaded file not listed in the panel'));
// Server-hydrated badge (story 005-003): the upload happened via the API
// before this page loaded, so the "new" badge must come from hydration.
check((await page.locator(`${entry} .file-badge`).count()) === 1, 'unseen file shows a hydrated badge');
check((await page.locator('#toggle-files .toggle-pill').count()) === 1, 'Files toggle shows the unseen-count pill');
await page.click(entry).catch(() => {});
await page
  .waitForFunction(
    (text) =>
      document.querySelector('#editor.editor-source .cm-content')?.textContent?.includes(text) ?? false,
    CONTENT,
    { timeout: 10000 },
  )
  .catch(() => fail('clicking the .txt did not open its content in the raw-text editor'));
check(
  (await page.locator('#preview-panel.collapsed').count()) === 1,
  'preview panel stays closed for a text file',
);
check(
  await page.locator('#editor-mode-toggle').evaluate((el) => el.hidden).catch(() => false),
  'rich/source mode toggle is hidden for a non-markdown file',
);
check((await page.locator(`${entry} .file-badge`).count()) === 0, 'opening the file clears its badge');

// Edits round-trip: type into the raw view, the debounced save PUTs the bytes.
const MARKER = 'files-check-edited-marker';
await page.click('#editor.editor-source .cm-content');
await page.keyboard.type(`${MARKER} `);
let persisted = false;
for (let i = 0; i < 20 && !persisted; i++) {
  await page.waitForTimeout(500);
  persisted = (await (await fetch(fileApi(UPLOADED))).text()).includes(MARKER);
}
check(persisted, 'editing the text file persists through the storage API');
await browser.close();

check((await findNode(UPLOADED))?.unseen !== true, 'seen state persisted server-side after the click');

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
