// Story 012-005: token-free browser check that a base_missing pending edit (a
// proposal to CREATE draft/<name>) shows in the topbar pill AND on the draft/
// folder row — a phantom badge while the folder is open, rolled into the
// rollup badge while collapsed, and the two numbers agree.
//   node scripts/phantom-check.mjs   (or: npm run phantom-check)
// Needs backend + webapp dev servers up; seeds one pending edit in projects[0]
// and rejects it in a finally-equivalent cleanup.
import { chromium } from 'playwright';

const BACKEND = 'http://localhost:3002';
const WEBAPP = 'http://localhost:5174';
const PHANTOM = 'draft/phantom-check-new.md';

const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const id = projects[0].id;
const pendingUrl = `${BACKEND}/api/projects/${id}/pending-edits`;

const clear = async () => {
  const { edits } = await (await fetch(pendingUrl)).json();
  for (const e of edits.filter((e) => e.path === PHANTOM)) {
    await fetch(`${pendingUrl}/${e.id}/reject`, { method: 'POST' });
  }
};
await clear();

const res = await fetch(pendingUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: PHANTOM, proposedContent: '# proposed new file\n', agent: 'writer' }),
});
console.log('pending edit created:', res.status);
if (!res.ok) { console.error(await res.text()); process.exit(1); }

const fails = [];
const check = (cond, label) => { console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`); if (!cond) fails.push(label); };

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(WEBAPP);
  await page.waitForSelector('#file-tree summary[data-path="draft"]', { timeout: 15000 });
  await page.waitForTimeout(800); // pending edits + statuses load async

  const pill = await page.locator('#toggle-files .toggle-pill').textContent().catch(() => null);
  check(pill != null && Number(pill) >= 1, `the unseen pill counts the phantom (pill=${pill})`);

  const draftSel = '#file-tree summary[data-path="draft"]';
  const open = (await page.locator(draftSel).getAttribute('aria-expanded')) === 'true';
  if (!open) { await page.locator(draftSel).click(); await page.waitForTimeout(200); }

  const phantomBadge = await page.locator(`${draftSel} .file-badge.is-phantom`).textContent().catch(() => null);
  check(phantomBadge === '1', `an OPEN draft/ shows the phantom badge (got ${phantomBadge})`);

  await page.locator(draftSel).click(); // collapse
  await page.waitForTimeout(200);
  const rollupBadge = await page.locator(`${draftSel} .file-badge.is-rollup`).first().textContent().catch(() => null);
  const pillNow = await page.locator('#toggle-files .toggle-pill').textContent().catch(() => null);
  check(rollupBadge != null && Number(rollupBadge) >= 1, `collapsed draft/ rolls the phantom up (rollup=${rollupBadge})`);
  check(Number(rollupBadge) === Number(pillNow), `rollup and pill agree (${rollupBadge} vs ${pillNow})`);

  const phantomWhileCollapsed = await page.locator(`${draftSel} .file-badge.is-phantom`).count();
  check(phantomWhileCollapsed === 0, 'the standalone phantom badge is not doubled while collapsed');

  await page.locator(draftSel).click(); // restore expanded
} finally {
  await browser.close();
  await clear();
  console.log('cleanup: phantom proposal rejected');
}
console.log(fails.length ? `FAILURES: ${JSON.stringify(fails)}` : 'all good');
process.exit(fails.length ? 1 : 0);
