// Issue #111: the org-admin Models tab, scripted. API side: a provider
// credential saved as an org secret. Browser side (owner): the tab lists the
// deployment profiles, the profile form creates an OpenRouter profile bound
// to that secret, Test connection reports a scrubbed failure (no real key
// here), a routing row for the Research Assistant triggers the data-egress
// confirmation and saves with the web-search warning, Revert to default
// clears it, Delete removes the profile. A non-owner (second identity via the
// dev-mode x-kuhn-user header) sees no Models tab.
// Needs the backend + webapp servers (or the single-port build) — no LLM tokens.
//   node scripts/models-check.mjs
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, label) => {
  console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`);
  if (!cond) fail(label);
};
const json = async (res) => res.json();

const ORG_NAME = 'Models Check Org';
const ORG_SLUG = 'models-check-org';
const VIEWER = 'kuhn-models-check-viewer@check.local';
const SECRET = 'openrouter-api-key';
const SECRET_VALUE = 'sk-or-models-check-not-a-real-key';
const PROFILE = 'oss-20b.check';

// --- API: find-or-create the check org (idempotent across runs) ---
const me = (await json(await fetch(`${BACKEND}/api/auth/me`))).user;
let org = (await json(await fetch(`${BACKEND}/api/orgs`))).orgs.find((o) => o.slug === ORG_SLUG);
if (!org) {
  const res = await fetch(`${BACKEND}/api/orgs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: ORG_NAME, slug: ORG_SLUG, ownerEmail: me.email }),
  });
  check(res.status === 201, `create org returns 201 (got ${res.status})`);
  org = (await json(res)).org;
}
const api = (p, init) => fetch(`${BACKEND}/api/orgs/${org.id}${p}`, init);
// Reset from prior runs.
await api(`/model-profiles/${PROFILE}`, { method: 'DELETE' });
await api('/model-routes/ra', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routes: [] }) });
const saved = await api(`/secrets/${SECRET}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: SECRET_VALUE }),
});
check(saved.status === 200, `credential saved as an org secret (got ${saved.status})`);

// --- Browser (owner) ---
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });

await page.goto(WEBAPP);
await page.waitForSelector('.breadcrumb-org', { timeout: 15000 });
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
await page.click('.breadcrumb-org');
await page.click(`.breadcrumb-menu [role="menuitem"]:has-text("${ORG_NAME}")`);
await page.waitForTimeout(600);
await page.keyboard.press('Escape');

await page.click('.breadcrumb-org');
await page.click('.breadcrumb-menu-item.bm-admin');
await page.waitForSelector('#org-admin[role="dialog"]', { timeout: 5000 }).catch(() => fail('org admin overlay opens'));
await page.click('.admin-tab:has-text("Models")');
await page.waitForSelector('#org-admin .admin-table', { timeout: 8000 }).catch(() => fail('Models tab renders the profile table'));

// Deployment profiles are listed read-only.
const rows = await page.$$eval('#org-admin .admin-table tbody tr', (trs) => trs.map((tr) => tr.textContent));
check(rows.some((t) => t.includes('deployment') && t.includes('Anthropic')), 'deployment Anthropic profiles are listed');
check(!rows.some((t) => t.includes('deployment') && t.includes('Edit')), 'deployment profiles have no Edit button');
check(rows.every((t) => !t.includes(SECRET_VALUE)), 'no secret value anywhere in the table');

// Open the form from a scrolled position: the body must not jump to the top.
await page.evaluate(() => { const b = document.querySelector('#org-admin .admin-body'); if (b) b.scrollTop = b.scrollHeight; });
const scrolledBefore = await page.evaluate(() => document.querySelector('#org-admin .admin-body')?.scrollTop ?? 0);
await page.click('#org-admin button:has-text("Add profile")');
const scrolledAfter = await page.evaluate(() => document.querySelector('#org-admin .admin-body')?.scrollTop ?? 0);
check(scrolledBefore > 0 && scrolledAfter > 0, `body does not jump to the top on a re-render (${scrolledBefore} → ${scrolledAfter}; the click scrolls the button into view first)`);

// Submitting an incomplete form shows real messages and keeps what was typed.
await page.selectOption('#org-admin [aria-label="Provider"]', 'openrouter');
// Type the model id slowly enough for the catalog lookup to fire mid-word:
// the re-render it triggers must leave focus and the caret in the box.
await page.click('#org-admin [aria-label="Model id"]');
for (const ch of 'openai/gpt-oss-20b') await page.keyboard.type(ch, { delay: 120 });
await page.waitForTimeout(600); // last catalog lookup
const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
check(focused === 'Model id', `typing keeps focus in the model id box (${focused})`);
check((await page.inputValue('#org-admin [aria-label="Model id"]')) === 'openai/gpt-oss-20b', 'every typed character landed');
const derivedSlug = await page.inputValue('#org-admin [aria-label="Profile slug"]');
check(derivedSlug === 'openai-gpt-oss-20b', `slug is derived from the model id (${derivedSlug})`);
const catalogHelp = await page.textContent('#org-admin .admin-profile-form');
check(catalogHelp.includes('Published values'), 'catalog lookup fills the published limits for a known model');
await page.click('#org-admin button:has-text("Create profile")');
const fieldErrors = await page.$$eval('#org-admin .admin-field-error', (els) => els.map((e) => e.textContent));
// The catalog filled the display name in, so the credential is what's missing.
check(fieldErrors.length >= 1 && fieldErrors.some((t) => /API key/.test(t)),
  `client-side validation names the missing field (${fieldErrors.join(' | ')})`);
const nameFilled = await page.inputValue('#org-admin [aria-label="Profile name"]');
check(nameFilled.length > 0, `catalog lookup suggests a display name (${nameFilled})`);
check((await page.inputValue('#org-admin [aria-label="Model id"]')) === 'openai/gpt-oss-20b', 'a rejected submit keeps the typed values');

// Now fill it in properly, with a dotted slug.
await page.fill('#org-admin [aria-label="Profile slug"]', PROFILE);
await page.fill('#org-admin [aria-label="Profile name"]', 'OSS 20B (check)');
await page.selectOption('#org-admin [aria-label="Credential secret"]', SECRET);
await page.fill('#org-admin [aria-label="Cost weight"]', '0.5');
const egressHint = await page.textContent('#org-admin .admin-profile-form .admin-setting-hint');
check(egressHint.includes('openrouter.ai') && egressHint.includes(SECRET), 'form states the destination host and credential');
await page.click('#org-admin button:has-text("Create profile")');
await page.waitForSelector(`#org-admin .admin-table tbody tr:has-text("${PROFILE}")`, { timeout: 8000 }).catch(() => fail('new profile appears in the table'));
const created = await (await api('/model-profiles')).json();
const row = created.profiles.find((p) => p.slug === PROFILE);
check(row?.provider === 'openrouter' && row?.credential?.secret === SECRET && row?.cost_weight === 0.5, 'profile persisted with the credential reference');

// Test connection: no real key, so a scrubbed failure.
await page.click(`#org-admin .admin-table tbody tr:has-text("${PROFILE}") button:has-text("Test")`);
await page.waitForSelector(`#org-admin .admin-table tbody tr:has-text("${PROFILE}") .admin-test-result[data-state]`, { timeout: 40000 }).catch(() => fail('test result renders'));
const testText = await page.textContent(`#org-admin .admin-table tbody tr:has-text("${PROFILE}") .admin-test-result`);
check(testText.startsWith('Failed:'), `test reports a failure without a real key (${testText.slice(0, 60)})`);
check(!testText.includes(SECRET_VALUE), 'test output never contains the secret value');

// Route the RA to the new profile: egress confirmation, then the warning.
const ra = page.locator('#org-admin .admin-route', { hasText: 'Research Assistant' });
await ra.locator('button:has-text("Add row")').click();
await ra.locator('select').first().selectOption(PROFILE);
await ra.locator('input[type="number"]').first().fill('0.4');
await ra.locator('input[type="number"]').first().dispatchEvent('change');
dialogs.length = 0;
await ra.locator('button:has-text("Save")').click();
await page.waitForTimeout(1500);
check(dialogs.some((m) => m.includes('openrouter.ai')), 'saving a route to a new host asks for confirmation naming the host');
await page.waitForSelector('#org-admin .admin-route-warning', { timeout: 8000 }).catch(() => fail('web-search degradation warning renders'));
const routes = (await (await api('/model-routes')).json()).agents.find((a) => a.slug === 'ra');
check(routes.routes.length === 1 && routes.routes[0].profile_slug === PROFILE && routes.routes[0].difficulty === 0.4, 'route persisted with its difficulty');

// Revert to default clears the routes.
await ra.locator('button:has-text("Revert to default")').click();
await page.waitForTimeout(1200);
const reverted = (await (await api('/model-routes')).json()).agents.find((a) => a.slug === 'ra');
check(reverted.routes.length === 0, 'Revert to default removes the routes');

// Delete the profile.
await page.click(`#org-admin .admin-table tbody tr:has-text("${PROFILE}") button:has-text("Delete")`);
await page.waitForTimeout(1200);
const after = await (await api('/model-profiles')).json();
check(!after.profiles.some((p) => p.slug === PROFILE), 'Delete removes the profile');
await page.close();

// --- Non-owner: no Models tab. A second dev identity auto-joins the default
// org as editor; org admin there shows only the member tabs.
const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-kuhn-user': VIEWER } });
const vp = await ctx.newPage();
vp.on('dialog', (d) => void d.accept());
await vp.goto(WEBAPP);
await vp.waitForSelector('.breadcrumb-org', { timeout: 15000 });
await vp.waitForTimeout(800);
await vp.keyboard.press('Escape');
await vp.click('.breadcrumb-org');
check((await vp.locator('.breadcrumb-menu-item.bm-admin').count()) === 0, 'non-owner org menu has no admin entry');
await vp.click('.breadcrumb-menu-item.bm-knowledge');
await vp.waitForSelector('#org-admin .admin-tab', { timeout: 8000 }).catch(() => fail('non-owner org view opens'));
const tabs = await vp.$$eval('#org-admin .admin-tab', (b) => b.map((x) => x.textContent));
check(tabs.length > 0 && !tabs.some((t) => t.includes('Models')), `non-owner sees no Models tab (${tabs.join(', ')})`);
const defaultOrg = (await json(await fetch(`${BACKEND}/api/orgs`, { headers: { 'x-kuhn-user': VIEWER } }))).orgs[0];
const forbidden = await fetch(`${BACKEND}/api/orgs/${defaultOrg.id}/model-profiles`, { headers: { 'x-kuhn-user': VIEWER } });
check(forbidden.status === 403, `editor gets 403 on the profiles API (got ${forbidden.status})`);
await browser.close();

if (errors.length) {
  console.error(`\n${errors.length} failure(s):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log('\nmodels-check: all good');
