// Issue #113 items 2–4 (#177, #178, #179): parallel chats. Runs are per chat
// (project + agent) and survive a project switch; the composer, Stop and the
// status bar follow the chat in view; a reload re-attaches to the runs the
// server kept alive; the project browser and the agent pill carry status
// marks (ring = running, dot = waiting on you) fed by the org activity feed;
// a top-bar "Waiting for you" marker (and a ● title prefix) jumps to a chat
// waiting on the user wherever it is. Token-free: the PM, RA and Writer are routed to the scripted
// OpenAI-compatible fake server, whose replies can be HELD until the check
// releases them, so a run stays in flight exactly as long as the scenario
// needs. Needs a FRESH isolated backend (dev auth mode, scratch data dir) +
// the webapp dev server pointed at it:
//   BACKEND_URL=http://localhost:3107 WEBAPP_URL=http://localhost:5187 node scripts/parallel-check.mjs
import { chromium } from 'playwright';
import { createFakeOpenAIServer } from '../../agent-backend/src/agents/conformance/fake-openai-server.js';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, label) => {
  console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`);
  if (!cond) fail(label);
};
const json = async (res) => res.json();
const MODEL = 'parallel-check';
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

// --- Fake model server: one script per request in arrival order ---
const fake = createFakeOpenAIServer();
const fakeUrl = await fake.listen();
const say = (text, wait) => ({ kind: 'message', deltas: text.split(' ').map((w, i) => (i ? ` ${w}` : w)), usage: { input: 20, output: 5 }, ...(wait ? { wait } : {}) });
const dispatchRa = (wait) => ({
  kind: 'message', usage: { input: 10, output: 5 },
  toolCalls: [{ id: 'call_ra', name: 'dispatch_agent', args: { agent_slug: 'ra', task: 'Find papers.', difficulty: 0.3 } }],
  ...(wait ? { wait } : {}),
});

// --- API: two projects, three agents routed to the fake ---
const org = (await json(await fetch(`${BACKEND}/api/orgs`))).orgs[0];
check(org, 'dev user has an org');
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const stamp = Date.now().toString(36);
const mkProject = async (name) => {
  const res = await post(`${BACKEND}/api/projects`, { name, orgId: org.id });
  check(res.status === 201, `project "${name}" created (got ${res.status})`);
  return (await json(res)).project ?? (await json(await fetch(`${BACKEND}/api/projects`))).projects.find((p) => p.name === name);
};
const A = await mkProject(`Parallel A ${stamp}`);
const B = await mkProject(`Parallel B ${stamp}`);
await fetch(`${BACKEND}/api/orgs/${org.id}/model-profiles/${MODEL}`, { method: 'DELETE' });
const created = await post(`${BACKEND}/api/orgs/${org.id}/model-profiles`, {
  slug: MODEL, name: 'Parallel-check fake model', provider: 'openai-compatible', model_id: MODEL,
  base_url: fakeUrl, credential_secret: null, capabilities: { tools: true }, cost_weight: 1,
});
check(created.status === 201, `fake profile created (got ${created.status})`);
for (const agent of ['pm', 'ra', 'writer']) {
  const res = await put(`${BACKEND}/api/orgs/${org.id}/model-routes/${agent}`, { routes: [{ profile_slug: MODEL, difficulty: 1 }] });
  check(res.status === 200, `${agent} routed to the fake (got ${res.status})`);
}
const jobsOf = async (projectId) => (await json(await fetch(`${BACKEND}/api/agent/jobs?projectId=${projectId}&limit=50`))).jobs;

// --- Browser ---
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));
await page.goto(WEBAPP);
await page.waitForSelector('#chat-input', { timeout: 15000 });
await page.waitForTimeout(500);

const dismissWizard = async () => {
  await page.waitForTimeout(400);
  if (await page.$('#setup-wizard:visible')) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
};
const switchTo = async (project) => {
  await page.click('.breadcrumb-project');
  await page.waitForSelector('#project-browser:not([hidden])', { timeout: 5000 });
  await page.click(`.pb-card:has(.pb-card-name:text-is("${project.name}"))`);
  await page.waitForFunction((n) => (document.querySelector('.breadcrumb-project')?.textContent ?? '').includes(n), project.name, { timeout: 10000 });
  await dismissWizard();
  await page.waitForTimeout(600); // transcript restore
};
const statusAgent = async () => (await page.textContent('#status-agent')) ?? '';
const sendIsStop = () => page.$eval('#chat-form .send-btn', (b) => b.classList.contains('is-stop'));
const logText = async () => (await page.textContent('#chat-log')) ?? '';
const bubbles = (text) => page.$$eval('.chat-agent .chat-body', (els, t) => els.filter((el) => (el.textContent ?? '').includes(t)).length, text);
const sendTo = async (agent, text) => {
  await page.selectOption('#chat-role', agent);
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
};
const requestCount = () => fake.requests.length;
// Status marks (issue #113 item 3): the project browser's card for a project,
// and the agent pill, carry `.chat-mark.is-running` / `.is-waiting`.
const cardMark = async (project) => {
  await page.click('.breadcrumb-project');
  await page.waitForSelector('#project-browser:not([hidden])', { timeout: 5000 });
  const mark = await page.$eval(`.pb-card:has(.pb-card-name:text-is("${project.name}"))`, (card) => card.querySelector('.chat-mark')?.className ?? '');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#project-browser[hidden]', { timeout: 5000 }).catch(() => {});
  return mark;
};
const pillMark = () => page.$eval('#agent-selector-btn', (b) => b.querySelector('.chat-mark')?.className ?? '');
const waitMark = (fn, re, label) => until(async () => re.test(await fn()), label, 8000);

await switchTo(A);
check((await logText()).length >= 0, 'project A open');

// --- Scenario 1: a run survives switching projects and completes in the background ---
const g1 = gate();
fake.register(MODEL, [dispatchRa(g1.promise), say('RA found it.'), say('Done in A.')]);
let n = requestCount();
await sendTo('pm', 'Go A');
check(await until(() => requestCount() === n + 1, 'PM request reached the fake'), 'A: PM run started');
check(/^PM is working/.test(await statusAgent()), `A: status shows the PM working (${await statusAgent()})`);
check(await sendIsStop(), 'A: send button is Stop');

check(await waitMark(pillMark, /is-running/, 'pill mark while the PM runs'), 'A: the agent pill shows the running mark for the PM');
await switchTo(B);
check((await statusAgent()) === '', `B: status bar is empty — the run is A's (${await statusAgent()})`);
check(!(await sendIsStop()), 'B: send button is Send');
check(!(await logText()).includes('Go A'), 'B: A\'s message is not in B\'s log');
check(await waitMark(() => cardMark(A), /is-running/, 'ring on A from B'), 'B: the project browser shows the ring on A');
check(!/chat-mark/.test(await cardMark(B)), 'B: no mark on B (nothing running there)');
check((await pillMark()) === '', 'B: no mark on the agent pill (the PM is idle here)');
g1.release();
check(await until(() => requestCount() === n + 3, 'RA and final PM requests arrived'), 'A\'s run continued in the background (RA dispatched, PM finished)');
await page.waitForTimeout(500);
check(!(await logText()).includes('Done in A.'), 'B: A\'s reply did not leak into B\'s log');
check((await statusAgent()) === '', 'B: status bar still empty after A finished');
check(await waitMark(() => cardMark(A), /^$/, 'ring clears on A'), 'B: the ring on A clears when the run ends');

await switchTo(A);
check((await logText()).includes('Go A'), 'A: the user message is in the log');
check((await bubbles('RA found it.')) === 1, 'A: the RA\'s reply rendered while A was out of view');
check((await bubbles('Done in A.')) === 1, 'A: the PM\'s final reply rendered while A was out of view');
check(!(await sendIsStop()), 'A: send button is Send again (the run finished)');
let jobs = await jobsOf(A.id);
check(jobs.find((j) => j.role === 'pm')?.status === 'done' && jobs.find((j) => j.role === 'ra')?.status === 'done', `A: PM and RA jobs done (${jobs.map((j) => `${j.role}:${j.status}`).join(', ')})`);

// --- Scenario 2: come back while the run is still streaming ---
const g2 = gate();
fake.register(MODEL, [say('Back in A.', g2.promise)]);
n = requestCount();
await sendTo('pm', 'Go A2');
await until(() => requestCount() === n + 1, 'second PM request reached the fake');
await switchTo(B);
await switchTo(A);
await page.selectOption('#chat-role', 'pm');
check(/^PM is working/.test(await statusAgent()), `A: returning mid-run shows the PM working (${await statusAgent()})`);
check(await sendIsStop(), 'A: Stop is back for the in-flight run');
g2.release();
check(await until(async () => (await bubbles('Back in A.')) === 1, 'reply rendered after returning'), 'A: the reply streams into the log after returning');
check(await until(async () => (await statusAgent()) === '', 'status clears'), 'A: status clears when the run ends');

// --- Scenario 3: two active chats (PM and Writer) in one project, each with its own Stop ---
const g3 = gate();
const g4 = gate();
fake.register(MODEL, [say('PM never gets here.', g3.promise), say('Writer done.', g4.promise)]);
n = requestCount();
await sendTo('pm', 'PM task');
await until(() => requestCount() === n + 1, 'PM request (scenario 3)');
await sendTo('writer', 'Writer task');
await until(() => requestCount() === n + 2, 'Writer request (scenario 3)');
check(await sendIsStop(), 'writer chat in view: Stop');
check(/^Writer is working/.test(await statusAgent()), `writer chat in view: status follows the Writer (${await statusAgent()})`);
await page.selectOption('#chat-role', 'pm');
check(await sendIsStop(), 'pm chat in view: Stop');
check(/^PM is working/.test(await statusAgent()), `pm chat in view: status follows the PM (${await statusAgent()})`);
await page.selectOption('#chat-role', 'ra');
check(!(await sendIsStop()), 'ra chat in view: Send (no run for the RA)');
check((await statusAgent()) === '', 'ra chat in view: no activity');
await page.selectOption('#chat-role', 'pm');
await page.click('#chat-form .send-btn.is-stop');
check(await until(async () => (await logText()).includes('PM stopped.'), 'PM stopped line'), 'stopping the PM chat stops only the PM');
await page.selectOption('#chat-role', 'writer');
check(await sendIsStop(), 'writer chat still running after the PM stop');
check(/^Writer is working/.test(await statusAgent()), 'writer status intact after the PM stop');
g3.release(); // the PM's held request was aborted server-side; releasing is a no-op
g4.release();
check(await until(async () => (await bubbles('Writer done.')) === 1, 'writer reply'), 'the Writer\'s reply renders');
check(await until(async () => !(await sendIsStop()), 'writer send restored'), 'writer chat back to Send');
jobs = (await jobsOf(A.id)).filter((j) => j.input === 'PM task' || j.input === 'Writer task');
check(jobs.find((j) => j.role === 'pm')?.status === 'cancelled' && jobs.find((j) => j.role === 'writer')?.status === 'done', `jobs: PM cancelled, Writer done (${jobs.map((j) => `${j.role}:${j.status}`).join(', ')})`);

// --- Scenario 4: a reload re-attaches to the run the server kept alive ---
const g5 = gate();
fake.register(MODEL, [say('After reload.', g5.promise)]);
n = requestCount();
await sendTo('pm', 'Reload me');
await until(() => requestCount() === n + 1, 'PM request (scenario 4)');
await page.reload();
await page.waitForSelector('#chat-input', { timeout: 15000 });
await dismissWizard();
await page.selectOption('#chat-role', 'pm');
check(await waitMark(pillMark, /is-running/, 'pill mark after reload'), 'after reload: the agent pill shows the running mark (feed snapshot)');
check(await waitMark(() => cardMark(A), /is-running/, 'card mark after reload'), 'after reload: the project browser shows the ring on A');
check(await until(async () => /^PM is working/.test(await statusAgent()), 'reconnected status', 10000), `after reload: re-attached to the live run (${await statusAgent()})`);
check(await sendIsStop(), 'after reload: Stop addresses the re-attached run');
g5.release();
check(await until(async () => (await bubbles('After reload.')) === 1, 'reply after reload'), 'after reload: the reply streams in exactly once');
check(await until(async () => (await statusAgent()) === '', 'status clears after reload run'), 'after reload: status clears when the run ends');
check((await page.$$eval('.chat-user .chat-body', (els) => els.filter((el) => (el.textContent ?? '').includes('Reload me')).length)) === 1, 'after reload: the user message appears once (restored transcript)');
jobs = (await jobsOf(A.id)).filter((j) => j.input === 'Reload me');
check(jobs[0]?.status === 'done', `after reload: the job finished normally (${jobs[0]?.status})`);

// --- Scenario 5: a question asked while the user is in another project waits for them ---
const g6 = gate();
fake.register(MODEL, [
  { kind: 'message', usage: { input: 10, output: 5 }, toolCalls: [{ id: 'call_q', name: 'ask_user', args: { question: 'Which journal?' } }], wait: g6.promise },
  say('Thanks, noted.'),
]);
n = requestCount();
await sendTo('pm', 'Ask me something');
await until(() => requestCount() === n + 1, 'PM request (scenario 5)');
await switchTo(B);
g6.release();
await page.waitForTimeout(800);
check((await statusAgent()) === '', 'B: the question in A does not touch B\'s composer');
check(!(await page.$('.question-card')), 'B: no question card in B\'s log');
check(await waitMark(() => cardMark(A), /is-waiting/, 'waiting dot on A'), 'B: the project browser shows the waiting dot on A');
// Issue #113 item 4: the top-bar marker appears within a second, the title
// gains the badge, and clicking the marker lands on the question card.
check(await until(async () => !(await page.$eval('#topbar-waiting', (el) => el.hidden)), 'top-bar marker', 1500), 'B: the "Waiting for you" marker appears in the top bar within a second');
check((await page.title()).startsWith('●'), `B: the document title carries the ● badge (${await page.title()})`);
check(/PM in Parallel A/.test(await page.$eval('#topbar-waiting', (el) => el.title)), `B: the marker names the chat (${await page.$eval('#topbar-waiting', (el) => el.title)})`);
await page.click('#topbar-waiting');
await page.waitForFunction((n) => (document.querySelector('.breadcrumb-project')?.textContent ?? '').includes(n), A.name, { timeout: 10000 });
await dismissWizard();
check((await page.$eval('#chat-role', (el) => el.value)) === 'pm', 'marker click: the PM chat is selected');
check(await until(async () => page.$eval('.question-card.is-pending', (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }).catch(() => false), 'question card in view', 10000), 'marker click: the question card is scrolled into view');
check(await waitMark(pillMark, /is-waiting/, 'pill waiting mark'), 'A: the agent pill shows the waiting dot for the PM');
await page.selectOption('#chat-role', 'pm');
check(await until(async () => Boolean(await page.$('.question-card.is-pending')), 'question card in A'), 'A: the question card is there');
check(/waiting for your answer/.test(await statusAgent()), `A: status says the PM is waiting (${await statusAgent()})`);
check((await page.$eval('#chat-input', (el) => el.placeholder)).includes('answer'), 'A: composer is in answer mode');
await page.fill('#chat-input', 'JAMA');
await page.press('#chat-input', 'Enter');
check(await until(async () => (await bubbles('Thanks, noted.')) === 1, 'answer delivered'), 'A: the answer reaches the parked run and it finishes');
check(await waitMark(pillMark, /^$/, 'pill mark clears'), 'A: the agent pill mark clears once the run ends');
check(await until(async () => page.$eval('#topbar-waiting', (el) => el.hidden), 'marker hidden'), 'answering clears the top-bar marker');
check(!(await page.title()).startsWith('●'), `answering clears the title badge (${await page.title()})`);

await page.screenshot({ path: '/tmp/kuhn-parallel-check.png' });
await browser.close();
await fake.close();
if (errors.length) {
  console.log(`\n${errors.length} check(s) failed:`);
  for (const e of errors) console.log(` - ${e}`);
  process.exit(1);
}
console.log('\nparallel-check: all checks passed');
