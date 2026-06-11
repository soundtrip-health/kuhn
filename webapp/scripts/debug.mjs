import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));
page.on('console', (msg) => console.log(`CONSOLE[${msg.type()}]:`, msg.text().slice(0, 300)));
await page.goto('http://localhost:5174/');
await page.waitForTimeout(5000);
console.log('editor html:', (await page.innerHTML('#editor')).slice(0, 300));
await browser.close();
