// Story 012-001: token-free browser coverage of the folder tree UI.
//   node scripts/tree-check.mjs        (or: npm run tree-check)
//
// Needs the backend AND the webapp dev server up (agent-backend: npm run dev;
// webapp: npm run dev). No LLM tokens are spent — every fixture is created
// through the REST surface and every assertion is made against the real DOM.
//
// Covers, from the UI side:
//   1. the project root is a real focusable treeitem, and the tree carries
//      aria-level / aria-setsize / aria-posinset / aria-owns
//   2. collapsing a folder survives a RELOAD, and the restored row reports
//      aria-expanded="false" (not just "looks collapsed")
//   3. a collapsed folder rolls up its DESCENDANT file count; expanding it
//      switches the count back to direct children and hides the rollup badges
//   4. an EMPTY folder created through the API renders as a folder row (AC 2)
//   5. the New folder button creates a folder through the UI, which becomes
//      the upload target and takes keyboard focus
//   6. `r` on a focused row renames it; focus lands on the renamed row
//   7. `m` opens the Move dialog; filter + Enter moves the row
//   8. drag-and-drop moves a row onto a folder, and a folder dropped into its
//      OWN DESCENDANT is refused by the UI with nothing moved
//
// Runs against projects[0] (override with PROJECT_ID). The local data
// directory is disposable — every project in it is a test project and the DB
// and files can be dropped at any time — so this needs no ceremony. Paths are
// still `tree-check`-prefixed and purge()d at startup and from a finally
// block, purely so repeated runs stay readable.
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

// --- The paths this script owns, and nothing else ---------------------------
const DIR = 'tree-check-dir';
const SUB = `${DIR}/sub`;
const DIR_A = `${DIR}/alpha.md`;
const DIR_RENAME = `${DIR}/rename-me.md`;
const DIR_MOVE = `${DIR}/move-me.md`;
const SUB_DEEP = `${SUB}/deep.md`;
const DEST = 'tree-check-dest';
const EMPTY = 'tree-check-empty';
const DRAGGED = 'tree-check-drag.md';
const RENAMED = `${DIR}/renamed.md`;
const MOVED = `${DEST}/move-me.md`;
const DRAG_DST = `${DEST}/${DRAGGED}`;
const NEW_FOLDER = 'tree-check-new';
const SUB_MOVED = `${DEST}/sub`;
const SUB_MOVED_DEEP = `${SUB_MOVED}/deep.md`;

const OWNED = [DIR, DEST, EMPTY, DRAGGED, NEW_FOLDER];
const owned = (path) =>
  typeof path === 'string' && OWNED.some((p) => path === p || path.startsWith(`${p}/`));

// Dir-aware: a flatten that drops directories can never observe an empty one.
const walkAll = (nodes) =>
  nodes.flatMap((n) => (n.type === 'dir' ? [n, ...walkAll(n.children ?? [])] : [n]));
const allNodes = async () => walkAll((await getJson(api('/files'))).tree);
const allPaths = async () => (await allNodes()).map((n) => n.path);
const nodeAt = async (p) => (await allNodes()).find((n) => n.path === p);

const postJson = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const mkdir = (path) => postJson(api('/files/mkdir'), { path });
const uploadInto = (dir, name, text) => {
  const form = new FormData();
  // `path` (the route's field name), and BEFORE `files` — multer only exposes
  // fields that arrive ahead of the file parts, which is also why api.ts
  // appends it first.
  if (dir) form.append('path', dir);
  form.append('files', new Blob([text], { type: 'text/markdown' }), name);
  return fetch(api('/files/upload'), { method: 'POST', body: form });
};

/** Remove every byte this script owns. Safe to run twice. */
async function purge() {
  // Directories delete recursively, so their contents go with them.
  for (const p of OWNED) await fetch(fileApi(p), { method: 'DELETE' }).catch(() => {});
}

// --- Browser helpers --------------------------------------------------------
const summarySel = (path) => `#file-tree summary[data-path="${path}"]`;
const entrySel = (path) => `#file-tree .file-entry[data-path="${path}"]`;

/** Fire a complete HTML5 drag sequence with one shared DataTransfer. Synthetic
 * rather than page.dragAndDrop() on purpose: this exercises exactly the
 * delegated dragstart/dragover/drop listeners, deterministically, with no
 * dependence on headless Chromium's native DnD. */
