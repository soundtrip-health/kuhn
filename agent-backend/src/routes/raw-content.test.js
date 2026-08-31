// STH-16: the raw-file serving policy (threat model T-12/T-13) — regression
// suite. Two layers:
//
//   1. rawContentPolicy — the pure classifier: the safe-inline allowlist
//      (text/JSON/raster/PDF) vs everything else (HTML/SVG, unknown types,
//      binary) → octet-stream + attachment; mixed-case extensions; hostile
//      filenames that must not break the Content-Disposition header.
//   2. HTTP wiring — the raw-bytes routes (project file, org-library
//      document content, reviewer file) serve with the policy's headers,
//      with the stored client-supplied org MIME ignored, and with tenancy
//      unchanged (viewer reads; non-members get the non-leaking 404).
//
// Same bootstrap as tenancy-matrix.test.js: real SQLite (:memory:), real
// guards/session/storage on temp roots, heavy runtimes mocked.

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

// Library ingestion would chunk/FTS-index every upload in the background —
// out of scope here (006-002 has its own tests).
vi.mock('../ingest.js', () => ({ queueIngest: vi.fn() }));
vi.mock('../mailer.js', () => ({
  sendLoginLink: vi.fn(async () => {}),
  sendInviteLink: vi.fn(async () => {}),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixture ids (explicit, so route paths can be literals).
const ORG_A = 1;
const ORG_B = 2;
const PROJECT_A = 1; // in org A

const OCTET = 'application/octet-stream';
const NOSNIFF = 'nosniff';
// 1×1 transparent PNG, real bytes (the preview pane decodes it).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// The "payload": active content that MUST NOT run when served.
const EVIL_HTML = `<html><body><script>parent.__STH16 = true</scr` + 'ipt><img src=x onerror="fetch(\'/api/projects\')"></body></html>\n';
const EVIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>parent.__STH16 = true</scr` + 'ipt></svg>\n';

let config; let exec; let querySync;
let storeOrgDocument; let createSession; let createReviewLink; let claimReviewLink;
let rawContentPolicy;
let server; let base;
let projectsRoot; let orgsRoot;
let saved;

/** member cookie per principal (magic-link sessions) */
const cookies = {};
let reviewerCookie;
/** org document fixture ids (assigned in beforeAll) */
let orgDocIds;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  saved = {
    mode: config.auth.mode,
    secret: config.auth.sessionSecret,
    projectsRoot: config.agent.projectsRoot,
    orgsRoot: config.storage.orgsRoot,
    history: config.history.enabled,
  };
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';
  config.history.enabled = false; // history has its own tests (real git)

  projectsRoot = await mkdtemp(join(tmpdir(), 'kuhn-raw-projects-'));
  orgsRoot = await mkdtemp(join(tmpdir(), 'kuhn-raw-orgs-'));
  config.agent.projectsRoot = projectsRoot;
  config.storage.orgsRoot = orgsRoot;

  await mkdir(join(projectsRoot, String(PROJECT_A), 'draft'), { recursive: true });
  const fixtures = {
    'evil.html': EVIL_HTML,
    'Evil.HtMl': EVIL_HTML,
    'mixed.SvG': EVIL_SVG,
    'data.bin': 'binary\x00\x01payload',
    'notes.md': '# notes\n',
    'note.txt': 'plain text\n',
    'photo.png': PNG_BYTES,
    'photo.JPG': PNG_BYTES,
    'doc.pdf': '%PDF-1.4\n%%EOF\n',
    '协议.bin': 'non-ascii name bytes',
  };
  for (const [name, content] of Object.entries(fixtures)) {
    await writeFile(join(projectsRoot, String(PROJECT_A), 'draft', name), content);
  }

  ({ exec, querySync } = await import('../db.js'));
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG_A}, 'Org A', 'org-a')`);
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG_B}, 'Org B', 'org-b')`);
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@a.test')");
  querySync("INSERT INTO users (id, email) VALUES (3, 'viewer@a.test')");
  querySync("INSERT INTO users (id, email) VALUES (5, 'owner@b.test')");
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (1, ${ORG_A}, 'owner')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (3, ${ORG_A}, 'viewer')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (5, ${ORG_B}, 'owner')`);
  querySync(`INSERT INTO projects (id, org_id, name, project_type) VALUES (${PROJECT_A}, ${ORG_A}, 'Alpha', 'manuscript')`);

  ({ createSession } = await import('../db/auth.js'));
  for (const [name, userId] of [['owner', 1], ['viewer', 3], ['stranger', 5]]) {
    cookies[name] = (await createSession(userId)).cookieValue;
  }

  // Org-library documents: the stored `mime` is deliberately client-hostile —
  // the policy must ignore it (T-13). ingest:false: no FTS side effects.
  ({ storeOrgDocument } = await import('./org-library.js'));
  const orgDocs = { html: null, txt: null, png: null, noext: null };
  orgDocs.html = (await storeOrgDocument(ORG_A, Buffer.from(EVIL_HTML), {
    filename: 'lib-evil.html', mime: 'text/html; charset=utf-8',
    createdBy: 1, ingest: false,
  })).document;
  orgDocs.txt = (await storeOrgDocument(ORG_A, Buffer.from('plain\n'), {
    filename: 'lib-notes.txt', mime: 'text/html; charset=utf-8',
    createdBy: 1, ingest: false,
  })).document;
  orgDocs.png = (await storeOrgDocument(ORG_A, PNG_BYTES, {
    filename: 'lib-chart.png', mime: 'image/png',
    createdBy: 1, ingest: false,
  })).document;
  orgDocs.noext = (await storeOrgDocument(ORG_A, Buffer.from('<html>distinct bytes</html>\n'), {
    filename: 'lib-noext', mime: 'text/html',
    createdBy: 1, ingest: false,
  })).document;

  // Guest reviewer session for the project's evil.html (the guest surface is
  // on the app origin too — /api/review/file must apply the same policy).
  ({ createReviewLink, claimReviewLink } = await import('../db/review-links.js'));
  const { token } = createReviewLink({
    projectId: PROJECT_A, path: 'draft/evil.html', mode: 'view', createdBy: 1,
  });
  const claim = claimReviewLink(token, 'Reviewer');
  reviewerCookie = claim.cookieValue;

  ({ rawContentPolicy } = await import('../raw-content.js'));

  const { session } = await import('../session.js');
  const app = express();
  app.use(express.json());
  // Mount order mirrors index.js: review BEFORE session() (guest surface),
  // then the member routers under test.
  app.use((await import('./review.js')).default);
  app.use(session);
  app.use((await import('./files.js')).default);
  app.use((await import('./history.js')).default);
  app.use((await import('./org-library.js')).default);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;

  // Org doc ids used by the assertions below.
  orgDocIds = { html: orgDocs.html.id, txt: orgDocs.txt.id, png: orgDocs.png.id, noext: orgDocs.noext.id };
});
afterAll(async () => {
  config.auth.mode = saved.mode;
  config.auth.sessionSecret = saved.secret;
  config.agent.projectsRoot = saved.projectsRoot;
  config.storage.orgsRoot = saved.orgsRoot;
  config.history.enabled = saved.history;
  await new Promise((ok) => server.close(ok));
  await rm(projectsRoot, { recursive: true, force: true });
  await rm(orgsRoot, { recursive: true, force: true });
});

