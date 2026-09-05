// Issues #136 / #137: stopping a run, and the status bar following the
// innermost running agent. Token-free: the PM and RA are routed (org model
// route) to the scripted OpenAI-compatible fake server from the conformance
// suite, so the REAL Pi runtime runs over real HTTP with deterministic model
// behavior. Needs a FRESH isolated backend (dev auth mode, scratch data dir:
// the check uses projects[0]) + the webapp dev server pointed at it.
//   BACKEND_URL=http://localhost:3105 WEBAPP_URL=http://localhost:5185 node scripts/stop-check.mjs
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
const MODEL = 'stop-check';

// --- Fake model server: one script shared by every agent (same model id) ---
const fake = createFakeOpenAIServer();
const fakeUrl = await fake.listen();
const dispatchRa = {
  kind: 'message', usage: { input: 10, output: 5 },
  toolCalls: [{ id: 'call_ra', name: 'dispatch_agent', args: { agent_slug: 'ra', task: 'Find three papers on sleep and memory.', difficulty: 0.3 } }],
};
const say = (text) => ({ kind: 'message', deltas: text.split(' ').map((w, i) => (i ? ` ${w}` : w)), usage: { input: 20, output: 5 } });

// --- API: project + route PM and RA to the fake ---
const org = (await json(await fetch(`${BACKEND}/api/orgs`))).orgs[0];
check(org, 'dev user has an org');
const api = (p, init) => fetch(`${BACKEND}/api/orgs/${org.id}${p}`, init);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let projects = (await json(await fetch(`${BACKEND}/api/projects`))).projects;
if (!projects.length) {
  const res = await post(`${BACKEND}/api/projects`, { name: 'Stop check', orgId: org.id });
  check(res.status === 201, `project created (got ${res.status})`);
  projects = (await json(await fetch(`${BACKEND}/api/projects`))).projects;
}
const project = projects[0];
await api(`/model-profiles/${MODEL}`, { method: 'DELETE' });
const created = await post(`${BACKEND}/api/orgs/${org.id}/model-profiles`, {
  slug: MODEL, name: 'Stop-check fake model', provider: 'openai-compatible', model_id: MODEL,
  base_url: fakeUrl, credential_secret: null, capabilities: { tools: true }, cost_weight: 1,
});
check(created.status === 201, `fake profile created (got ${created.status}: ${created.status !== 201 ? await created.text() : 'ok'})`);
for (const agent of ['pm', 'ra']) {
  const res = await put(`${BACKEND}/api/orgs/${org.id}/model-routes/${agent}`, { routes: [{ profile_slug: MODEL, difficulty: 1 }] });
  check(res.status === 200, `${agent} routed to the fake (got ${res.status})`);
}
const jobs = async () => (await json(await fetch(`${BACKEND}/api/agent/jobs?projectId=${project.id}&limit=50`))).jobs;
// New jobs are those above the highest id seen so far (the list is newest-first and capped).
let maxJobId = Math.max(0, ...(await jobs()).map((j) => j.id));
const newJobs = async () => {
  const rows = (await jobs()).filter((j) => j.id > maxJobId);
  maxJobId = Math.max(maxJobId, ...rows.map((j) => j.id));
  return rows;
};

