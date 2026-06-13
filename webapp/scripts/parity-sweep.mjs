// Story 004 parity sweep: exercise the full markdown surface on the Crepe
// editor in the running app and emit a pass/fail matrix. Requires backend
// (:3002) + webapp dev server (:5174).
import { chromium } from 'playwright';
const WEBAPP = 'http://localhost:5174';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });

await page.goto(WEBAPP);
await page.waitForSelector('#editor .milkdown [contenteditable]', { timeout: 15000 });
await page.waitForTimeout(1500);
await page.evaluate(() => document.getElementById('editor-hero')?.remove());

const ed = '#editor .milkdown';
// Robust clear: a leading CodeMirror code block traps keyboard focus, so place
// the DOM selection at the PM doc end (outside CodeMirror) before select-all.
const clear = async () => {
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const pm = document.querySelector('#editor .milkdown [contenteditable]');
      pm.focus();
      const range = document.createRange();
      range.selectNodeContents(pm);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(120);
    if (((await page.textContent(ed)) ?? '').trim().length === 0) return;
  }
};
const count = (sel) => page.locator(`${ed} ${sel}`).count();

// ---- 1. Markdown PASTE round-trip (also covers the "markdown paste" AC) ----
const md = [
  '# Heading One', '', '## Heading Two', '',
  'Para with **bold**, *italic*, ~~strike~~, `code`, and a [link](https://example.com).', '',
  '> A blockquote.', '',
  '- bullet one', '- bullet two', '',
  '1. first', '2. second', '',
  '- [ ] todo', '- [x] done', '',
  '| A | B |', '|---|---|', '| 1 | 2 |', '',
  '```js', 'const x = 1;', '```', '',
  'Inline math $E=mc^2$ here.', '', '$$', '\\int_0^1 x\\,dx', '$$', '',
  '![alt](https://example.com/img.png)', '',
].join('\n');

await clear();
await page.evaluate((text) => {
  const el = document.querySelector('#editor .milkdown [contenteditable]');
  el.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, md);
await page.waitForTimeout(800);
// Crepe renders the $$ block's katex preview asynchronously — wait for it.
await page.waitForSelector(`${ed} .milkdown-code-block .katex`, { timeout: 4000 }).catch(() => {});

check('markdown paste parsed', (await count('h1')) > 0);
check('headings (h1+h2)', (await count('h1')) >= 1 && (await count('h2')) >= 1);
check('bold (strong)', (await count('strong')) >= 1);
check('italic (em)', (await count('em')) >= 1);
check('strikethrough (del/s)', (await count('del')) + (await count('s')) >= 1);
check('inline code', (await count('code')) >= 1);
check('link (a[href])', (await count('a[href]')) >= 1);
check('blockquote', (await count('blockquote')) >= 1);
check('bullet list', (await count('ul li')) >= 1);
check('ordered list', (await count('ol li')) >= 1);
// Crepe renders task items via list-item-block with an SVG checkbox (not <input>).
check('task list checkbox', (await count('.milkdown-list-item-block svg')) >= 1);
check('table', (await count('table')) >= 1 && (await count('td')) >= 1);
check('fenced code block (CodeMirror)', (await count('.cm-editor, pre')) >= 1);
check('inline math rendered (katex)', (await count('.katex')) >= 1, `katex els=${await count('.katex')}`);
check('image node', (await count('img, .milkdown-image-block, [data-type=image]')) >= 1);

// Block math gets its own clean paste: Crepe routes $$ through the code-block
// preview (katex inside it), and it renders more reliably without inline-math
// in the same blob competing for the parser.
await clear();
await page.evaluate(() => {
  const el = document.querySelector('#editor .milkdown [contenteditable]'); el.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', 'Before.\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nAfter.\n');
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForSelector(`${ed} .milkdown-code-block .katex`, { timeout: 4000 }).catch(() => {});
check('block math rendered (katex in code block)', (await count('.milkdown-code-block .katex')) >= 1);

// ---- 2. Undo / redo ----
await clear();
await page.keyboard.type('undo target');
await page.waitForTimeout(150);
await page.keyboard.press('ControlOrMeta+z');
await page.waitForTimeout(150);
const afterUndo = await page.textContent(ed);
check('undo', !((afterUndo ?? '').includes('undo target')), `text="${(afterUndo??'').trim().slice(0,30)}"`);
await page.keyboard.press('ControlOrMeta+Shift+z');
await page.waitForTimeout(150);
const afterRedo = await page.textContent(ed);
check('redo', (afterRedo ?? '').includes('undo target'));

// ---- 3. Toolbar (select text with the mouse, expect the toolbar) ----
// The toolbar shows on a real range selection; drag-select across the word.
await clear();
await page.keyboard.type('toolbar selection test');
await page.waitForTimeout(200);
{
  const p = await page.locator(`${ed} p`).first().boundingBox();
  await page.mouse.move(p.x + 4, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + 90, p.y + p.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}
const toolbarShown = await page.evaluate(() => {
  const t = document.querySelector('.milkdown-toolbar');
  return !!t && getComputedStyle(t).display !== 'none' && t.getBoundingClientRect().width > 0;
});
check('toolbar appears on selection', toolbarShown);

// ---- 4. Link tooltip (hover a link) ----
await clear();
await page.evaluate(() => {
  const el = document.querySelector('#editor .milkdown [contenteditable]');
  el.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', 'See [the site](https://example.com).');
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(400);
const link = page.locator(`${ed} a[href]`).first();
if (await link.count()) {
  await link.hover();
  await page.waitForTimeout(400);
  check('link tooltip on hover', await page.isVisible('.milkdown-link-preview, .link-preview').catch(() => false));
} else check('link tooltip on hover', false, 'no link to hover');

// ---- 5. Code language selection control present ----
await clear();
await page.evaluate(() => {
  const el = document.querySelector('#editor .milkdown [contenteditable]');
  el.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', '```python\nprint(1)\n```\n');
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(500);
check('code block language picker', (await count('.cm-editor')) >= 1 &&
  (await page.locator(`${ed} .milkdown-code-block .language-button, ${ed} [class*=language]`).count()) >= 1);

check('no page errors during sweep', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log('\n=== PARITY MATRIX ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