/** One member request as a principal (omitted principal = unauthenticated). */
function call(method, path, principal, req = {}) {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const headers = {};
  if (principal) headers.Cookie = `kuhn_session=${encodeURIComponent(cookies[principal])}`;
  if (req.json !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, { method, headers, body: req.json !== undefined ? JSON.stringify(req.json) : undefined });
}

const fileUrl = (path) => `/api/projects/${PROJECT_A}/file?path=${encodeURIComponent(path)}`;
const orgUrl = (docId) => `/api/orgs/${ORG_A}/library/${docId}/content`;

/** Policy header expectation shorthand for the HTTP checks. */
const expectRawHeaders = (res, { contentType, disposition }) => {
  expect(res.headers.get('x-content-type-options')).toBe(NOSNIFF);
  expect(res.headers.get('content-type')).toBe(contentType);
  if (disposition == null) {
    expect(res.headers.get('content-disposition')).toBeNull();
  } else {
    expect(res.headers.get('content-disposition')).toBe(disposition);
  }
};

describe('rawContentPolicy (pure classification, STH-16)', () => {
  const cases = [
    // malicious active content — never inline
    { name: 'evil.html', ct: OCTET, disposition: 'attachment; filename="evil.html"' },
    { name: 'evil.htm', ct: OCTET, disposition: 'attachment; filename="evil.htm"' },
    { name: 'evil.svg', ct: OCTET, disposition: 'attachment; filename="evil.svg"' },
    // mixed-case extensions — same decision, lowercased
    { name: 'Evil.HTML', ct: OCTET, disposition: 'attachment; filename="Evil.HTML"' },
    { name: 'evil.HtMl', ct: OCTET, disposition: 'attachment; filename="evil.HtMl"' },
    { name: 'evil.SVG', ct: OCTET, disposition: 'attachment; filename="evil.SVG"' },
    { name: 'photo.PnG', ct: 'image/png', disposition: null },
    // the last extension decides (a wrong label is safe: the declared MIME +
    // nosniff are what the browser trusts, never the bytes)
    { name: 'evil.html.png', ct: 'image/png', disposition: null },
    // unknown / binary / extensionless — download
    { name: 'data.bin', ct: OCTET, disposition: 'attachment; filename="data.bin"' },
    { name: 'README', ct: OCTET, disposition: 'attachment; filename="README"' },
    { name: '.env', ct: OCTET, disposition: 'attachment; filename=".env"' },
    { name: 'doc.docx', ct: OCTET, disposition: 'attachment; filename="doc.docx"' },
    // directories in the path — the base name drives the decision + download name
    { name: 'draft/sub/deep/evil.html', ct: OCTET, disposition: 'attachment; filename="evil.html"' },
    { name: 'draft/sub/deep/notes.md', ct: 'text/markdown; charset=utf-8', disposition: null },
    // ordinary text — inline
    { name: 'notes.md', ct: 'text/markdown; charset=utf-8', disposition: null },
    { name: 'note.txt', ct: 'text/plain; charset=utf-8', disposition: null },
    { name: 'refs.bib', ct: 'text/plain; charset=utf-8', disposition: null },
    { name: 'data.csv', ct: 'text/csv; charset=utf-8', disposition: null },
    { name: 'config.json', ct: 'application/json', disposition: null },
    { name: 'spec.yaml', ct: 'text/plain; charset=utf-8', disposition: null },
    // ordinary raster images — inline (SVG deliberately absent)
    { name: 'photo.jpg', ct: 'image/jpeg', disposition: null },
    { name: 'photo.jpeg', ct: 'image/jpeg', disposition: null },
    { name: 'anim.gif', ct: 'image/gif', disposition: null },
    { name: 'photo.webp', ct: 'image/webp', disposition: null },
    // PDF — the allowlisted exception (the webapp previews it in an iframe)
    { name: 'paper.pdf', ct: 'application/pdf', disposition: null },
  ];

  for (const c of cases) {
    it(`classifies ${JSON.stringify(c.name)}`, () => {
      expect(rawContentPolicy(c.name)).toEqual({ contentType: c.ct, disposition: c.disposition });
    });
  }

  it('sanitizes hostile filenames out of the Content-Disposition header', () => {
    // header injection: CRLF in the name must not yield a second header line —
    // the controls are stripped, the remainder stays a single legal value
    const crlf = rawContentPolicy('evil\r\nX-Injected: 1.html');
    expect(crlf.disposition).toBe('attachment; filename="evilX-Injected: 1.html"');
    expect(crlf.disposition).not.toMatch(/\r|\n/);
    // quotes and backslashes cannot terminate the quoted filename
    expect(rawContentPolicy('evil"quote.html').disposition).toBe('attachment; filename="evilquote.html"');
    expect(rawContentPolicy('a\\b.html').disposition).toBe('attachment; filename="ab.html"');
    // a name that sanitizes to nothing still yields a legal header
    expect(rawContentPolicy('\u0007\u0007').disposition).toBe('attachment; filename="file"');
  });

  it('serves non-ASCII download names via RFC 5987 with an ASCII fallback', () => {
    const p = rawContentPolicy('协议.html');
    expect(p.disposition).toBe(
      `attachment; filename="__.html"; filename*=UTF-8''${encodeURIComponent('协议.html')}`,
    );
    expect(p.disposition).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  });
});

