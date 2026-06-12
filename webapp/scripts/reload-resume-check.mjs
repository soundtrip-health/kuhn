// Live reload-resume check (story 020): start a PM interview in chat, answer
// one question, reload mid-interview, and verify (a) the transcript is
// restored, (b) the SDK session resumes — the PM remembers the earlier answer.
// Burns real model quota (PM on Opus) — run deliberately.
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));

await page.goto(WEBAPP);
await page.waitForSelector('#chat-input', { timeout: 15000 });

// Kick off an interview and answer the first question
await page.selectOption('#chat-role', 'pm');
await page.fill('#chat-input', 'Interview me about a new project. Ask one question at a time with ask_user.');
await page.press('#chat-input', 'Enter');
await page.waitForFunction(
  () => document.getElementById('chat-input')?.placeholder.includes('answer'),
  { timeout: 180000 },
);
await page.fill('#chat-input', 'A grant application about zebrafish sleep regulation. Remember the word "zebrafish".');
await page.press('#chat-input', 'Enter');

// Wait for the next question so the answer is in the SDK session, then reload
await page.waitForFunction(
  () => document.getElementById('chat-input')?.placeholder.includes('answer'),
  { timeout: 180000 },
);
console.log('reloading mid-interview…');
await page.reload();
await page.waitForSelector('#chat-input', { timeout: 15000 });

// (a) transcript restored
await page.waitForFunction(
  () => [...document.querySelectorAll('.chat-system')].some((n) => n.textContent.includes('restored transcript')),
  { timeout: 15000 },
);
const restored = await page.$$eval('.chat-message .chat-body', (ns) => ns.map((n) => n.textContent).join('\n'));
console.log('transcript restored:', restored.includes('zebrafish') ? 'OK (contains earlier answer)' : 'MISSING earlier answer');

// (b) session resumed: the PM should still know the topic
await page.selectOption('#chat-role', 'pm');
await page.fill('#chat-input', 'Without asking anything else: in one sentence, what is my project about?');
await page.press('#chat-input', 'Enter');
await page.waitForFunction(
  () => {
    const bubbles = [...document.querySelectorAll('.chat-agent .chat-body')];
    return bubbles.length > 0 && /zebrafish/i.test(bubbles[bubbles.length - 1].textContent ?? '');
  },
  { timeout: 180000 },
).then(
  () => console.log('session resume: OK (PM remembers zebrafish)'),
  () => console.log('session resume: FAILED (PM reply does not mention the topic)'),
);

console.log('last reply:', (await page.$$eval('.chat-agent .chat-body', (ns) => ns.at(-1)?.textContent ?? '')).slice(0, 200));
await page.screenshot({ path: '/tmp/kuhn-reload-resume.png', fullPage: true });
await browser.close();
