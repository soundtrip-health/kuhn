// Story 006-004: org-library UI checks. API side: find-or-create the check
// org, upload → ingestion status → visible in the library list, promote a
// project file into the owning org's library (dedupe on repeat). Browser side:
// the org-creation modal (slug preview, Escape without creating), the org-menu
// "Set up" hint, the empty state, an upload through the panel reaching
// "Searchable" live, and the promote action's ingesting/done row badge.
// Needs the backend + webapp dev servers — no LLM tokens.
//   node scripts/org-library-check.mjs
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, label) => {
  console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`);
  if (!cond) fail(label);
};

const ORG_NAME = 'Library Check Org';
const ORG_SLUG = 'library-check-org';
const DOC_NAME = 'org-library-check-styleguide.md';
const DOC_CONTENT = '# House style\n\nAlways report the zymurgy coefficient with confidence intervals.\n';
const PROMOTE_NAME = 'org-library-check-promote.txt';

const json = async (res) => res.json();
const libApi = (orgId, p = '') => `${BACKEND}/api/orgs/${orgId}/library${p}`;

// --- API: find-or-create the check org (idempotent across runs) ---
// Org creation is super-admin-only since epic 011 and the creator gets no
// membership unless named as first admin — the dev user is both the default
// super-admin and this script's identity, so pass its own email as ownerEmail
// (member:true) or every library call below would 404.
const me = (await json(await fetch(`${BACKEND}/api/auth/me`))).user;
let orgs = (await json(await fetch(`${BACKEND}/api/orgs`))).orgs;
let org = orgs.find((o) => o.slug === ORG_SLUG);
if (!org) {
  const res = await fetch(`${BACKEND}/api/orgs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: ORG_NAME, slug: ORG_SLUG, ownerEmail: me.email }),
  });
  check(res.status === 201, `create org returns 201 (got ${res.status})`);
  org = (await json(res)).org;
  orgs = (await json(await fetch(`${BACKEND}/api/orgs`))).orgs;
}

// Cleanup from prior runs so the empty-state/hint assertions hold.
for (const doc of (await json(await fetch(libApi(org.id)))).documents) {
  await fetch(libApi(org.id, `/${doc.id}`), { method: 'DELETE' });
}
check((await json(await fetch(libApi(org.id)))).documents.length === 0, 'check org library starts empty');

// --- API: promote a project file into the owning org's library ---
const projects = (await json(await fetch(`${BACKEND}/api/projects`))).projects;
const project = projects[0];
const projApi = (p) => `${BACKEND}/api/projects/${project.id}${p}`;
{
  const form = new FormData();
  form.append('files', new Blob(['promote me to the library'], { type: 'text/plain' }), PROMOTE_NAME);
  await fetch(projApi('/files/upload'), { method: 'POST', body: form });

  const res = await fetch(projApi('/files/promote'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: PROMOTE_NAME }),
  });
  const body = await json(res);
  check(res.status === 201, `promote returns 201 (got ${res.status})`);
  check(body.document?.source === 'project-promotion', 'promoted doc carries project-promotion source');
  check(body.document?.org_id === project.org_id, 'promote lands in the project-owning org');

  const again = await json(await fetch(projApi('/files/promote'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: PROMOTE_NAME }),
  }));
  check(again.deduped === true, 'promoting the same bytes again dedupes');

  // Clean the promoted doc out of the default org library; keep the project
  // file for the browser-side promote check below.
  await fetch(`${BACKEND}/api/orgs/${project.org_id}/library/${body.document.id}`, { method: 'DELETE' });
}

// --- Browser ---
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));
page.on('dialog', (d) => void d.accept()); // promote/delete confirm()s

await page.goto(WEBAPP);
await page.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
await page.waitForTimeout(800);

