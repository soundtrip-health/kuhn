// STH-16: raw-file serving policy — browser-level security check, token-free.
//   node scripts/raw-content-check.mjs        (or: npm run raw-content-check)
//
// Needs the backend + webapp dev servers.
//
// Uploads hostile fixtures (an HTML document with a script, an SVG with a
// script, plain text, a 1×1 PNG, and an org-library document whose *stored*
// MIME claims text/html), then verifies the raw-file serving boundary:
//
//   API side — the raw URLs serve the policy's headers: octet-stream +
//   attachment + nosniff for active/unknown types; the safe type with no
//   disposition for text/raster; the stored client-supplied org MIME ignored.
//
//   Browser side (the actual attack surface) — navigating to, or embedding,
//   a malicious fixture on the API origin must not execute its script. The
//   fixture marks its window AND tries to call the authenticated API: in the
//   local dev environment the browser is the seeded dev user, the same
//   identity the webapp uses, so a running fixture would have full
//   same-origin API access.
//
// Runs against projects[0] (override with PROJECT_ID). The local data
// directory is disposable — every project in it is a test project — so no
// ceremony is needed. Paths are still `raw-check`-prefixed and purged() at
// startup and from a finally block, purely so repeated runs stay readable.
import { chromium } from 'playwright';

const WEBAPP = process.env.WEBAPP_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, label) => {
  console.log(`${cond ? 'ok ' : 'FAIL'} ${label}`);
  if (!cond) fail(label);
};

const json = async (res) => res.json();
const projects = (await json(await fetch(`${BACKEND}/api/projects`))).projects;
const projectId = Number(process.env.PROJECT_ID) || projects[0].id;
const orgId = projects[0].org_id;
const projApi = (p) => `${BACKEND}/api/projects/${projectId}${p}`;
const rawUrl = (path) => `${BACKEND}/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`;

// --- The paths this script owns, and nothing else ---------------------------
const HTML_E = 'raw-check-evil.html';
const SVG_E = 'raw-check-evil.svg';
const TXT = 'raw-check-note.txt';
const PNG = 'raw-check-pix.png';
const LIB = 'raw-check-lib.html';
const OWNED = [HTML_E, SVG_E, TXT, PNG];
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// The payload: if the browser ever runs it, the window is marked and the
// authenticated API is reached. It must never run.
const HTML_BODY = `<html><body><script>window.__STH16_CHECK__ = 'script-ran';fetch('/api/projects',{credentials:'include'}).then((r)=>r.json()).then((j)=>{window.__STH16_CHECK_API__ = Array.isArray(j && j.projects);}).catch(()=>{window.__STH16_CHECK_API__ = 'fetch-failed';});</` + 'script></body></html>\n';
const SVG_BODY = `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__STH16_CHECK__ = 'script-ran';</` + 'script></svg>\n';

// Purge fixtures from prior runs.
for (const path of OWNED) {
  await fetch(projApi(`/file?path=${encodeURIComponent(path)}`), { method: 'DELETE' }).catch(() => {});
}

let libDocId = null;
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => fail(`pageerror: ${err.message}`));

