// Issue #65 (PLA-255): Knowledge Library checks — the TESTING.md checklist,
// scripted. API side: catalog shape (12 packages, 3 nested under Biosciences),
// find-or-create the check org, enable/import/disable round-trip, the
// catalog-linked delete refusal. Browser side: the org admin Knowledge tab
// (package hierarchy, nested Biosciences packages, owner enable → live
// "Searchable", per-item/package checkbox state incl. indeterminate), the org
// library panel grouping imports under "Kuhn knowledge library" with locked
// delete buttons, the non-owner read-only Knowledge view (a second browser
// identity via the dev-mode x-kuhn-user header), and the new-org seed step's
// package picker with "General scientific writing" pre-checked.
// Needs the backend + webapp dev servers — no LLM tokens.
//   node scripts/knowledge-check.mjs
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, label) => {
  console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`);
  if (!cond) fail(label);
};

const ORG_NAME = 'Knowledge Check Org';
const ORG_SLUG = 'knowledge-check-org';
const VIEWER = 'kuhn-knowledge-check-viewer@check.local';
const GSW = 'general-scientific-writing';
const GSW_ITEM = 'general-scientific-writing/scientific-writing-style-guide';
const BCT = 'biosciences-clinical-trials';

const json = async (res) => res.json();
const knApi = (orgId, p = '') => `${BACKEND}/api/orgs/${orgId}/knowledge${p}`;
const libApi = (orgId, p = '') => `${BACKEND}/api/orgs/${orgId}/library${p}`;
const put = (url, body) => fetch(url, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const allItems = (packages) => packages.flatMap((p) => p.items);
const orgItems = async (orgId) =>
  allItems((await json(await fetch(knApi(orgId)))).packages);
const disableAll = async (orgId) => {
  const enabled = (await orgItems(orgId)).filter((i) => i.enabled).map((i) => i.id);
  if (enabled.length > 0) await put(knApi(orgId, '/selections'), { disable: enabled });
};

// --- API: the org-independent catalog shape ---
const { packages: catalog } = await json(await fetch(`${BACKEND}/api/knowledge/catalog`));
check(catalog.length === 12, `catalog has 12 packages (got ${catalog.length})`);
const nested = catalog.filter((p) => p.parent != null);
check(nested.length === 3 && nested.every((p) => p.parent === 'biosciences'),
  'exactly 3 packages nest under Biosciences');
check(allItems(catalog).length >= 3, 'catalog carries the initial items');
check(allItems(catalog).every((i) => i.available),
  'every published item is available in this checkout');

// --- API: find-or-create the check org (idempotent across runs) ---
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
}

// Reset from prior runs: no selections, an empty library.
await disableAll(org.id);
for (const doc of (await json(await fetch(libApi(org.id)))).documents) {
  await fetch(libApi(org.id, `/${doc.id}`), { method: 'DELETE' });
}
check((await orgItems(org.id)).every((i) => !i.enabled), 'check org starts with nothing enabled');
check((await json(await fetch(libApi(org.id)))).documents.length === 0,
  'check org library starts empty');

// --- Browser (owner) ---
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));
page.on('dialog', (d) => void d.accept());

// The check never touches the editor, so anchor on the breadcrumb — that also
// keeps it working on a fresh isolated stack whose default org has no
// projects yet (the project browser auto-opens there; Escape dismisses it).
await page.goto(WEBAPP);
await page.waitForSelector('.breadcrumb-org', { timeout: 15000 });
await page.waitForTimeout(800);
await page.keyboard.press('Escape');

// Switch into the check org (no projects → the project browser auto-opens).
await page.click('.breadcrumb-org');
await page.click(`.breadcrumb-menu [role="menuitem"]:has-text("${ORG_NAME}")`);
await page.waitForTimeout(600);
await page.keyboard.press('Escape');

// Org admin → Knowledge tab: the package hierarchy renders.
{
  await page.click('.breadcrumb-org');
  await page.click('.breadcrumb-menu-item.bm-admin');
  await page.waitForSelector('#org-admin[role="dialog"]', { timeout: 5000 })
    .catch(() => fail('org admin overlay opens'));
  await page.click('.admin-tab:has-text("Knowledge")');
  const tree = await page.waitForSelector('#org-admin .kn-tree', { timeout: 8000 }).catch(() => null);
  check(Boolean(tree), 'Knowledge tab loads the catalog tree');
  const pkgCount = await page.locator('#org-admin .kn-pkg').count();
  check(pkgCount === 12, `Knowledge tab lists 12 packages (got ${pkgCount})`);
  const nestedCount = await page.locator('#org-admin .kn-pkg.kn-pkg-nested').count();
  check(nestedCount === 3, `3 packages render nested under Biosciences (got ${nestedCount})`);
  const nestedIds = await page.$$eval('#org-admin .kn-pkg-nested',
    (els) => els.map((el) => el.dataset.packageId));
  check(nestedIds.every((id) => id.startsWith('biosciences-')),
    `nested packages are the Biosciences children (got ${nestedIds.join(', ')})`);
}

// Owner enables a package → import runs → row reaches "Searchable" live.
{
  await page.click(`.kn-pkg[data-package-id="${GSW}"] .kn-pkg-toggle`);
  await page.waitForSelector(`.kn-item[data-item-id="${GSW_ITEM}"]`, { timeout: 5000 })
    .catch(() => fail('expanding a package reveals its item rows'));
  await page.click(`.kn-pkg[data-package-id="${GSW}"] .kn-pkg-check`);
  const checked = await page
    .waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return el && el.checked && !el.disabled;
    }, `.kn-item[data-item-id="${GSW_ITEM}"] .kn-check`, { timeout: 10000 })
    .then(() => true).catch(() => false);
  check(checked, 'package checkbox enables its items');
  const ready = await page
    .waitForSelector(`.kn-item[data-item-id="${GSW_ITEM}"] .ol-status.is-ready`, { timeout: 20000 })
    .then(() => true).catch(() => false);
  check(ready, 'enabled item reaches "Searchable" live in the Knowledge tab');

  const state = (await orgItems(org.id)).find((i) => i.id === GSW_ITEM);
  check(state?.enabled === true && state?.doc_id != null,
    'imported state appears in the org knowledge API');
  check(state?.imported_version === 1 && state?.update_available === false,
    'import is stamped at the current catalog version');
}

// Per-item/package checkbox state, including indeterminate.
{
  await page.click(`.kn-pkg[data-package-id="${BCT}"] .kn-pkg-toggle`);
  await page.waitForSelector(`.kn-pkg[data-package-id="${BCT}"] .kn-item .kn-check`, { timeout: 5000 });
  await page.click(`.kn-pkg[data-package-id="${BCT}"] .kn-pkg-check`);
  const bothChecked = await page
    .waitForFunction((sel) => {
      const boxes = [...document.querySelectorAll(sel)];
      return boxes.length === 2 && boxes.every((b) => b.checked && !b.disabled);
    }, `.kn-pkg[data-package-id="${BCT}"] .kn-item .kn-check`, { timeout: 10000 })
    .then(() => true).catch(() => false);
  check(bothChecked, 'checking a package enables every item in it');

  await page.click(`.kn-pkg[data-package-id="${BCT}"] .kn-item .kn-check`); // uncheck the first
  const indeterminate = await page
    .waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return el && el.indeterminate && el.getAttribute('aria-checked') === 'mixed';
    }, `.kn-pkg[data-package-id="${BCT}"] .kn-pkg-check`, { timeout: 10000 })
    .then(() => true).catch(() => false);
  check(indeterminate, 'unchecking one item flips the package checkbox to indeterminate');
  const count = await page.textContent(`.kn-pkg[data-package-id="${BCT}"] .kn-pkg-count`);
  check(count?.trim() === '1/2 enabled', `package count reads 1/2 enabled (got "${count?.trim()}")`);
  await page.keyboard.press('Escape'); // close the admin overlay
}

// Org library panel: imports grouped under "Kuhn knowledge library", locked.
{
  await page.click('.breadcrumb-org');
  await page.click('.breadcrumb-menu-item.bm-library');
  await page.waitForSelector('#org-library:not([hidden])', { timeout: 5000 })
    .catch(() => fail('org library panel opens'));
  const groupTitle = await page.textContent('#org-library .ol-group-title').catch(() => null);
  check(groupTitle === 'Kuhn knowledge library',
    'catalog imports are grouped under their own header');
  const lockedCount = await page.locator('#org-library .ol-delete.is-locked[disabled]').count();
  const rowCount = await page.locator('#org-library .ol-row').count();
  check(rowCount === 2 && lockedCount === 2,
    `every imported row's delete button is locked (${lockedCount}/${rowCount})`);
  await page.keyboard.press('Escape');

  // And the lock is enforced server-side, not just visually.
  const imported = (await json(await fetch(libApi(org.id)))).documents
    .filter((d) => d.catalog_item_id != null);
  check(imported.length === 2, `2 imported documents in the library API (got ${imported.length})`);
  const del = await fetch(libApi(org.id, `/${imported[0]?.id}`), { method: 'DELETE' });
  check(del.status === 409, `ordinary delete of a catalog import refuses with 409 (got ${del.status})`);
}

