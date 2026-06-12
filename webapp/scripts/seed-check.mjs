// Live seeding check (story 015): click Seed, answer the PM interview with
// canned answers, and watch the pipeline run interview → research → skeleton.
// Burns real model quota (PM on Opus + RA/Advisor/Writer) — run deliberately.
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const DEADLINE_MS = 20 * 60 * 1000;

const ANSWERS = [
  'A manuscript about a personalized music intervention for agitation in dementia care.',
  'Research question: does personalized music reduce agitation episodes in memory-care residents? No prior materials — starting fresh.',
  'Deliverable: a journal manuscript draft. Timeline: full draft by 2026-09-01.',
  'Nothing else — please proceed with sensible defaults for anything remaining.',
];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));

await page.goto(WEBAPP);
await page.waitForSelector('#chat-input', { timeout: 15000 });
await page.click('#seed-project');

const started = Date.now();
let answered = 0;

// Answer questions as they arrive until the pipeline reports done/error
for (;;) {
  if (Date.now() - started > DEADLINE_MS) throw new Error('seed-check timed out');
  const finished = await page.evaluate(() =>
    [...document.querySelectorAll('.chat-system')].map((n) => n.textContent)
      .filter((t) => t.includes('project seeding done') || t.includes('project seeding failed')).length > 0);
  if (finished) break;

  const waiting = await page.evaluate(() =>
    document.getElementById('chat-input')?.placeholder.includes('answer'));
  if (waiting) {
    const answer = ANSWERS[Math.min(answered, ANSWERS.length - 1)];
    console.log(`Q${++answered} →`, answer.slice(0, 60));
    await page.fill('#chat-input', answer);
    await page.press('#chat-input', 'Enter');
  }
  await page.waitForTimeout(2000);
}

console.log('--- system lines ---');
for (const line of await page.$$eval('.chat-system', (ns) => ns.map((n) => n.textContent))) {
  console.log(line);
}
console.log('status tokens:', await page.textContent('#status-tokens'));
await page.screenshot({ path: '/tmp/kuhn-seed.png', fullPage: true });
await browser.close();
