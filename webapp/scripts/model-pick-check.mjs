// Issue #134: the composer's model pill — which model powers the agent the
// user addresses. Token-free: two org profiles for the PM point at the
// conformance fake OpenAI-compatible server under different model ids, so the
// fake's request log shows which one each turn actually hit. Needs a FRESH
// isolated backend (dev auth mode, scratch data dir; uses projects[0]) + the
// webapp dev server pointed at it.
//   BACKEND_URL=http://localhost:3105 WEBAPP_URL=http://localhost:5185 node scripts/model-pick-check.mjs
import { chromium } from 'playwright';
import { createFakeOpenAIServer } from '../../agent-backend/src/agents/conformance/fake-openai-server.js';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';
const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, label) => { console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`); if (!cond) fail(label); };
const json = async (res) => res.json();
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const say = (text) => ({ kind: 'message', deltas: [text], usage: { input: 10, output: 3 } });

const fake = createFakeOpenAIServer();
const fakeUrl = await fake.listen();
fake.register('pick-a', [say('A here.'), say('A again.'), say('A third.')]);
fake.register('pick-b', [say('B here.'), say('B again.'), say('B third.')]);

const org = (await json(await fetch(`${BACKEND}/api/orgs`))).orgs[0];
let projects = (await json(await fetch(`${BACKEND}/api/projects`))).projects;
if (!projects.length) {
  await post(`${BACKEND}/api/projects`, { name: 'Model pick check', orgId: org.id });
  projects = (await json(await fetch(`${BACKEND}/api/projects`))).projects;
}
const project = projects[0];
const orgApi = `${BACKEND}/api/orgs/${org.id}`;
for (const slug of ['pick-a', 'pick-b']) {
  await fetch(`${orgApi}/model-profiles/${slug}`, { method: 'DELETE' });
  const res = await post(`${orgApi}/model-profiles`, {
    slug, name: `Pick ${slug.slice(-1).toUpperCase()}`, provider: 'openai-compatible', model_id: slug,
    base_url: fakeUrl, credential_secret: null, capabilities: { tools: true }, cost_weight: slug === 'pick-a' ? 0.5 : 2,
  });
  check(res.status === 201, `profile ${slug} created (got ${res.status})`);
}
check((await put(`${orgApi}/model-routes/pm`, { routes: [{ profile_slug: 'pick-a', difficulty: 0.5 }, { profile_slug: 'pick-b', difficulty: 1 }] })).status === 200, 'PM routed to A (≤0.5) and B (≤1)');
check((await put(`${orgApi}/model-routes/ra`, { routes: [] })).status === 200, 'RA left on its single default');

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));
await page.goto(WEBAPP);
await page.waitForSelector('#chat-input', { timeout: 15000 });
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('kuhn-model-pick')) localStorage.removeItem(k); });
await page.reload();
await page.waitForSelector('#chat-input', { timeout: 15000 });
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
const pillVisible = () => page.$eval('#model-picker', (el) => !el.hidden).catch(() => false);
const pillText = () => page.textContent('#model-picker .model-pill-label').catch(() => null);
const pinned = () => page.$eval('#model-picker .model-pill', (el) => el.classList.contains('is-pinned')).catch(() => false);
// The native #chat-role select is visually hidden behind the agent pill;
// drive it the way the pill does (value + change event).
const setRole = (slug) => page.evaluate((v) => {
  const el = document.getElementById('chat-role');
  el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, slug);
const send = async (text) => {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
  await page.waitForFunction(() => (document.getElementById('status-agent')?.textContent ?? '') === '' && !document.querySelector('#chat-form .send-btn.is-stop'), null, { timeout: 20000 });
};

await setRole('pm');
await page.waitForFunction(() => !document.getElementById('model-picker')?.hidden, null, { timeout: 8000 }).catch(() => fail('model pill appears for the PM'));
check(await pillVisible(), 'model pill shown: the PM has two routed models');
check((await pillText()) === 'pick-b', `pill shows the route default (strongest) unpinned: ${await pillText()}`);
check(!(await pinned()), 'pill is not marked pinned by default');

// Pick A from the menu.
await page.click('#model-picker .model-pill');
const optionTexts = await page.$$eval('#model-picker .model-option', (els) => els.map((e) => e.textContent));
check(optionTexts.length === 3 && /Route default/.test(optionTexts[0]) && /Pick A/.test(optionTexts[1]) && /Pick B/.test(optionTexts[2]), `menu lists Route default + the two profiles (${optionTexts.length})`);
await page.click('#model-picker .model-option:has-text("Pick A")');
check((await pillText()) === 'pick-a' && (await pinned()), 'pill shows A and is marked pinned');
await send('Hello with A.');
check(fake.requests.at(-1)?.model === 'pick-a', `the turn ran on A (${fake.requests.at(-1)?.model})`);
await page.waitForSelector('.chat-agent .chat-body:has-text("A here.")', { timeout: 5000 }).catch(() => fail('A\'s reply rendered'));
check(/^PM · pick-a/.test((await page.textContent('#status-model')) ?? ''), `status chip names A (${await page.textContent('#status-model')})`);
check(/chosen by you/.test((await page.getAttribute('#status-model', 'title')) ?? ''), 'chip tooltip says the model was chosen by the user');

// The pick survives a reload and is per agent: the RA (one model) shows no pill.
await page.reload();
await page.waitForSelector('#chat-input', { timeout: 15000 });
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.getElementById('model-picker')?.hidden, null, { timeout: 8000 }).catch(() => fail('pill re-appears after reload'));
check((await pillText()) === 'pick-a' && (await pinned()), 'pin persists across a reload');
await setRole('ra');
await page.waitForFunction(() => document.getElementById('model-picker')?.hidden, null, { timeout: 8000 }).catch(() => fail('pill hides for the RA'));
check(!(await pillVisible()), 'no pill for an agent with a single routed model');
await setRole('pm');
await page.waitForFunction(() => !document.getElementById('model-picker')?.hidden, null, { timeout: 8000 });

// Back to the route default → B.
await page.click('#model-picker .model-pill');
await page.click('#model-picker .model-option:has-text("Route default")');
check((await pillText()) === 'pick-b' && !(await pinned()), 'Route default restores B, unpinned');
await send('Hello with default.');
check(fake.requests.at(-1)?.model === 'pick-b', `the turn ran on B (${fake.requests.at(-1)?.model})`);

// A pin the owner has since removed from the route is refused, and the pin is dropped.
await page.click('#model-picker .model-pill');
await page.click('#model-picker .model-option:has-text("Pick A")');
check((await put(`${orgApi}/model-routes/pm`, { routes: [{ profile_slug: 'pick-b', difficulty: 1 }] })).status === 200, 'owner removes A from the PM route');
const before = fake.requests.length;
await send('Hello with a stale pin.');
await page.waitForSelector('.chat-system.chat-system-error:has-text("not one of the models configured")', { timeout: 8000 }).catch(() => fail('route_invalid line shown for the stale pin'));
check(fake.requests.length === before, 'no model request was made for the refused pin');
check((await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kuhn-model-pick')).length)) === 0, 'the stale pin was cleared');
await page.waitForFunction(() => document.getElementById('model-picker')?.hidden, null, { timeout: 8000 }).catch(() => fail('pill hides once only one model is routed'));

await page.screenshot({ path: '/tmp/kuhn-model-pick.png' });
await browser.close();
await fake.close();
if (errors.length) { console.log(`\n${errors.length} check(s) failed:`); for (const e of errors) console.log(` - ${e}`); process.exit(1); }
console.log('\nmodel-pick-check: all checks passed');