// --- Browser ---
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));
await page.goto(WEBAPP);
await page.waitForSelector('#chat-input', { timeout: 15000 });
await page.waitForTimeout(800);
// A fresh, unconfigured project opens the setup wizard; this check talks to
// the PM directly, so dismiss it.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// A model pin left by another check (issue #134) would route the PM elsewhere.
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('kuhn-model-pick')) localStorage.removeItem(k); });
check(!(await page.$('#setup-wizard:visible')), 'setup wizard dismissed');
// Record every status-bar change: the fake model answers within milliseconds,
// so the RA's turn is too short to catch by polling — the log is the record.
await page.evaluate(() => {
  const log = { agent: [], model: [] };
  window.__statusLog = log;
  const track = (id, key) => {
    const el = document.getElementById(id);
    new MutationObserver(() => {
      const text = el.textContent ?? '';
      if (log[key].at(-1) !== text) log[key].push(text);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  };
  track('status-agent', 'agent');
  track('status-model', 'model');
});
const statusLog = () => page.evaluate(() => window.__statusLog);
const statusAgent = () => page.textContent('#status-agent');
const statusModel = () => page.textContent('#status-model');
const sendIsStop = () => page.$eval('#chat-form .send-btn', (b) => b.classList.contains('is-stop'));
const waitStatus = (re, timeout = 20000) => page.waitForFunction(
  (src) => new RegExp(src).test(document.getElementById('status-agent')?.textContent ?? ''), re.source, { timeout },
).then(() => true, () => false);
const bubbleCount = () => page.$$eval('.chat-agent', (els) => els.length);
const sendMessage = async (text) => {
  // The previous run's stream may still be closing for a few ms after its
  // last visible line; the composer accepts a new message once it is idle.
  await page.waitForFunction(() => !document.querySelector('#chat-form .send-btn.is-stop'), null, { timeout: 10000 });
  await page.selectOption('#chat-role', 'pm');
  const before = await bubbleCount();
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
  return before;
};
// A NEW agent bubble (after `before`) containing `text` — the restored
// transcript of earlier runs already contains every reply this check scripts.
const waitReply = (before, text, label) => page.waitForFunction(
  ([n, t]) => [...document.querySelectorAll('.chat-agent')].slice(n).some((el) => (el.textContent ?? '').includes(t)),
  [before, text], { timeout: 15000 },
).then(() => true, () => { fail(label); return false; });

// Scenario A (#137): PM dispatches the RA, the RA answers, the PM keeps
// working. The status bar must show the RA while it runs and return to the
// PM afterwards — not stay on the PM throughout.
fake.register(MODEL, [dispatchRa, say('Found three papers.'), { kind: 'pause' }]);
let before = await sendMessage('Have the RA find papers, then keep going.');
await waitReply(before, 'Found three papers.', 'RA reply rendered');
check(await waitStatus(/^PM is working/), 'status bar returns to the PM after the RA finishes');
let logged = await statusLog();
check(logged.agent.some((t) => /^Research is working/.test(t)), `status bar showed the RA while the dispatched RA ran (${JSON.stringify(logged.agent)})`);
check(logged.model.some((t) => /^Research · stop-check/.test(t)), `model chip showed the RA's model while it ran (${JSON.stringify(logged.model)})`);
check(/^PM · stop-check/.test((await statusModel()) ?? ''), `model chip is back on the PM (${await statusModel()})`);
check(await sendIsStop(), 'send button is in Stop mode while the run is in flight');
// Stop the parked PM turn (issue #136).
await page.click('#chat-form .send-btn.is-stop');
await page.waitForSelector('.chat-system:has-text("stopped")', { timeout: 10000 }).catch(() => fail('stopped line appears after Stop'));
check(!(await sendIsStop()), 'send button returns to Send after the stop');
check(((await statusAgent()) ?? '') === '', 'status-bar activity clears after the stop');
let rows = await newJobs();
check(rows.length === 2, `two jobs recorded for scenario A (got ${rows.length})`);
check(rows.find((j) => j.role === 'pm')?.status === 'cancelled', `PM job is cancelled (${rows.find((j) => j.role === 'pm')?.status})`);
check(rows.find((j) => j.role === 'ra')?.status === 'done', `RA job finished normally (${rows.find((j) => j.role === 'ra')?.status})`);
check(fake.requests.length === 3, `three model requests so far (got ${fake.requests.length})`);

// Scenario B (#136): stop while a dispatched sub-agent is mid-turn. The whole
// tree stops; the RA's held request is aborted; both jobs are cancelled; the
// chip showed the RA at the moment of the stop.
fake.register(MODEL, [dispatchRa, { kind: 'pause' }]);
await sendMessage('Again, please.');
check(await waitStatus(/Research is working/), 'RA shows as working while its request is held');
check(/^Research · stop-check/.test((await statusModel()) ?? ''), `model chip shows the RA (${await statusModel()})`);
await page.keyboard.press('Escape'); // the other Stop: Esc in the composer
await page.waitForSelector('.chat-system:has-text("stopped") >> nth=1', { timeout: 10000 }).catch(() => fail('second stopped line appears (Esc)'));
rows = await newJobs();
check(rows.length === 2 && rows.every((j) => j.status === 'cancelled'), `PM and RA jobs both cancelled (${rows.map((j) => `${j.role}:${j.status}`).join(', ')})`);
check(fake.requests.length === 5, `no request after the stop (got ${fake.requests.length})`);

// Follow-up after a stop resumes the conversation: the record of the stopped
// run travels with the next message (continuation), so the model sees the
// earlier turns.
fake.register(MODEL, [say('Continuing from where we stopped.')]);
before = await sendMessage('Carry on.');
await waitReply(before, 'Continuing from where we stopped.', 'follow-up reply rendered');
const last = fake.requests.at(-1);
const seen = JSON.stringify(last?.messages ?? []);
if (process.env.DEBUG) {
  for (const r of fake.requests) console.log('REQ', r.model, r.messages.length, JSON.stringify(r.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 60))));
}
check(seen.includes('Again, please.'), 'follow-up request carries the stopped run\'s transcript (continuation)');
check(seen.includes('Carry on.'), 'follow-up request carries the new message');
check(await waitStatus(/^$/, 10000), 'activity clears after the follow-up completes');

await page.screenshot({ path: '/tmp/kuhn-stop-check.png' });
await browser.close();
await fake.close();
if (errors.length) {
  console.log(`\n${errors.length} check(s) failed:`);
  for (const e of errors) console.log(` - ${e}`);
  process.exit(1);
}
console.log('\nstop-check: all checks passed');
