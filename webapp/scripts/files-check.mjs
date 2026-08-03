// Story 014 + 012-001: file-manager checks, token-free.
//   node scripts/files-check.mjs        (or: npm run files-check)
//
// API side (the path the UI uses): multipart upload, tree listing, raw
// content, mkdir, move/rename, delete. Browser side: the uploaded file
// previews in the pane on click. Needs the backend + webapp dev servers — no
// LLM tokens.
//
// Story 012-001 (AC 5) adds folder coverage: mkdir creates an empty folder
// that the tree really lists, is idempotent, canonicalizes its path, refuses
// to clobber a file; move carries a file into it, refuses a folder into its
// own descendant (400 invalid_path), refuses a destination that exists (409
// conflict) and a destination already holding a pending edit (409 conflict
// with a `paths` array); a same-parent move renames the folder and carries its
// descendants; a recursive delete removes it.
//
// Runs against projects[0] (override with PROJECT_ID). The local data
// directory is disposable — every project in it is a test project — so no
// ceremony is needed. Paths are still `files-check`-prefixed and purge()d at
// startup and from a finally block, purely so repeated runs stay readable.
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
const projectId = Number(process.env.PROJECT_ID) || projects[0].id;
const api = (p) => `${BACKEND}/api/projects/${projectId}${p}`;
const fileApi = (path) => api(`/file?path=${encodeURIComponent(path)}`);
const getJson = async (url) => (await fetch(url)).json();
const status = async (url) => (await fetch(url)).status;

// --- The paths this script owns, and nothing else ---------------------------
const UPLOADED = 'files-check-upload.txt';
const RENAMED = 'files-check-renamed.txt';
const MIXED_OK = 'files-check-mixed-ok.txt';
const CONTENT = `files-check content ${'x'.repeat(40)}`;

// Folder leg (012-001).
const DIR = 'files-check-dir';
const DIR_NESTED = `${DIR}/nested`;
const DIR_RENAMED = 'files-check-dir-renamed';
const MOVE_SRC = 'files-check-move-me.md';
const MOVE_DST = `${DIR}/moved.md`;
const OTHER = `${DIR}/other.md`;
// The pending-edit conflict leg has to live inside draft/** — that is the
// suggestion scope (pending-edits.js isSuggestionPath), so a proposal is legal
// at both ends of the move.
const PEND_DIR = 'draft/files-check-pending';
const PEND_SRC = `${PEND_DIR}/src.md`;
const PEND_DST = `${PEND_DIR}/dst.md`;

const OWNED = [UPLOADED, RENAMED, MIXED_OK, DIR, DIR_RENAMED, MOVE_SRC, PEND_DIR];
const owned = (path) =>
  typeof path === 'string' && OWNED.some((p) => path === p || path.startsWith(`${p}/`));

// Dir-aware: the old flatten discarded directories entirely, so it could never
// observe an empty folder — the one thing mkdir produces.
const walkAll = (nodes) =>
  nodes.flatMap((n) => (n.type === 'dir' ? [n, ...walkAll(n.children ?? [])] : [n]));
const allNodes = async () => walkAll((await getJson(api('/files'))).tree);
const treePaths = async () =>
  (await allNodes()).filter((n) => n.type === 'file').map((n) => n.path);
const dirPaths = async () => (await allNodes()).filter((n) => n.type === 'dir').map((n) => n.path);
const nodeAt = async (p) => (await allNodes()).find((n) => n.path === p);