try {
  // --- API side: upload the fixtures ---------------------------------------
  {
    const form = new FormData();
    form.append('files', new Blob([HTML_BODY], { type: 'text/html' }), HTML_E);
    form.append('files', new Blob([SVG_BODY], { type: 'image/svg+xml' }), SVG_E);
    form.append('files', new Blob(['raw-check note\n'], { type: 'text/plain' }), TXT);
    form.append('files', new Blob([PNG_BYTES]), PNG);
    const res = await fetch(projApi('/files/upload'), { method: 'POST', body: form });
    check(res.status === 201, `upload returns 201 (got ${res.status})`);
  }
  // The org-library document: stored MIME deliberately claims text/html —
  // the serving policy must ignore it (T-13).
  {
    const form = new FormData();
    form.append('files', new Blob([HTML_BODY], { type: 'text/html' }), LIB);
    const res = await fetch(`${BACKEND}/api/orgs/${orgId}/library/upload`, { method: 'POST', body: form });
    check(res.status === 201, `org-library upload returns 201 (got ${res.status})`);
    if (res.status === 201) libDocId = (await json(res)).documents[0].id;
  }

  // --- API side: raw URLs carry the policy's headers -----------------------
  {
    const html = await fetch(rawUrl(HTML_E));
    check(html.status === 200, 'malicious .html serves (200)');
    check(html.headers.get('content-type') === 'application/octet-stream', '.html served as application/octet-stream');
    check(html.headers.get('content-disposition') === `attachment; filename="${HTML_E}"`, '.html served as attachment');
    check(html.headers.get('x-content-type-options') === 'nosniff', '.html carries nosniff');
    check(await html.text() === HTML_BODY, '.html body passes through intact');

    const svg = await fetch(rawUrl(SVG_E));
    check(svg.headers.get('content-type') === 'application/octet-stream', '.svg served as application/octet-stream');
    check(svg.headers.get('content-disposition') === `attachment; filename="${SVG_E}"`, '.svg served as attachment');
    check(svg.headers.get('x-content-type-options') === 'nosniff', '.svg carries nosniff');

    const txt = await fetch(rawUrl(TXT));
    check(txt.headers.get('content-type') === 'text/plain; charset=utf-8', '.txt keeps its text type');
    check(txt.headers.get('content-disposition') === null, '.txt stays inline (no disposition)');
    check(txt.headers.get('x-content-type-options') === 'nosniff', '.txt carries nosniff');

    const png = await fetch(rawUrl(PNG));
    check(png.headers.get('content-type') === 'image/png', '.png keeps its image type');
    check(png.headers.get('content-disposition') === null, '.png stays inline (no disposition)');

    if (libDocId) {
      const lib = await fetch(`${BACKEND}/api/orgs/${orgId}/library/${libDocId}/content`);
      check(lib.headers.get('content-type') === 'application/octet-stream', 'org doc ignores its stored text/html MIME');
      check(lib.headers.get('content-disposition') === `attachment; filename="${LIB}"`, 'org doc served as attachment');
      check(lib.headers.get('x-content-type-options') === 'nosniff', 'org doc carries nosniff');
    }

    // T-15 headers: the review shell (the /review/<token> page) must never
    // let its token URL ride a referrer. Only meaningful for a built dist.
    const shell = await fetch(`${BACKEND}/review/`);
    const spa = await fetch(`${BACKEND}/`);
    if (shell.status === 200 && (await shell.text()) !== (await spa.text())) {
      check(shell.headers.get('referrer-policy') === 'no-referrer', 'review shell sends Referrer-Policy: no-referrer');
    } else {
      console.log('skip review-shell header (no built webapp dist in the backend)');
    }
  }

  // --- Browser side: navigation must not produce an active document ---------
  // An attachment response makes Chromium start a download instead of
  // rendering a document, so page.goto throws "Download is starting" — that
  // throw is the proof the browser refused to render it as an active page.
  const assertNotActive = async (label, url) => {
    let downloadInitiated = false;
    let res = null;
    try {
      res = await page.goto(url, { waitUntil: 'load' });
    } catch (err) {
      downloadInitiated = /download is starting/i.test(err.message);
      if (!downloadInitiated) fail(`${label}: unexpected navigation error: ${err.message}`);
    }
    const disposition = res ? (res.headers()['content-disposition'] ?? '') : '';
    check(
      downloadInitiated || disposition.startsWith('attachment'),
      `${label}: browser treats the response as a download, not a document`,
    );
    if (res) {
      check(res.headers()['content-type'] === 'application/octet-stream', `${label}: browser response is application/octet-stream`);
      check(res.headers()['x-content-type-options'] === 'nosniff', `${label}: browser response carries nosniff`);
    }
    check((await page.evaluate(() => window.__STH16_CHECK__ ?? null)) == null, `${label}: fixture script did not run`);
    check((await page.evaluate(() => window.__STH16_CHECK_API__ ?? null)) == null, `${label}: fixture could not reach the authenticated API`);
  };

  await assertNotActive('evil.html navigation', rawUrl(HTML_E));
  await assertNotActive('evil.svg navigation', rawUrl(SVG_E));

  // --- Browser side: embedding in a same-origin page ------------------------
  // The production topology is single-port (app + API, one origin); the dev
  // backend serves the built webapp at / when a dist exists — the faithful
  // same-origin embedding context. Without a dist the leg is skipped.
  {
    const probe = await fetch(`${BACKEND}/`);
    if (probe.status === 200) {
      await probe.text();
      const embed = async (url) => {
        await page.goto(`${BACKEND}/`);
        await page.evaluate((src) => {
          const f = document.createElement('iframe');
          f.id = 'sth16-frame';
          f.src = src;
          document.body.appendChild(f);
        }, url);
        await page.waitForTimeout(1500);
        return page.evaluate(async () => {
          const f = document.getElementById('sth16-frame');
          let markerSeen = 'unreadable';
          try { markerSeen = f.contentWindow.__STH16_CHECK__ ?? 'no-marker'; } catch { markerSeen = 'cross-origin'; }
          return { markerSeen };
        });
      };
      const htmlEmbed = await embed(rawUrl(HTML_E));
      check(htmlEmbed.markerSeen !== 'script-ran', 'embedded evil.html: fixture script did not run');
      const txtEmbed = await embed(rawUrl(TXT));
      check(txtEmbed.markerSeen !== 'script-ran', 'embedded note.txt: still inert (no script source)');
    } else {
      console.log('skip same-origin embedding leg (backend not serving a built webapp dist)');
    }
  }

  // --- Browser side: the ordinary workflows still work ----------------------
  {
    const txt = await page.goto(rawUrl(TXT), { waitUntil: 'load' });
    check(txt.headers()['content-type'] === 'text/plain; charset=utf-8', 'txt navigation: browser response is text/plain');
    check((await page.evaluate(() => document.contentType)) === 'text/plain', 'txt navigation: renders as plain text');
    check((await page.evaluate(() => document.body.innerText)).includes('raw-check note'), 'txt navigation: body intact');

    const png = await page.goto(rawUrl(PNG), { waitUntil: 'load' });
    check(png.headers()['content-type'] === 'image/png', 'png navigation: browser response is image/png');
    check((await page.evaluate(() => document.contentType)) === 'image/png', 'png navigation: renders as an image');
  }
} finally {
  for (const path of OWNED) {
    await fetch(projApi(`/file?path=${encodeURIComponent(path)}`), { method: 'DELETE' }).catch(() => {});
  }
  if (libDocId) {
    await fetch(`${BACKEND}/api/orgs/${orgId}/library/${libDocId}`, { method: 'DELETE' }).catch(() => {});
  }
  await browser.close();
}

console.log('errors:', errors.length ? errors : 'none');
process.exit(errors.length ? 1 : 0);
