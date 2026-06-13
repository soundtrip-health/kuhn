// Browser check for the org/project browser + wired breadcrumb (stories
// 005–007). Requires the backend (agent-backend: npm run dev) and the webapp
// (npm run dev) to be running.
//   node scripts/workspace-check.mjs
//
// Drives: bootstrap renders live breadcrumb segments; the project segment opens
// the projects dashboard; the new-project flow creates and switches to a
// project; the org menu lists orgs. The temp project it creates is named
// "Workspace Check Temp" so the caller can clean it up afterward.
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const TEMP_NAME = 'Workspace Check Temp';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(`console: ${msg.text()}`);
});

const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) errors.push(label);
};

await page.goto(WEBAPP);
await page.waitForSelector('#editor .milkdown', { timeout: 15000 });
await page.waitForSelector('#breadcrumb .breadcrumb-project', { timeout: 5000 });
await page.waitForTimeout(800);

// 1. Live breadcrumb segments (story 007)
const orgText = (await page.textContent('#breadcrumb .breadcrumb-org')).trim();
const projText = (await page.textContent('#breadcrumb .breadcrumb-project')).trim();
const docText = (await page.textContent('#breadcrumb .breadcrumb-doc')).trim();
console.log('breadcrumb:', JSON.stringify({ orgText, projText, docText }));
check('org segment is non-empty', orgText.length > 0 && orgText !== 'No organization');
check('project segment is non-empty', projText.length > 0 && projText !== 'Select a project');
check('document segment shows the open file', docText.length > 0 && docText !== 'No document');
check('no hardcoded "Okafor Lab"', !orgText.includes('Okafor'));
check('no hardcoded "Phase 2" pill', !(await page.locator('#breadcrumb').textContent()).includes('Phase'));

// 2. Project segment opens the dashboard (story 006)
await page.click('#breadcrumb .breadcrumb-project');
await page.waitForSelector('#project-browser:not([hidden])', { timeout: 3000 });
const cardCount = await page.locator('.pb-card').count();
check('projects dashboard lists project cards', cardCount >= 1);
check('active project card is marked', (await page.locator('.pb-card.is-active').count()) === 1);

// 3. New-project flow: create and drop into the new project
await page.fill('.pb-input', TEMP_NAME);
await page.selectOption('.pb-select', 'manuscript');
await page.click('.pb-new button[type="submit"]');
await page.waitForSelector('#project-browser', { state: 'hidden', timeout: 5000 });
await page.waitForFunction(
  (name) => document.querySelector('#breadcrumb .breadcrumb-project')?.textContent?.trim() === name,
  TEMP_NAME,
  { timeout: 8000 },
);
check('breadcrumb switches to the new project', true);
await page.waitForTimeout(1200);
check('new project shows the seeding hero (empty doc)',
  (await page.locator('#editor-hero:not([hidden])').count()) === 1);

// 4. Switch back to the first project via the dashboard
await page.click('#breadcrumb .breadcrumb-project');
await page.waitForSelector('#project-browser:not([hidden])', { timeout: 3000 });
await page.locator('.pb-card', { hasText: projText }).first().click();
await page.waitForSelector('#project-browser', { state: 'hidden', timeout: 5000 });
await page.waitForFunction(
  (name) => document.querySelector('#breadcrumb .breadcrumb-project')?.textContent?.trim() === name,
  projText,
  { timeout: 8000 },
);
check('switching back restores the first project', true);

// 5. Org menu lists orgs + create action (story 007)
await page.click('#breadcrumb .breadcrumb-org');
await page.waitForSelector('.breadcrumb-menu', { timeout: 3000 });
const menuItems = await page.locator('.breadcrumb-menu-item').allTextContents();
console.log('org menu:', menuItems);
check('org menu lists at least one org', menuItems.some((t) => t.includes(orgText)));
check('org menu offers creating an organization',
  menuItems.some((t) => /new organization/i.test(t)));

await page.screenshot({ path: '/tmp/kuhn-workspace.png' });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
