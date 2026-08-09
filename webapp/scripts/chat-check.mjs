// Live chat check: send one message through the UI and verify the streamed
// agent reply renders, with token usage in the status bar. Needs API creds.
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));

await page.goto(WEBAPP);
await page.waitForSelector('#chat-input', { timeout: 15000 });

await page.selectOption('#chat-role', 'pm');
await page.fill('#chat-input', 'Reply with one short sentence greeting the user. Do not use any tools.');
await page.press('#chat-input', 'Enter');

// Watch the streaming bubble grow (text_delta), then settle (text)
await page.waitForSelector('.chat-agent .chat-body', { timeout: 60000 });
await page.waitForFunction(
  () => / tokens\b/.test(document.getElementById('status-tokens')?.textContent ?? ''),
  { timeout: 120000 },
);

console.log('agent tag:', await page.textContent('.chat-agent .chat-tag'));
console.log('agent reply:', (await page.textContent('.chat-agent .chat-body')).slice(0, 200));
console.log('status tokens:', await page.textContent('#status-tokens'));
await page.screenshot({ path: '/tmp/kuhn-chat.png' });
await browser.close();
