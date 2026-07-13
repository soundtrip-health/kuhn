// Story 006-002: import the curated repo corpus (guidance-docs/) into an
// org's knowledge library and ingest it synchronously. This is the seed/eval
// fixture path — per-org, on request, never globally wired.
//
//   node scripts/import-guidance.mjs <orgId> [subdir]
//
// Runs in-process against the configured KUHN_DATA_DIR (no server needed).
// Requires Docker for pdf/docx extraction; md/txt need nothing.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const orgId = parseInt(process.argv[2]);
const subdir = process.argv[3] ?? '';
if (Number.isNaN(orgId)) {
  console.error('Usage: node scripts/import-guidance.mjs <orgId> [subdir]');
  process.exit(1);
}

const { initDb } = await import('../src/db/init.js');
await initDb();
const { querySync } = await import('../src/db.js');
const { storeOrgDocument } = await import('../src/routes/org-library.js');
const { ingestOrgDocument } = await import('../src/ingest.js');

const org = querySync('SELECT id, name FROM organizations WHERE id = $1', [orgId]).rows[0];
if (!org) {
  console.error(`No organization with id ${orgId}`);
  process.exit(1);
}

const corpusRoot = resolve(fileURLToPath(new URL('../../guidance-docs', import.meta.url)), subdir);
const IMPORTABLE = /\.(md|markdown|txt|pdf|docx|odt|html?|rtf|epub|bib|csv|json)$/i;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (entry.isFile() && IMPORTABLE.test(entry.name)) yield abs;
  }
}

let imported = 0;
let deduped = 0;
let failed = 0;

for await (const abs of walk(corpusRoot)) {
  const rel = relative(corpusRoot, abs);
  const buffer = await readFile(abs);
  const { document, deduped: wasDupe } = await storeOrgDocument(orgId, buffer, {
    filename: rel.split('/').pop(),
    title: rel.replace(/\.[^.]+$/, ''),
    source: 'guidance-import',
    ingest: false, // ingest inline below so the script reports real statuses
  });
  if (wasDupe) {
    deduped += 1;
    console.log(`= ${rel} (already imported as #${document.id})`);
    continue;
  }
  await ingestOrgDocument(orgId, document.id);
  const status = querySync('SELECT status, status_detail FROM org_documents WHERE id = $1', [document.id]).rows[0];
  if (status.status === 'ready') {
    imported += 1;
    console.log(`+ ${rel} → #${document.id} ready`);
  } else {
    failed += 1;
    console.log(`! ${rel} → #${document.id} ${status.status}: ${status.status_detail}`);
  }
}

console.log(`\nImported ${imported} into "${org.name}" (${deduped} already present, ${failed} failed).`);
process.exit(failed > 0 ? 2 : 0);
