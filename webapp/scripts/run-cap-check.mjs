// Issue #113 item 5 (#180): concurrent-run caps. With the per-user cap at 2,
// a third simultaneous run is refused with the documented message, the chat
// shows "2 of 2 runs in use", and no job row is left behind. Token-free:
// the agents are routed to the scripted fake model server, whose replies
// are HELD so two runs stay in flight. Needs a FRESH isolated backend
// started with AGENT_MAX_CONCURRENT_RUNS_PER_USER=2 (dev auth mode, scratch
// data dir) + the webapp dev server pointed at it:
//   BACKEND_URL=http://localhost:3107 WEBAPP_URL=http://localhost:5187 node scripts/run-cap-check.mjs
import { chromium } from 'playwright';
import { createFakeOpenAIServer } from '../../agent-backend/src/agents/conformance/fake-openai-server.js';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';
const CAP = parseInt(process.env.RUN_CAP ?? '2');

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, label) => {
  console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`);
  if (!cond) fail(label);
};
const json = async (res) => res.json();
const MODEL = 'run-cap-check';
const gate = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };
const until = async (fn, label, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(label);
  return false;
};

const fake = createFakeOpenAIServer();
const fakeUrl = await fake.listen();
const say = (text, wait) => ({ kind: 'message', deltas: [text], usage: { input: 20, output: 5 }, ...(wait ? { wait } : {}) });

const org = (await json(await fetch(`${BACKEND}/api/orgs`))).orgs[0];
check(org, 'dev user has an org');
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let projects = (await json(await fetch(`${BACKEND}/api/projects`))).projects;
if (!projects.length) {
  await post(`${BACKEND}/api/projects`, { name: 'Run cap check', orgId: org.id });
  projects = (await json(await fetch(`${BACKEND}/api/projects`))).projects;
}
const project = projects[0];
await fetch(`${BACKEND}/api/orgs/${org.id}/model-profiles/${MODEL}`, { method: 'DELETE' });
const created = await post(`${BACKEND}/api/orgs/${org.id}/model-profiles`, {
  slug: MODEL, name: 'Run-cap fake model', provider: 'openai-compatible', model_id: MODEL,
  base_url: fakeUrl, credential_secret: null, capabilities: { tools: true }, cost_weight: 1,
});
check(created.status === 201, `fake profile created (got ${created.status})`);
const AGENTS = ['pm', 'writer', 'ra', 'advisor'].slice(0, CAP + 1);
for (const agent of AGENTS) {
  const res = await put(`${BACKEND}/api/orgs/${org.id}/model-routes/${agent}`, { routes: [{ profile_slug: MODEL, difficulty: 1 }] });
  check(res.status === 200, `${agent} routed to the fake (got ${res.status})`);
}
const jobs = async () => (await json(await fetch(`${BACKEND}/api/agent/jobs?projectId=${project.id}&limit=50`))).jobs;
let maxJobId = Math.max(0, ...(await jobs()).map((j) => j.id));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));
await page.goto(WEBAPP);
await page.waitForSelector('#chat-input', { timeout: 15000 });
await page.waitForTimeout(600);
if (await page.$('#setup-wizard:visible')) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
const sendTo = async (agent, text) => {
  await page.selectOption('#chat-role', agent);
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
};

// CAP runs in flight (held), then one more.
const gates = AGENTS.slice(0, CAP).map(() => gate());
fake.register(MODEL, [...gates.map((g, i) => say(`Reply ${i}.`, g.promise)), say('Should never run.')]);
for (let i = 0; i < CAP; i++) {
  await sendTo(AGENTS[i], `Task ${i}`);
  check(await until(() => fake.requests.length === i + 1, `request ${i} reached the fake`), `run ${i + 1} (${AGENTS[i]}) in flight`);
}
const extra = AGENTS[CAP];
await sendTo(extra, 'One too many');
const cardSel = '.chat-notice-runcap';
check(await until(async () => Boolean(await page.$(cardSel)), 'run-cap card', 8000), `run ${CAP + 1} (${extra}) refused with the run-cap card`);
const cardText = (await page.textContent(cardSel)) ?? '';
check(cardText.includes(`${CAP} of ${CAP} runs in use`), `card says "${CAP} of ${CAP} runs in use" (${cardText.slice(0, 80)}…)`);
check(cardText.includes(`You already have ${CAP} of ${CAP} runs in progress. Wait for one to finish, or stop it, before starting another.`), 'card carries the documented refusal message');
await page.waitForTimeout(300);
check(fake.requests.length === CAP, `no model request for the refused run (got ${fake.requests.length})`);
check(!(await page.$eval('#chat-form .send-btn', (b) => b.classList.contains('is-stop'))), `${extra} chat is back to Send (no run started)`);
let rows = (await jobs()).filter((j) => j.id > maxJobId);
check(rows.length === CAP && rows.every((j) => j.status === 'running'), `exactly ${CAP} job rows, all running — none for the refused run (${rows.map((j) => `${j.role}:${j.status}`).join(', ')})`);

// Finish one; the refused agent may now run.
gates[0].release();
check(await until(async () => (await jobs()).filter((j) => j.id > maxJobId && j.status === 'done').length === 1, 'first run done'), 'the first run finishes');
fake.register(MODEL, [say('Now it fits.')]);
await sendTo(extra, 'Try again');
check(await until(() => fake.requests.length === CAP + 1, 'request after a slot freed'), 'a slot freed: the next run is accepted');
check(await until(async () => page.$$eval('.chat-agent .chat-body', (els) => els.some((el) => (el.textContent ?? '').includes('Now it fits.'))), 'reply rendered'), 'its reply renders');
for (const g of gates.slice(1)) g.release();
await until(async () => (await jobs()).filter((j) => j.id > maxJobId).every((j) => j.status === 'done'), 'all runs done');

await page.screenshot({ path: '/tmp/kuhn-run-cap-check.png' });
await browser.close();
await fake.close();
if (errors.length) {
  console.log(`\n${errors.length} check(s) failed:`);
  for (const e of errors) console.log(` - ${e}`);
  process.exit(1);
}
console.log('\nrun-cap-check: all checks passed');
