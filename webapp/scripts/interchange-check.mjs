// Token-free check for the interchange endpoints (issues #153/#154,
// docs/specs/interchange-bundle.md). Backend only — no browser, no LLM
// tokens. Needs the backend in dev auth mode (x-kuhn-user header):
//   BACKEND_URL=http://localhost:3102 node scripts/interchange-check.mjs
//
// Walks the sciwriter round trip end to end against a REAL backend:
//   1. push the fixture bundle (test-projects/interchange) → a new project
//   2. export → content, provenance and references come back as pushed
//   3. edit the doc through the file API and add a comment through the
//      comments API (what a reviewer does in Kuhn)
//   4. export → modified_since_import, the comment with a member author and
//      a re-resolved anchor
//   5. re-push an edited bundle → existing comment re-anchored, checkpoint moves
//   6. export as zip → import into a second project → export again: docs and
//      references identical (the format round-trips through Kuhn itself)
// Projects are left in place (they are disposable dev data); their ids print.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The backend's zip library — this script is monorepo dev tooling, so it
// borrows the dependency rather than adding one to the webapp.
import { strToU8, zipSync } from '../../agent-backend/node_modules/fflate/esm/index.mjs';

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3002';
const USER = process.env.KUHN_CHECK_USER ?? 'interchange-check@kuhn.local';
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../test-projects/interchange');
const DOC = 'draft/main.md';

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (cond, msg) => { if (!cond) fail(msg); return cond; };