describe('HTTP: raw bytes routes apply the policy (STH-16)', () => {
  describe('GET /api/projects/:id/file (T-12)', () => {
    it('serves a malicious .html as an inert download, never inline', async () => {
      const res = await call('GET', fileUrl('draft/evil.html'), 'viewer');
      expect(res.status).toBe(200);
      expectRawHeaders(res, { contentType: OCTET, disposition: 'attachment; filename="evil.html"' });
      expect(await res.text()).toBe(EVIL_HTML);
    });

    it('applies the same policy to mixed-case .HTML/.HtMl/.SVG names', async () => {
      const html = await call('GET', fileUrl('draft/Evil.HtMl'), 'viewer');
      expect(html.status).toBe(200);
      expect(html.headers.get('content-type')).toBe(OCTET);
      expect(html.headers.get('content-disposition')).toBe('attachment; filename="Evil.HtMl"');
      expect(html.headers.get('x-content-type-options')).toBe(NOSNIFF);
      expect(await html.text()).toBe(EVIL_HTML);

      const svg = await call('GET', fileUrl('draft/mixed.SvG'), 'viewer');
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-type')).toBe(OCTET);
      expect(svg.headers.get('content-disposition')).toBe('attachment; filename="mixed.SvG"');
      expect(await svg.text()).toBe(EVIL_SVG);
    });

    it('serves unknown/binary types as octet-stream downloads with nosniff', async () => {
      const res = await call('GET', fileUrl('draft/data.bin'), 'viewer');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(OCTET);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="data.bin"');
      expect(res.headers.get('x-content-type-options')).toBe(NOSNIFF);
    });

    it('serves non-ASCII names with an RFC 5987 filename', async () => {
      const res = await call('GET', fileUrl('draft/协议.bin'), 'viewer');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(OCTET);
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="__.bin"; filename*=UTF-8''${encodeURIComponent('协议.bin')}`,
      );
    });

    it('keeps ordinary .md/.txt inline with their text types and no disposition', async () => {
      const md = await call('GET', fileUrl('draft/notes.md'), 'viewer');
      expect(md.status).toBe(200);
      expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(md.headers.get('content-disposition')).toBeNull();
      expect(md.headers.get('x-content-type-options')).toBe(NOSNIFF);
      expect(await md.text()).toBe('# notes\n');

      const txt = await call('GET', fileUrl('draft/note.txt'), 'viewer');
      expect(txt.status).toBe(200);
      expect(txt.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(txt.headers.get('content-disposition')).toBeNull();
    });

    it('keeps raster images inline (case-insensitive), SVG is not among them', async () => {
      const png = await call('GET', fileUrl('draft/photo.png'), 'viewer');
      expect(png.status).toBe(200);
      expect(png.headers.get('content-type')).toBe('image/png');
      expect(png.headers.get('content-disposition')).toBeNull();

      const jpg = await call('GET', fileUrl('draft/photo.JPG'), 'viewer');
      expect(jpg.headers.get('content-type')).toBe('image/jpeg');
      expect(jpg.headers.get('content-disposition')).toBeNull();
      // a .svg would be a download — covered by the mixed.SvG case above;
      // pin the negative here too: no image/svg+xml ever leaves this route
      expect(jpg.headers.get('content-type')).not.toContain('svg');
    });

    it('keeps PDFs inline (the allowlisted preview exception)', async () => {
      const res = await call('GET', fileUrl('draft/doc.pdf'), 'viewer');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe(NOSNIFF);
    });

    it('leaves tenancy unchanged: stranger 404, unauthenticated 401', async () => {
      const stranger = await call('GET', fileUrl('draft/evil.html'), 'stranger');
      expect(stranger.status).toBe(404);
      expect((await stranger.json()).error).toBe('project not found');

      const anon = await call('GET', fileUrl('draft/evil.html'), null);
      expect(anon.status).toBe(401);
    });
  });

  describe('GET /api/orgs/:orgId/library/:docId/content (T-13)', () => {
    it('ignores the stored client-supplied text/html MIME on a .html document', async () => {
      const res = await call('GET', orgUrl(orgDocIds.html), 'viewer');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(OCTET);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="lib-evil.html"');
      expect(res.headers.get('x-content-type-options')).toBe(NOSNIFF);
      expect(await res.text()).toBe(EVIL_HTML);
    });

    it('classifies by extension when the stored MIME is misleading (safe type wins)', async () => {
      // lib-notes.txt stored with mime text/html: served as text/plain — the
      // declared type the browser will trust (with nosniff), never the stored one
      const res = await call('GET', orgUrl(orgDocIds.txt), 'viewer');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe(NOSNIFF);
    });

    it('keeps allowlisted raster documents inline', async () => {
      const res = await call('GET', orgUrl(orgDocIds.png), 'viewer');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-disposition')).toBeNull();
    });

    it('serves extensionless documents as downloads even with an active stored MIME', async () => {
      const res = await call('GET', orgUrl(orgDocIds.noext), 'viewer');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(OCTET);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="lib-noext"');
      expect(res.headers.get('x-content-type-options')).toBe(NOSNIFF);
    });

    it('leaves tenancy unchanged: non-member org owner gets the non-leaking 404', async () => {
      const res = await call('GET', orgUrl(orgDocIds.html), 'stranger');
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('organization not found');
    });
  });

  describe('GET /api/review/file (guest surface, same class)', () => {
    it('serves the linked document through the same policy with the guest cookie', async () => {
      const res = await fetch(`${base}/api/review/file`, {
        headers: { Cookie: `kuhn_review_session=${encodeURIComponent(reviewerCookie)}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(OCTET);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="evil.html"');
      expect(res.headers.get('x-content-type-options')).toBe(NOSNIFF);
      expect(await res.text()).toBe(EVIL_HTML);
    });

    it('refuses without a review session (401, unchanged)', async () => {
      const res = await fetch(`${base}/api/review/file`);
      expect(res.status).toBe(401);
    });
  });
});
