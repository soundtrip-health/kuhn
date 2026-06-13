// Browser check for story 016: slash menu → /cite picker → citation chip →
// markdown round-trip. Citation endpoints are intercepted with canned
// responses, so this needs no PubMed network access and no LLM tokens —
// only the backend (agent-backend: npm run dev) and webapp (npm run dev).
//   node scripts/cite-check.mjs
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const CANDIDATES = [
  {
    pmid: '37952131',
    title: 'Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes.',
    authors: ['Lincoff AM', 'Brown-Frandsen K', 'Colhoun HM', 'Deanfield J'],
    journal: 'The New England journal of medicine',
    year: '2023',
    doi: '10.1056/NEJMoa2307563',
  },
  {
    pmid: '27633186',
    title: 'Semaglutide and Cardiovascular Outcomes in Patients with Type 2 Diabetes.',
    authors: ['Marso SP', 'Bain SC'],
    journal: 'The New England journal of medicine',
    year: '2016',
    doi: '10.1056/NEJMoa1607141',
  },
];

const CANNED_BIB = `@article{lincoff2023,
  author = {Lincoff, A Michael and Brown-Frandsen, Kirstine},
  title = {Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes},
  journal = {The New England journal of medicine},
  year = {2023},
  pmid = {37952131}
}
`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const fail = (msg) => errors.push(msg);
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));

// Intercept the citation service and the bibliography read with canned data
await page.route('**/citations/search**', (route) =>
  route.fulfill({ json: { candidates: CANDIDATES } }),
);
await page.route('**/citations', (route) =>
  route.request().method() === 'POST'
    ? route.fulfill({ status: 201, json: { key: 'lincoff2023', created: true, path: 'draft/references.bib' } })
    : route.continue(),
);
await page.route('**/file?path=draft%2Freferences.bib*', (route) =>
  route.request().method() === 'GET'
    ? route.fulfill({ body: CANNED_BIB, contentType: 'text/plain; charset=utf-8' })
    : route.continue(),
);

const projects = (await (await fetch(`${BACKEND}/api/projects`)).json()).projects;
const projectId = projects[0].id;
const docUrl = `${BACKEND}/api/projects/${projectId}/file?path=${encodeURIComponent('draft/main.md')}`;

await page.goto(WEBAPP);
await page.waitForSelector('#editor .milkdown', { timeout: 15000 });
await page.waitForTimeout(1500);

// --- Slash menu (Crepe unified block-edit menu, story 003) ---
// Crepe only opens the menu when the block text starts with "/", so clear the
// doc to a single empty block first, then type "/ci" to filter to the Cite
// agent command.
await page.click('#editor .milkdown [contenteditable]');
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.press('Delete');
await page.waitForTimeout(150);
await page.keyboard.type('/');
await page.waitForSelector('.milkdown-slash-menu[data-show="true"]', { timeout: 5000 })
  .catch(() => fail('slash menu did not open on "/"'));
await page.keyboard.type('ci'); // filter
await page.waitForTimeout(400); // provider debounce
const itemText = await page.textContent('.milkdown-slash-menu').catch(() => null);
if (!/Cite/.test(itemText ?? '')) fail(`expected Cite in the filtered menu, got ${itemText}`);
console.log('slash menu filtered to Cite agent command');

// --- Picker: select /cite, search, choose a candidate ---
await page.keyboard.press('Enter');
await page.waitForSelector('.cite-picker .cite-input', { timeout: 5000 })
  .catch(() => fail('picker did not open after selecting /cite'));
// The typed "/ci" must be consumed from the document
const editorText = await page.textContent('#editor .milkdown');
if (editorText.includes('/ci')) fail('slash text was not removed from the document');

await page.keyboard.type('semaglutide obesity');
await page.waitForSelector('.cite-candidate', { timeout: 5000 })
  .catch(() => fail('no candidates rendered in picker'));
console.log('candidates:', await page.locator('.cite-candidate').count());
console.log('status:', await page.textContent('.cite-status'));

await page.keyboard.press('Enter'); // pick the first (active) candidate
await page.waitForSelector('.citation-chip[data-citation-key="lincoff2023"]', { timeout: 5000 })
  .catch(() => fail('citation chip did not appear after picking'));
if ((await page.locator('.cite-picker').count()) !== 0) fail('picker did not close after picking');

// --- Markdown round-trip: serialized doc contains plain [@key] ---
let serialized = '';
for (let i = 0; i < 30; i++) {
  await new Promise((ok) => setTimeout(ok, 500));
  serialized = await (await fetch(docUrl)).text();
  if (serialized.includes('[@lincoff2023]')) break;
}
console.log('serialized [@lincoff2023]:', serialized.includes('[@lincoff2023]'));
if (!serialized.includes('[@lincoff2023]')) fail('saved markdown does not contain [@lincoff2023]');
if (serialized.includes('\\[@lincoff2023]')) fail('citation was escaped in markdown output');

// --- Parse side: reload renders the plain-text [@key] as a chip ---
await page.reload();
await page.waitForSelector('#editor .milkdown', { timeout: 15000 });
await page.waitForTimeout(1500);
const chipsAfterReload = await page.locator('.citation-chip[data-citation-key="lincoff2023"]').count();
console.log('chip after reload:', chipsAfterReload > 0);
if (chipsAfterReload === 0) fail('[@key] in markdown source did not render as a chip on load');

// --- Hover tooltip resolves the reference from the bib ---
await page.hover('.citation-chip[data-citation-key="lincoff2023"]');
await page.waitForTimeout(200);
const title = await page.getAttribute('.citation-chip[data-citation-key="lincoff2023"]', 'title');
console.log('tooltip:', title);
if (!title?.includes('Lincoff')) fail(`tooltip did not resolve the reference: ${title}`);

await page.screenshot({ path: '/tmp/kuhn-cite-check.png' });

console.log('errors:', errors.length ? errors : 'none');
await browser.close();

// Strip the inserted test citation from the document. This must happen after
// the browser closes: a connected client would sync the old Yjs room state
// right back over the file (rooms are dropped 30s after the last client).
const finalDoc = await (await fetch(docUrl)).text();
const cleaned = finalDoc
  .split('\n')
  .filter((line) => line.trim() !== '[@lincoff2023]' && line.trim() !== '* [@lincoff2023]')
  .join('\n')
  .replace(/\n{3,}/g, '\n\n');
if (cleaned !== finalDoc && cleaned.trim().length > 0) {
  await fetch(docUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: cleaned });
}

if (errors.length) process.exit(1);