// Promote from the file manager (default org project): book action → confirm
// → ingesting/done badge on the row, driven by the org feed.
{
  const entry = `.file-entry[data-path="${PROMOTE_NAME}"]`;
  await page.waitForSelector(entry, { timeout: 10000 }).catch(() => fail('promote fixture file not in the tree'));
  await page.hover(`${entry}`).catch(() => {});
  const row = page.locator('.file-row', { has: page.locator(entry) });
  await row.locator('.file-action[title^="Add to org library"]').click({ force: true })
    .catch(() => fail('promote action button not clickable'));
  const settled = await page
    .waitForSelector(`${entry} .file-done, ${entry} .file-spinner`, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(settled, 'promote shows an ingesting/done badge on the file row');
  const done = await page
    .waitForSelector(`${entry} .file-done`, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(done, 'promoted file reaches the done badge (ingestion ready)');
}

// Org-creation modal: opens from the menu, previews the slug, Escape closes
// without creating.
{
  await page.click('.breadcrumb-org');
  await page.click('.breadcrumb-menu-item.bm-create');
  const dialog = await page.waitForSelector('#org-create[role="dialog"]', { timeout: 5000 }).catch(() => null);
  check(Boolean(dialog), 'org-creation modal opens as a dialog');
  await page.fill('#org-create-name', 'Modal Probe Org!');
  const slug = await page.textContent('#org-create .om-slug').catch(() => '');
  check(slug?.includes('modal-probe-org'), `slug preview derives from the name (got "${slug}")`);
  await page.keyboard.press('Escape');
  check((await page.locator('#org-create').count()) === 0, 'Escape closes the modal');
  const orgCount = (await json(await fetch(`${BACKEND}/api/orgs`))).orgs.length;
  check(orgCount === orgs.length, 'cancelled modal created no organization');
}

// Switch to the (empty-library) check org; the org menu carries the hint.
{
  await page.click('.breadcrumb-org');
  await page.click(`.breadcrumb-menu [role="menuitem"]:has-text("${ORG_NAME}")`);
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape'); // org has no projects → project browser auto-opened

  await page.click('.breadcrumb-org');
  const hint = await page
    .waitForSelector('.bm-library .bm-hint:not([hidden])', { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(hint, 'org menu shows the "Set up" hint while the library is empty');

  await page.click('.breadcrumb-menu-item.bm-library');
  const panel = await page.waitForSelector('#org-library:not([hidden])', { timeout: 5000 }).catch(() => null);
  check(Boolean(panel), 'org library panel opens from the org menu');
  const empty = await page.waitForSelector('#org-library .ol-empty', { timeout: 5000 }).catch(() => null);
  check(Boolean(empty), 'empty library shows the inviting empty state');
}

// Upload through the panel → row appears → live status reaches Searchable.
{
  await page.setInputFiles('#org-library .ol-upload-input', {
    name: DOC_NAME,
    mimeType: 'text/markdown',
    buffer: Buffer.from(DOC_CONTENT),
  });
  const row = await page
    .waitForSelector(`#org-library .ol-row:has-text("${DOC_NAME}")`, { timeout: 8000 })
    .catch(() => null);
  check(Boolean(row), 'uploaded document appears in the library list');
  const ready = await page
    .waitForSelector('#org-library .ol-status.is-ready', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(ready, 'document status reaches Searchable in the open panel (live feed)');
  const source = await page.textContent(`#org-library .ol-row .ol-doc-meta`).catch(() => '');
  check(source?.includes('Uploaded'), 'row shows its source label');

  await page.keyboard.press('Escape');
  await page.click('.breadcrumb-org');
  await page.waitForTimeout(600); // hint refresh round-trip
  const hintGone = (await page.locator('.bm-library .bm-hint:not([hidden])').count()) === 0;
  check(hintGone, 'the "Set up" hint clears once a document is ready');
}

await browser.close();

// --- API: uploaded doc is ready and listed; clean up ---
{
  const documents = (await json(await fetch(libApi(org.id)))).documents;
  const doc = documents.find((d) => d.filename === DOC_NAME);
  check(Boolean(doc), 'uploaded document is in the library via the API');
  check(doc?.status === 'ready', `uploaded document ingested to ready (got ${doc?.status})`);
  for (const d of documents) await fetch(libApi(org.id, `/${d.id}`), { method: 'DELETE' });
  await fetch(projApi(`/file?path=${encodeURIComponent(PROMOTE_NAME)}`), { method: 'DELETE' });
  // The browser-side promote also landed a copy in the default org's library.
  const defaultDocs = (await json(await fetch(`${BACKEND}/api/orgs/${project.org_id}/library`))).documents;
  for (const d of defaultDocs.filter((d) => d.filename === PROMOTE_NAME)) {
    await fetch(`${BACKEND}/api/orgs/${project.org_id}/library/${d.id}`, { method: 'DELETE' });
  }
}

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