const dragTo = (page, fromSel, toSel) =>
  page.evaluate(
    ([from, to]) => {
      const src = document.querySelector(from);
      const dst = document.querySelector(to);
      if (!src || !dst) return false;
      const dt = new DataTransfer();
      const fire = (el, type) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      fire(src, 'dragstart');
      fire(dst, 'dragover');
      fire(dst, 'drop');
      fire(src, 'dragend');
      return true;
    },
    [fromSel, toSel],
  );

const activePath = (page) =>
  page.evaluate(() => document.activeElement?.getAttribute('data-path') ?? null);

/** Wait until the tree reflects a path (or its absence). */
const waitForPath = (page, sel, present = true) =>
  page.waitForSelector(sel, { state: present ? 'attached' : 'detached', timeout: 10000 });

await purge();

try {
  // ==========================================================================
  // 0. FIXTURES (REST) — a folder with a nested subfolder, plus an EMPTY one
  // ==========================================================================
  check((await mkdir(DIR)).status === 201, 'fixture folder created');
  check((await mkdir(DEST)).status === 201, 'destination folder created');
  const emptyRes = await mkdir(EMPTY);
  check(emptyRes.status === 201, 'empty folder created');
  await uploadInto(DIR, 'alpha.md', '# alpha\n');
  await uploadInto(DIR, 'rename-me.md', '# rename me\n');
  await uploadInto(DIR, 'move-me.md', '# move me\n');
  await uploadInto(SUB, 'deep.md', '# deep\n');
  await uploadInto('', DRAGGED, '# drag me\n');
  const seeded = await allPaths();
  check(
    [DIR, SUB, DEST, EMPTY, DIR_A, DIR_RENAME, DIR_MOVE, SUB_DEEP, DRAGGED].every((p) =>
      seeded.includes(p),
    ),
    'all fixtures are in the tree before the browser starts',
  );
  check((await nodeAt(EMPTY))?.type === 'dir', 'the empty folder is listed as a directory');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));

    await page.goto(WEBAPP);
    await page.waitForSelector(
      '#editor .milkdown [contenteditable], #editor.editor-source .cm-content',
      { timeout: 15000 },
    );
    await waitForPath(page, summarySel(DIR));

    // ------------------------------------------------------------------ 1 --
    // Project root row + ARIA structure
    // ----------------------------------------------------------------------
    const root = page.locator('#file-tree .file-root');
    check((await root.count()) === 1, 'the project root renders as a single row');
    check(
      (await root.getAttribute('role')) === 'treeitem' && (await root.getAttribute('aria-level')) === '1',
      'the project root is a treeitem at aria-level 1',
    );
    const rootOwns = await root.getAttribute('aria-owns');
    check(
      !!rootOwns && (await page.locator(`#${rootOwns}[role="group"]`).count()) === 1,
      'the root treeitem owns the top-level group (aria-owns)',
    );
    const dirSummary = page.locator(summarySel(DIR));
    check((await dirSummary.getAttribute('aria-level')) === '2', 'a top-level folder is aria-level 2');
    check(
      (await page.locator(entrySel(DIR_A)).getAttribute('aria-level')) === '3',
      'a file inside a top-level folder is aria-level 3',
    );
    check(
      !!(await dirSummary.getAttribute('aria-setsize')) &&
        !!(await dirSummary.getAttribute('aria-posinset')),
      'treeitems carry aria-setsize / aria-posinset',
    );
    const dirOwns = await dirSummary.getAttribute('aria-owns');
    check(
      !!dirOwns && (await page.locator(`#${dirOwns}[role="group"]`).count()) === 1,
      'a folder treeitem owns its child group (aria-owns)',
    );

    // ------------------------------------------------------------------ 4 --
    // AC 2 — the empty folder renders as a folder row
    // ----------------------------------------------------------------------
    check((await page.locator(summarySel(EMPTY)).count()) === 1, 'the empty folder renders as a folder row');

    // ------------------------------------------------------------------ 3 --
    // Rollup: expanded shows DIRECT children, collapsed shows DESCENDANTS
    // ----------------------------------------------------------------------
    check(
      (await dirSummary.getAttribute('aria-expanded')) === 'true',
      'an unseen folder defaults to expanded',
    );
    check(
      (await page.locator(`${summarySel(DIR)} .file-count`).textContent()) === '3',
      'an expanded folder counts its direct children (3)',
    );
    await dirSummary.click();
    await page.waitForTimeout(150);
    check((await dirSummary.getAttribute('aria-expanded')) === 'false', 'clicking the summary collapses it');
    check(
      (await page.locator(`${summarySel(DIR)} .file-count`).textContent()) === '4',
      'a collapsed folder rolls up its descendant files (4)',
    );
    check(
      (await page.locator(`${summarySel(DIR)} .file-badge.is-rollup`).count()) > 0,
      'a collapsed folder with unseen descendants shows a rollup badge',
    );
    const rollupVisible = await page
      .locator(`${summarySel(DIR)} .file-badge.is-rollup`)
      .first()
      .isVisible();
    check(rollupVisible, 'the rollup badge is visible while collapsed');

    // ------------------------------------------------------------------ 2 --
    // Persistence across a RELOAD
    // ----------------------------------------------------------------------
    await page.reload();
    await page.waitForSelector(
      '#editor .milkdown [contenteditable], #editor.editor-source .cm-content',
      { timeout: 15000 },
    );
    await waitForPath(page, summarySel(DIR));
    check(
      (await page.locator(summarySel(DIR)).getAttribute('aria-expanded')) === 'false',
      'the collapsed folder is still collapsed after a reload, and says so (aria-expanded)',
    );
    check(
      !(await page.locator(entrySel(DIR_A)).isVisible()),
      'the collapsed folder still hides its children after a reload',
    );
    check(
      (await page.locator(summarySel(EMPTY)).count()) === 1,
      'the empty folder still renders after a reload (AC 2)',
    );
    // Re-expand for the rest of the run; the rollup badges must go away.
    await page.locator(summarySel(DIR)).click();
    await page.waitForTimeout(150);
    check(
      (await page.locator(`${summarySel(DIR)} .file-badge.is-rollup`).first().isVisible()) === false,
      'the rollup badges disappear when the folder is expanded',
    );
    check(
      (await page.locator(`${summarySel(DIR)} .file-count`).count()) === 1,
      'the file count stays visible on an expanded folder',
    );

    // ------------------------------------------------------------------ 5 --
    // New folder through the UI (button + inline input)
    // ----------------------------------------------------------------------
    await page.locator('#file-tree .file-root').click(); // target = project root
    await page.locator('#files-new-folder-btn').click();
    await page.waitForSelector('#file-tree .file-name-input', { timeout: 5000 });
    await page.keyboard.type(NEW_FOLDER);
    await page.keyboard.press('Enter');
    await waitForPath(page, summarySel(NEW_FOLDER));
    check(true, 'the New folder button creates a folder that appears in the tree');
    check((await nodeAt(NEW_FOLDER))?.type === 'dir', 'the new folder exists on the server');
    check(
      (await page.locator(summarySel(NEW_FOLDER)).getAttribute('aria-current')) === 'true',
      'the new folder becomes the upload target',
    );
    check(await activePath(page) === NEW_FOLDER, 'focus lands on the newly created folder');

    // ------------------------------------------------------------------ 6 --
    // Rename with the `r` shortcut on a focused row
    // ----------------------------------------------------------------------
    await page.locator(entrySel(DIR_RENAME)).focus();
    await page.keyboard.press('r');
    await page.waitForSelector('#file-tree .file-name-input', { timeout: 5000 });
    // ControlOrMeta: plain Control+a is not select-all on macOS Chromium (it is
    // an Emacs move-to-start binding), and the app pre-selects only the stem.
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('renamed.md');
    await page.keyboard.press('Enter');
    await waitForPath(page, entrySel(RENAMED));
    const afterRename = await allPaths();
    check(
      afterRename.includes(RENAMED) && !afterRename.includes(DIR_RENAME),
      'the rename is reflected on the server',
    );
    check(await activePath(page) === RENAMED, 'focus lands on the renamed row');

    // ------------------------------------------------------------------ 7 --
    // Move via the dialog with the `m` shortcut (the PRIMARY move path)
    // ----------------------------------------------------------------------
    await page.locator(entrySel(DIR_MOVE)).focus();
    await page.keyboard.press('m');
    await page.waitForSelector('#move-dialog:not([hidden])', { timeout: 5000 });
    check(
      await page.evaluate(() => document.activeElement?.classList.contains('mv-filter') ?? false),
      'the Move dialog opens with focus in the filter',
    );
    await page.keyboard.type(DEST);
    await page.waitForTimeout(100);
    check(
      (await page.locator('#move-dialog .mv-item.active').getAttribute('data-path')) === DEST,
      'filtering activates the destination folder',
    );
    await page.keyboard.press('Enter');
    await waitForPath(page, entrySel(MOVED));
    const afterMove = await allPaths();
    check(
      afterMove.includes(MOVED) && !afterMove.includes(DIR_MOVE),
      'the dialog move is reflected on the server',
    );
    check(
      await page.locator('#move-dialog').evaluate((el) => el.hidden),
      'the dialog closes on a successful move',
    );
    check(await activePath(page) === MOVED, 'focus lands on the moved row');

    // ------------------------------------------------------------------ 8 --
    // Drag and drop (layered on top of the dialog, never the only path)
    // ----------------------------------------------------------------------
    check(await dragTo(page, entrySel(DRAGGED), summarySel(DEST)), 'drag sequence dispatched');
    await waitForPath(page, entrySel(DRAG_DST));
    const afterDrag = await allPaths();
    check(
      afterDrag.includes(DRAG_DST) && !afterDrag.includes(DRAGGED),
      'dragging a file onto a folder row moves it',
    );

    // A folder dropped into its own descendant must be refused by the UI —
    // nothing moves and the server is never asked.
    await dragTo(page, summarySel(DIR), summarySel(SUB));
    await page.waitForTimeout(400);
    const afterIllegal = await allPaths();
    check(
      afterIllegal.includes(SUB) && afterIllegal.includes(SUB_DEEP),
      'dropping a folder into its own descendant is refused, with nothing moved',
    );

    // ---------------------------------------------------------------- 7b --
    // AC 1's "including folders with contents": move a FOLDER via the dialog
    // and its children must arrive with it.
    // ----------------------------------------------------------------------
    await page.locator(summarySel(SUB)).focus();
    await page.keyboard.press('m');
    await page.waitForSelector('#move-dialog:not([hidden])', { timeout: 5000 });
    await page.keyboard.type(DEST);
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter');
    await waitForPath(page, summarySel(SUB_MOVED));
    const afterDirMove = await allPaths();
    check(
      afterDirMove.includes(SUB_MOVED) &&
        afterDirMove.includes(SUB_MOVED_DEEP) &&
        !afterDirMove.includes(SUB),
      'moving a folder via the dialog carries its contents',
    );

    // ---------------------------------------------------------------- 8b --
    // Drop onto a COLLAPSED folder row — the destination must accept the drop
    // without needing to be expanded first.
    // ----------------------------------------------------------------------
    await page.locator(summarySel(DEST)).click(); // collapse it
    await page.waitForTimeout(150);
    check(
      (await page.locator(summarySel(DEST)).getAttribute('aria-expanded')) === 'false',
      'the drop target folder is collapsed',
    );
    await dragTo(page, entrySel(RENAMED), summarySel(DEST));
    await waitForPath(page, entrySel(`${DEST}/renamed.md`));
    const afterCollapsedDrop = await allPaths();
    check(
      afterCollapsedDrop.includes(`${DEST}/renamed.md`) && !afterCollapsedDrop.includes(RENAMED),
      'dropping a file onto a collapsed folder moves it',
    );

    // ------------------------------------------------------------------ 9 --
    // Delete a folder CONTAINING THE OPEN DOCUMENT — the confirm() is
    // accepted, the folder goes, and the editor retargets off the dead path
    // instead of resurrecting it (an open-then-recreate would re-seed the
    // file from the Yjs room on the next autosave).
    // ----------------------------------------------------------------------
    page.on('dialog', (d) => void d.accept());
    const DOOMED_DOC = `${DEST}/renamed.md`;
    await page.locator(entrySel(DOOMED_DOC)).click();
    await page.waitForSelector(`${entrySel(DOOMED_DOC)}[aria-selected="true"]`, { timeout: 10000 });
    await page.locator(summarySel(DEST)).focus();
    await page.keyboard.press('Delete');
    await waitForPath(page, summarySel(DEST), false);
    check(!(await allPaths()).includes(DEST), 'deleting the folder is reflected on the server');
    await page.waitForTimeout(600); // let the editor settle on its fallback
    const openAfterDelete = await page.evaluate(
      () => document.querySelector('#file-tree [aria-selected="true"]')?.getAttribute('data-path') ?? null,
    );
    check(openAfterDelete !== DOOMED_DOC, 'the editor no longer points at the deleted document');
    const afterSettle = await allPaths();
    check(
      !afterSettle.includes(DOOMED_DOC),
      'the deleted document is not resurrected by the editor',
    );

    // Leave no trace in the headless profile's storage either.
    await page.evaluate((id) => localStorage.removeItem(`kuhn-tree-state:${id}`), projectId);
  } finally {
    // A failed assertion above must not leave a headless Chromium running.
    await browser.close();
  }
} finally {
  // Always — leftover fixtures make the next run's output confusing.
  await purge();
  const leftovers = (await allPaths()).filter(owned);
  check(leftovers.length === 0, `cleanup left nothing behind (${JSON.stringify(leftovers)})`);
}

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
