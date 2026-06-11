// Two browser pages on the same document: typing in one must appear in the
// other via the backend y-websocket room (story 013 collab path).
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const browser = await chromium.launch();
const pageA = await browser.newPage();
const pageB = await browser.newPage();

await pageA.goto(WEBAPP);
await pageB.goto(WEBAPP);
await pageA.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
await pageB.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
await pageA.waitForTimeout(1500);

await pageA.click('#editor .milkdown [contenteditable]');
await pageA.keyboard.press('End');
await pageA.keyboard.type(' COLLAB-SYNC-CHECK');

await pageB.waitForFunction(
  () => document.querySelector('#editor')?.textContent?.includes('COLLAB-SYNC-CHECK'),
  { timeout: 10000 },
);
console.log('collab sync: page B sees page A edits');
await browser.close();