// Non-owner read-only view: a second dev identity (auto-joined to the default
// org as editor) sees only the Knowledge tab, with every checkbox disabled.
{
  const viewerCtx = await browser.newContext({ extraHTTPHeaders: { 'x-kuhn-user': VIEWER } });
  const vp = await viewerCtx.newPage();
  vp.on('pageerror', (err) => fail(`viewer pageerror: ${err.message}`));
  await vp.goto(WEBAPP);
  await vp.waitForSelector('.breadcrumb-org', { timeout: 15000 });
  await vp.waitForTimeout(800);
  await vp.keyboard.press('Escape');

  await vp.click('.breadcrumb-org');
  const adminEntry = await vp.locator('.breadcrumb-menu-item.bm-admin').count();
  check(adminEntry === 0, 'non-owner org menu has no "Org admin…" entry');
  const knowledgeEntry = await vp
    .waitForSelector('.breadcrumb-menu-item.bm-knowledge', { timeout: 5000 })
    .catch(() => null);
  check(Boolean(knowledgeEntry), 'non-owner org menu offers "Org knowledge…"');
  await vp.click('.breadcrumb-menu-item.bm-knowledge');
  await vp.waitForSelector('#org-admin .kn-tree', { timeout: 8000 })
    .catch(() => fail('read-only Knowledge view opens for a non-owner'));
  const tabCount = await vp.locator('#org-admin .admin-tab').count();
  check(tabCount === 1, `non-owner sees only the Knowledge tab (got ${tabCount} tabs)`);
  const boxes = await vp.$$eval('#org-admin .kn-check',
    (els) => ({ total: els.length, disabled: els.filter((el) => el.disabled).length }));
  check(boxes.total > 0 && boxes.disabled === boxes.total,
    `every checkbox is disabled for a non-owner (${boxes.disabled}/${boxes.total})`);
  await viewerCtx.close();
}