const putFile = (path, body) =>
  fetch(fileApi(path), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
const postJson = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const mkdir = (path) => postJson(api('/files/mkdir'), { path });
const moveEntry = (from, to) => postJson(api('/files/move'), { from, to });
const uploadBlob = (name, blob) => {
  const form = new FormData();
  form.append('files', blob, name);
  return fetch(api('/files/upload'), { method: 'POST', body: form });
};

/** Remove every row and every byte this script owns. Safe to run twice. */
async function purge() {
  for (const e of (await getJson(api('/pending-edits'))).edits ?? []) {
    if (owned(e.path)) await postJson(api(`/pending-edits/${e.id}/reject`), {}).catch(() => {});
  }
  // Directories delete recursively, so their contents go with them.
  for (const p of OWNED) await fetch(fileApi(p), { method: 'DELETE' }).catch(() => {});
}

await purge();

try {
  // ==========================================================================
  // 1. UPLOAD — one batch request, like uploadFiles
  // ==========================================================================
  const upRes = await uploadBlob(UPLOADED, new Blob([CONTENT], { type: 'text/plain' }));
  check(upRes.status === 201, `upload returns 201 (got ${upRes.status})`);
  check((await treePaths()).includes(UPLOADED), 'uploaded file appears in the tree');
  check((await (await fetch(fileApi(UPLOADED))).text()) === CONTENT, 'stored content matches the uploaded bytes');

  // --- activity log + unseen flags (stories 005-002/003) ---
  const uploadedNode = await nodeAt(UPLOADED);
  check(uploadedNode?.unseen === true, 'uploaded file is flagged unseen in the tree');
  check(typeof uploadedNode?.mtime === 'string', 'tree file nodes carry mtime');
  const activity = (await getJson(api('/files/activity?limit=20'))).events;
  check(
    activity.some((e) => e.path === UPLOADED && e.kind === 'create' && e.agent_slug === null),
    'activity log records the upload as a user action',
  );

  // ==========================================================================
  // 2. OVERSIZE UPLOAD — a readable 413, all-or-nothing (story 026)
  // ==========================================================================
  const LIMIT_BYTES = 20 * 1024 * 1024; // backend default; see STORAGE_MAX_FILE_BYTES
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

  // ==========================================================================
  // 3. BROWSER — click the .txt, it opens in the editor as raw text (issue #44)
  // ==========================================================================
  const browser = await chromium.launch();
  try {
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
  } finally {
    // A failed assertion above must not leave a headless Chromium running.
    await browser.close();
  }

  check((await nodeAt(UPLOADED))?.unseen !== true, 'seen state persisted server-side after the click');

  // ==========================================================================
  // 4. RENAME VIA MOVE — and a readable 409 onto an existing path
  // ==========================================================================
  const mvRes = await moveEntry(UPLOADED, RENAMED);
  check(mvRes.status === 200, `rename returns 200 (got ${mvRes.status})`);
  const afterRename = await treePaths();
  check(afterRename.includes(RENAMED) && !afterRename.includes(UPLOADED), 'rename is reflected in the tree');

  await uploadBlob(UPLOADED, new Blob(['conflict probe'], { type: 'text/plain' }));
  const conflictRes = await moveEntry(UPLOADED, RENAMED);
  const conflictBody = await conflictRes.json();
  check(conflictRes.status === 409, `rename onto an existing path is 409 (got ${conflictRes.status})`);
  check(
    typeof conflictBody.error === 'string' && conflictBody.error.length > 0,
    'conflict carries a readable error',
  );

  // ==========================================================================
  // 5. FOLDERS (story 012-001, AC 5) — mkdir / move / rename / recursive delete
  // ==========================================================================
  // One recursive call, spelled the sloppy way the UI could produce: the
  // response must echo the CANONICAL path, because the tree is keyed by it.
  const mkRes = await mkdir(`${DIR}//nested/`);
  const mkBody = await mkRes.json();
  check(mkRes.status === 201, `mkdir returns 201 (got ${mkRes.status})`);
  check(
    mkBody.path === DIR_NESTED && mkBody.created === true,
    `mkdir echoes the canonical path (got ${JSON.stringify(mkBody)})`,
  );

  const dirs = await dirPaths();
  check(dirs.includes(DIR) && dirs.includes(DIR_NESTED), 'mkdir creates the whole chain, parents included');
  const nested = await nodeAt(DIR_NESTED);
  check(
    nested?.type === 'dir' && Array.isArray(nested.children) && nested.children.length === 0,
    `the empty folder lists as type:'dir' with children:[] (got ${JSON.stringify(nested)})`,
  );
  // A second, independent GET: an empty folder is real state on disk, not an
  // artefact of the response that created it (AC 2's server-side leg).
  check((await dirPaths()).includes(DIR_NESTED), 'the empty folder is still there on a fresh GET /files');

  const againRes = await mkdir(DIR_NESTED);
  const againBody = await againRes.json();
  check(againRes.status === 200, `a repeat mkdir is 200, not an error (got ${againRes.status})`);
  check(againBody.created === false, 'a repeat mkdir reports created:false');

  await putFile(MOVE_SRC, 'move me into the new folder\n');
  const clobberRes = await mkdir(MOVE_SRC);
  const clobberBody = await clobberRes.json();
  check(clobberRes.status === 409, `mkdir onto a path held by a FILE is 409 (got ${clobberRes.status})`);
  check(clobberBody.code === 'conflict', `the 409 carries code 'conflict' (got ${clobberBody.code})`);
  check((await status(fileApi(MOVE_SRC))) === 200, 'the file mkdir refused to clobber is untouched');

  const intoRes = await moveEntry(MOVE_SRC, MOVE_DST);
  check(intoRes.status === 200, `moving a file into the new folder returns 200 (got ${intoRes.status})`);
  const afterInto = await treePaths();
  check(
    afterInto.includes(MOVE_DST) && !afterInto.includes(MOVE_SRC),
    'the tree shows the file at its new path inside the folder',
  );

  // AC 3, from the route's side: a folder can never be moved into its own
  // subtree. This is a 400, not a 500 with stray directories left behind.
  const selfRes = await moveEntry(DIR, `${DIR_NESTED}/inner`);
  const selfBody = await selfRes.json();
  check(selfRes.status === 400, `moving a folder into its own descendant is 400 (got ${selfRes.status})`);
  check(selfBody.code === 'invalid_path', `it carries code 'invalid_path' (got ${selfBody.code})`);
  check(!(await dirPaths()).includes(`${DIR_NESTED}/inner`), 'the refused move left no destination directory behind');

  // The two 409s the move UI has to tell apart. First: the destination exists
  // on disk — no `paths`.
  await putFile(OTHER, 'other\n');
  const existsRes = await moveEntry(OTHER, MOVE_DST);
  const existsBody = await existsRes.json();
  check(existsRes.status === 409, `moving onto an existing path is 409 (got ${existsRes.status})`);
  check(existsBody.code === 'conflict', `it carries code 'conflict' (got ${existsBody.code})`);
  check(existsBody.paths === undefined, 'a destination-exists 409 carries no paths array');

  // Second: an agent's pending edit is already waiting at the destination.
  // Proposals live only in the DB, so storage cannot see this one.
  await putFile(PEND_SRC, '# pending source\n');
  const proposeRes = await postJson(api('/pending-edits'), {
    path: PEND_DST,
    proposedContent: '# proposed at the destination\n',
    agent: 'reviewer',
  });
  check(proposeRes.status === 201, `pending edit created at the destination (got ${proposeRes.status})`);
  const pendRes = await moveEntry(PEND_SRC, PEND_DST);
  const pendBody = await pendRes.json();
  check(pendRes.status === 409, `moving onto a pending edit is 409 (got ${pendRes.status})`);
  check(pendBody.code === 'conflict', `it carries code 'conflict' (got ${pendBody.code})`);
  check(
    Array.isArray(pendBody.paths) && pendBody.paths.includes(PEND_DST),
    `the pending-edit 409 names the clashing path (got ${JSON.stringify(pendBody.paths)})`,
  );
  check((await status(fileApi(PEND_SRC))) === 200, 'the pre-flight 409 left the source file in place');

  // Rename the folder — a same-parent move — and its whole subtree follows.
  const renameRes = await moveEntry(DIR, DIR_RENAMED);
  check(renameRes.status === 200, `renaming a folder returns 200 (got ${renameRes.status})`);
  const afterFolderRename = await treePaths();
  const dirsAfterRename = await dirPaths();
  check(
    afterFolderRename.includes(`${DIR_RENAMED}/moved.md`),
    'a descendant file follows the renamed folder',
  );
  check(
    dirsAfterRename.includes(`${DIR_RENAMED}/nested`),
    'the empty child folder follows the renamed folder too',
  );
  check(
    !dirsAfterRename.includes(DIR) && !afterFolderRename.some((p) => p.startsWith(`${DIR}/`)),
    'nothing is stranded at the old folder path',
  );

  // Recursive delete: the folder and everything under it.
  const delDirRes = await fetch(fileApi(DIR_RENAMED), { method: 'DELETE' });
  check(delDirRes.status === 200, `deleting a folder returns 200 (got ${delDirRes.status})`);
  const afterDelete = await allNodes();
  check(
    !afterDelete.some((n) => n.path === DIR_RENAMED || n.path.startsWith(`${DIR_RENAMED}/`)),
    'the folder and every descendant are gone from the tree',
  );
} finally {
  // Always — leftover fixtures make the next run's output confusing.
  await purge();
  const leftovers = (await allNodes()).map((n) => n.path).filter(owned);
  check(leftovers.length === 0, `cleanup left nothing behind (${JSON.stringify(leftovers)})`);
}

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
