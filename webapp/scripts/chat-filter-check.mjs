// Issue #45: conversation filter on the chat log. By default the log shows
// only the selected agent's conversation; a toggle above it shows the full
// tagged history. This drives the UI only — no LLM tokens. Needs the backend
// and webapp dev servers.
//   node scripts/chat-filter-check.mjs
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';

const errors = [];
const check = (cond, label) => {
  console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`);
  if (!cond) errors.push(label);
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

await page.goto(WEBAPP);
await page.waitForSelector('#chat-log', { timeout: 15000 });
await page.waitForTimeout(1500);

// Default state: filtered to the selected agent (PM), bar says so.
check(
  /Showing .+ only/.test((await page.textContent('#chat-filter-label')) ?? ''),
  'filter bar defaults to the selected agent only',
);

// Seed the log with fake restored messages from two conversations, the way
// restoreTranscript tags them (data-agent = conversation slug).
await page.evaluate(() => {
  const log = document.getElementById('chat-log');
  for (const [agent, text] of [['pm', 'pm message'], ['writer', 'writer message']]) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-agent';
    el.dataset.agent = agent;
    el.textContent = text;
    log.append(el);
  }
});

const visible = async (sel) => page.locator(sel).first().evaluate(
  (el) => !el.classList.contains('chat-filtered-out') && el.offsetParent !== null,
).catch(() => false);

// Switch the addressed agent to Writer via the hidden select (the pill
// mirrors into it and fires the same change event).
await page.evaluate(() => {
  const select = document.getElementById('chat-role');
  select.value = 'writer';
  select.dispatchEvent(new Event('change', { bubbles: true }));
});
check(!(await visible('[data-agent="pm"]')), 'switching to Writer hides the PM conversation');
check(await visible('[data-agent="writer"]'), 'Writer conversation stays visible');
check(
  /Showing .+ only/.test((await page.textContent('#chat-filter-label')) ?? ''),
  'bar label follows the agent switch',
);

// Toggle to the full history: everything shows, tagged as before.
await page.click('#chat-filter-toggle');
check(await visible('[data-agent="pm"]'), 'All agents view shows the PM conversation');
check(await visible('[data-agent="writer"]'), 'All agents view shows the Writer conversation');
check(
  ((await page.textContent('#chat-filter-label')) ?? '').includes('all agents'),
  'bar label reflects the all-agents view',
);

// Back to filtered; the empty hint appears for an agent with no messages.
await page.click('#chat-filter-toggle');
await page.evaluate(() => {
  const select = document.getElementById('chat-role');
  select.value = 'ra';
  select.dispatchEvent(new Event('change', { bubbles: true }));
});
check(
  (await page.locator('#chat-filter-empty').count()) === 1,
  'empty filtered view explains the agent has no conversation yet',
);

// The preference persists across reload (localStorage).
await page.click('#chat-filter-toggle'); // back to show-all
await page.reload();
await page.waitForSelector('#chat-filter-label', { timeout: 15000 });
await page.waitForTimeout(1000);
check(
  ((await page.textContent('#chat-filter-label')) ?? '').includes('all agents'),
  'show-all preference survives reload',
);

await browser.close();
console.log('errors:', errors.length ? errors : 'none');
if (errors.length) process.exit(1);