// New-org seed step: the package picker, "General scientific writing"
// pre-checked, apply enables its items. (The probe org stays behind — the
// local data dir is disposable and org deletion is not part of the product.)
const probeName = `Knowledge Seed Probe ${Date.now()}`;
{
  await page.click('.breadcrumb-org');
  await page.click('.breadcrumb-menu-item.bm-create');
  await page.waitForSelector('#org-create[role="dialog"]', { timeout: 5000 })
    .catch(() => fail('org-creation modal opens'));
  await page.fill('#org-create-name', probeName);
  await page.click('#org-create button[type="submit"]');
  const picker = await page
    .waitForSelector('#org-create .om-kn-picker .om-kn-pkg', { timeout: 8000 })
    .catch(() => null);
  check(Boolean(picker), 'seed step shows the knowledge package picker');
  const preChecked = await page
    .$eval(`#org-create .om-kn-pkg input[value="${GSW}"]`, (el) => el.checked)
    .catch(() => false);
  check(preChecked, '"General scientific writing" is pre-checked in the seed picker');
  const nestedRows = await page.locator('#org-create .om-kn-pkg.om-kn-nested').count();
  check(nestedRows >= 1, 'seed picker indents nested packages');

  await page.click('#org-create .om-kn-apply');
  const applied = await page
    .waitForFunction(() => document.querySelector('#org-create .om-kn-apply')?.textContent === 'Added',
      undefined, { timeout: 10000 })
    .then(() => true).catch(() => false);
  check(applied, 'seed step applies the selected packages');
  await page.click('#org-create .pb-close');
}

await browser.close();

// --- API: the seed step really enabled the default package; clean up ---
{
  orgs = (await json(await fetch(`${BACKEND}/api/orgs`))).orgs;
  const probe = orgs.find((o) => o.name === probeName);
  check(Boolean(probe), 'seed probe org exists');
  if (probe) {
    const item = (await orgItems(probe.id)).find((i) => i.id === GSW_ITEM);
    check(item?.enabled === true && item?.doc_id != null,
      'seed step imported the pre-checked package into the new org');
    await disableAll(probe.id);
  }

  // Disabling the check org's selections removes the catalog-owned imports.
  await disableAll(org.id);
  const leftovers = (await json(await fetch(libApi(org.id)))).documents;
  check(leftovers.length === 0,
    `disabling selections cleared the imported documents (got ${leftovers.length})`);
}

console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