const headers = { 'x-kuhn-user': USER };
const api = (path, init = {}) => fetch(`${BACKEND}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });

function readTree(dir, prefix = '') {
  const out = {};
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) Object.assign(out, readTree(abs, rel));
    else if (rel !== 'README.md') out[rel] = new Uint8Array(readFileSync(abs));
  }
  return out;
}
const fixture = readTree(FIXTURE);
const fixtureDoc = Buffer.from(fixture[`files/${DOC}`]).toString('utf-8');
const bundleZip = (over = {}) => {
  const entries = { ...fixture };
  for (const [k, v] of Object.entries(over)) entries[k] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(entries);
};

async function importBundle(path, zip, fields = {}) {
  const fd = new FormData();
  fd.append('bundle', new Blob([zip], { type: 'application/zip' }), 'bundle.zip');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await api(path, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const exportJson = async (id, query = '') => (await api(`/api/projects/${id}/export${query}`)).json();

// 1. push
const created = await importBundle('/api/projects/import', bundleZip());
check(created.status === 201, `create: expected 201, got ${created.status} ${JSON.stringify(created.body)}`);
const projectId = created.body?.project?.id;
if (!projectId) {
  console.error('FAIL: could not create a project from the fixture bundle');
  process.exit(1);
}
check(created.body.files.length === 2, `create: expected 2 files, got ${JSON.stringify(created.body.files)}`);
check(created.body.references.every((r) => r.status === 'created' && r.actual_key === r.cite_key), `create: references ${JSON.stringify(created.body.references)}`);
check(/^[0-9a-f]{40}$/.test(created.body.checkpoint ?? ''), `create: checkpoint ${created.body.checkpoint}`);

// 2. export as pushed
const first = await exportJson(projectId);
check(first.docs?.length === 1 && first.docs[0].content === fixtureDoc, 'export 1: doc content differs from the pushed doc');
check(first.docs?.[0]?.modified_since_import === false, 'export 1: modified_since_import should be false');
check(first.last_import?.checkpoint === created.body.checkpoint, 'export 1: last_import.checkpoint mismatch');
check(first.revision === created.body.checkpoint, 'export 1: revision should equal the import checkpoint');
check(first.references?.length === 2, `export 1: expected 2 references, got ${first.references?.length}`);
check(first.docs?.[0]?.meta?.figure_numbering?.['fig:forest'] === 1, 'export 1: doc meta not echoed');

// 3. a reviewer edits in Kuhn and comments
const quote = 'Response rates exceeded 60%';
const edited = `# Retitled in Kuhn\n\n${fixtureDoc}`;
const fileUrl = `/api/projects/${projectId}/file?path=${encodeURIComponent(DOC)}`;
await api(fileUrl, { method: 'DELETE' }); // evicts any warm room from a previous run
const put = await api(`${fileUrl}&checkpoint=1`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: edited });
check(put.ok, `edit: PUT failed ${put.status}`);
const commentRes = await api(`/api/projects/${projectId}/comments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: DOC, body: 'Which trial reported this?', anchor: { quote, start: edited.indexOf(quote), end: edited.indexOf(quote) + quote.length } }),
});
check(commentRes.status === 201 || commentRes.status === 200, `comment: expected 201, got ${commentRes.status}`);

// 4. export reflects the edit and the comment
const second = await exportJson(projectId);
const doc2 = second.docs?.[0];
check(doc2?.modified_since_import === true, 'export 2: modified_since_import should be true');
check(doc2?.content === edited, 'export 2: content should be the edited text');
const thread = doc2?.comments?.find((c) => c.body === 'Which trial reported this?');
check(!!thread, 'export 2: the comment is missing');
check(thread?.author?.kind === 'member', `export 2: author kind ${thread?.author?.kind}`);
check(thread?.anchor?.start === edited.indexOf(quote) && thread?.orphaned === false, 'export 2: anchor not resolved against the edited text');

// 5. re-push a further-edited bundle: the comment moves with its quote
const repushed = `# Round 2\n\nA new opening paragraph from sciwriter.\n\n${fixtureDoc}`;
const update = await importBundle(`/api/projects/${projectId}/import`, bundleZip({ [`files/${DOC}`]: repushed }), { label: 'round 2' });
check(update.status === 200, `update: expected 200, got ${update.status} ${JSON.stringify(update.body)}`);
check(update.body?.comments?.reanchored === 1 && update.body?.comments?.orphaned === 0, `update: comments ${JSON.stringify(update.body?.comments)}`);
check(update.body?.checkpoint && update.body.checkpoint !== created.body.checkpoint, 'update: checkpoint should move');
const third = await exportJson(projectId);
check(third.docs?.[0]?.modified_since_import === false, 'export 3: doc should match the re-push');
check(third.docs?.[0]?.comments?.[0]?.anchor?.start === repushed.indexOf(quote), 'export 3: anchor should follow the quote');

// 6. zip round trip through a second project
const zipRes = await api(`/api/projects/${projectId}/export?format=zip`);
check(zipRes.headers.get('content-type')?.includes('application/zip'), 'export zip: wrong content type');
const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
const twin = await importBundle('/api/projects/import', zipBytes);
check(twin.status === 201, `twin: expected 201, got ${twin.status} ${JSON.stringify(twin.body)}`);
const twinId = twin.body?.project?.id;
if (twinId) {
  const fourth = await exportJson(twinId);
  const strip = (d) => ({ path: d.path, content: d.content, title: d.title, meta: d.meta });
  check(JSON.stringify(fourth.docs.map(strip)) === JSON.stringify(third.docs.map(strip)), 'twin: docs differ after the round trip');
  check(JSON.stringify(fourth.references) === JSON.stringify(third.references), 'twin: references differ after the round trip');
  check(fourth.last_import?.source?.tool === 'kuhn' && fourth.last_import?.source?.project_id === projectId, 'twin: provenance should point at the source project');
  check((twin.body.files ?? []).some((f) => f.path === 'draft/figures/fig1.png'), 'twin: figure asset did not ride along');
}

console.log(`projects: ${projectId} (pushed), ${twinId ?? '—'} (round-trip twin)`);
if (errors.length) {
  console.error(`FAIL (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('PASS: interchange push → review → pull → re-push → zip round trip');
