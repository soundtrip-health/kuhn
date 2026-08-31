// STH-16: raw-file serving policy — browser-level security check, token-free.
//   node scripts/raw-content-check.mjs        (or: npm run raw-content-check)
//
// Needs the backend (and, for the same-origin dist embedding leg, a built
// webapp dist it serves at /).
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
//   Counterfactual control (test-only surface) — an in-process HTTP server
//   (no production route) serves the byte-identical fixtures with the
//   PRE-FIX headers (text/html / image/svg+xml, inline, no nosniff): the
//   browser MUST execute the payload there (top-level navigation and
//   same-origin <iframe> embed), which proves the assertions above are
//   discriminating, not vacuous. The same server serves the fixtures with
//   the real policy's headers (rawContentPolicy) to a benign same-origin
//   host page for the <iframe>/<object>/<img> embedding assertions.
//
// Runs against projects[0] (override with PROJECT_ID). The local data
// directory is disposable — every project in it is a test project — so no
// ceremony is needed. Paths are still `raw-check`-prefixed and purged() at
// startup and from a finally block, purely so repeated runs stay readable.
import { chromium } from 'playwright';
import http from 'node:http';
import { rawContentPolicy } from '../../agent-backend/src/raw-content.js';

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
const SVG_BODY = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.__STH16_CHECK__ = 'script-ran';</` + 'script></svg>\n';

// Purge fixtures from prior runs.
for (const path of OWNED) {
  await fetch(projApi(`/file?path=${encodeURIComponent(path)}`), { method: 'DELETE' }).catch(() => {});
}

// --- The test-only counterfactual/policy surface (no production route) -----
// The pre-fix routes declared .html → text/html and .svg → image/svg+xml and
// sent the bytes inline — no nosniff, no attachment. This in-process server
// serves the SAME fixture bytes three ways:
//   /counterfactual/…  the pre-fix headers — the payload MUST run there;
//   /policy/…          the real policy's headers (rawContentPolicy output)
//                      — the payload must not run;
//   /embed.html        a benign same-origin host page (no scripts of its
//                      own) for the embedding assertions.
const HOST_BODY =
  '<!doctype html><html><head><meta charset="utf-8"><title>sth16 embed host</title></head><body><p>sth16 embed host</p></body></html>\n';
const policyHeaders = (name) => {
  const { contentType, disposition } = rawContentPolicy(name);
  const headers = { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' };
  if (disposition) headers['Content-Disposition'] = disposition;
  return headers;
};
const testServer = http.createServer((req, res) => {
  const send = (status, headers, body) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/counterfactual/evil.html') return send(200, { 'Content-Type': 'text/html' }, HTML_BODY);
  if (path === '/counterfactual/evil.svg') return send(200, { 'Content-Type': 'image/svg+xml' }, SVG_BODY);
  if (path === '/policy/evil.html') return send(200, policyHeaders(HTML_E), HTML_BODY);
  if (path === '/policy/evil.svg') return send(200, policyHeaders(SVG_E), SVG_BODY);
  if (path === '/embed.html') return send(200, { 'Content-Type': 'text/html' }, HOST_BODY);
  return send(404, { 'Content-Type': 'text/plain' }, 'not found');
});
await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
const TBASE = `http://127.0.0.1:${testServer.address().port}`;

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

  // --- Counterfactual control: the pre-fix headers must execute the payload -
  // The check proves itself discriminating: the byte-identical fixtures,
  // served with the old headers by the test-only server, DO run in Chromium.
  {
    const ctr = await browser.newPage();
    try {
      await ctr.goto(`${TBASE}/counterfactual/evil.html`, { waitUntil: 'load' });
      check(
        (await ctr.evaluate(() => window.__STH16_CHECK__ ?? null)) === 'script-ran',
        'counterfactual .html: pre-fix text/html headers execute the fixture script',
      );
      // The fixture's authenticated-API fetch targets the API-less
      // test-only surface and fails — the marker proves the script ran
      // through its fetch statement.
      await ctr.waitForFunction(() => window.__STH16_CHECK_API__ !== undefined);
      check(
        (await ctr.evaluate(() => window.__STH16_CHECK_API__ ?? null)) === 'fetch-failed',
        'counterfactual .html: fixture script reached its API fetch (failed against the API-less surface)',
      );

      await ctr.goto(`${TBASE}/counterfactual/evil.svg`, { waitUntil: 'load' });
      check(
        (await ctr.evaluate(() => window.__STH16_CHECK__ ?? null)) === 'script-ran',
        'counterfactual .svg: pre-fix image/svg+xml headers execute the fixture script',
      );
    } finally {
      await ctr.close();
    }
  }

  // --- Browser side: embedding under the policy's headers (deterministic) ---
  // A benign same-origin host page served by the test-only server (no built
  // dist required) embeds the fixtures exactly as the policy serves them —
  // rawContentPolicy output, byte-identical fixture. The response headers,
  // not the host page, decide what the browser does with each embed.
  const embedIn = async (hostUrl, tag, url, id) => {
    await page.goto(hostUrl, { waitUntil: 'load' });
    const attr = tag === 'object' ? 'data' : 'src';
    await page.evaluate(
      ({ tag, attr, src, id }) => {
        const el = document.createElement(tag);
        el.id = id;
        el[attr] = src;
        document.body.appendChild(el);
      },
      { tag, attr, src: url, id },
    );
    await page.waitForTimeout(1500);
    return page.evaluate(
      ({ id, tag }) => {
        const el = document.getElementById(id);
        if (tag === 'img') return { marker: null, width: el.naturalWidth };
        let markerSeen = 'unreadable';
        try {
          markerSeen = (el.contentWindow && el.contentWindow.__STH16_CHECK__) ?? 'no-marker';
        } catch {
          markerSeen = 'cross-origin';
        }
        return { marker: markerSeen, width: null };
      },
      { id, tag },
    );
  };
  for (const [tag, fixture] of [
    ['iframe', 'evil.html'],
    ['iframe', 'evil.svg'],
    ['object', 'evil.html'],
    ['object', 'evil.svg'],
  ]) {
    const r = await embedIn(`${TBASE}/embed.html`, tag, `${TBASE}/policy/${fixture}`, 'sth16-embed');
    check(
      r.marker !== 'script-ran',
      `embedded ${fixture} in <${tag}> under policy headers: fixture script did not run`,
    );
  }
  const imgEmbed = await embedIn(`${TBASE}/embed.html`, 'img', `${TBASE}/policy/evil.svg`, 'sth16-embed');
  check(
    imgEmbed.width === 0,
    'embedded evil.svg in <img> under policy headers: inert response does not render as an image',
  );
  const ctrEmbed = await embedIn(`${TBASE}/embed.html`, 'iframe', `${TBASE}/counterfactual/evil.html`, 'sth16-embed');
  check(
    ctrEmbed.marker === 'script-ran',
    'counterfactual <iframe> embed under pre-fix headers: fixture script ran (assertions discriminate)',
  );

  // --- Browser side: embedding on the real origin (built dist) --------------
  // The production topology is single-port (app + API, one origin); the dev
  // backend serves the built webapp at / when a dist exists — the faithful
  // same-origin embedding context. The deterministic test-only leg above
  // covers the same matrix without a dist; this leg covers the real
  // fixtures on the real origin. Without a dist the leg is skipped.
  {
    const probe = await fetch(`${BACKEND}/`);
    if (probe.status === 200) {
      await probe.text();
      for (const [tag, fixture] of [
        ['iframe', HTML_E],
        ['iframe', SVG_E],
        ['object', HTML_E],
        ['object', SVG_E],
      ]) {
        const r = await embedIn(`${BACKEND}/`, tag, rawUrl(fixture), 'sth16-frame');
        check(
          r.marker !== 'script-ran',
          `embedded ${fixture} in <${tag}> on the app origin: fixture script did not run`,
        );
      }
      const img = await embedIn(`${BACKEND}/`, 'img', rawUrl(SVG_E), 'sth16-img');
      check(
        img.width === 0,
        'embedded evil.svg in <img> on the app origin: policy response does not render as an image',
      );
      const txt = await embedIn(`${BACKEND}/`, 'iframe', rawUrl(TXT), 'sth16-frame');
      check(
        txt.marker !== 'script-ran',
        'embedded note.txt in <iframe> on the app origin: still inert (no script source)',
      );
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
  testServer.closeAllConnections?.();
  await new Promise((resolve) => testServer.close(resolve));
}

console.log('errors:', errors.length ? errors : 'none');
process.exit(errors.length ? 1 : 0);
