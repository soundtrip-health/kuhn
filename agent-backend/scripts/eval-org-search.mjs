// Story 006-003: FTS relevance eval for search_org_knowledge — token-free
// (calls the search layer directly; no model, no server).
//
//   KUHN_DATA_DIR=~/.kuhn-scratch-006 node scripts/eval-org-search.mjs <orgId>
//
// Fixture: an org with guidance-docs/ imported via scripts/import-guidance.mjs
// (story 006-002). Each case is a query an agent would plausibly issue; it
// passes when one of the expected documents ranks in the top 3. Results are
// recorded in docs/epics/006-org-knowledge-library/stories/003-*.md — they are
// the evidence for/against a future embeddings story.

const orgId = parseInt(process.argv[2]);
if (Number.isNaN(orgId)) {
  console.error('Usage: node scripts/eval-org-search.mjs <orgId>');
  process.exit(1);
}

const { initDb } = await import('../src/db/init.js');
await initDb();
const { searchOrgKnowledge, hasReadyOrgDocuments } = await import('../src/db/org-documents.js');

if (!hasReadyOrgDocuments(orgId)) {
  console.error(`Org ${orgId} has no ready library documents — import the fixture first:`);
  console.error('  npm run import:guidance -- <orgId>');
  process.exit(1);
}

// expect: filenames accepted as a hit (some topics legitimately live in more
// than one corpus document, e.g. TMS/MDD).
const CASES = [
  { query: 'non-inferiority margin justification', expect: ['non-inferior-guidance.pdf'] },
  { query: 'target trial emulation observational study', expect: ['tte_design_2026.pdf'] },
  { query: 'CONSORT flow diagram reporting', expect: ['consort_diagram_2014.pdf'] },
  { query: 'estimand intercurrent events sensitivity analysis', expect: ['stats-principles-estimands-sensitivity.pdf'] },
  { query: 'real-world evidence program framework', expect: ['framework.pdf'] },
  { query: 'major depressive disorder drug development endpoints', expect: ['mdd-developing-drugs-guidance.pdf'] },
  { query: 'transcranial magnetic stimulation depression clearance', expect: ['tms_example.pdf', 'tms_mdd_rwe.md'] },
  { query: 'electronic health records claims data fitness regulatory decision', expect: ['assessing.pdf'] },
  { query: 'non-interventional study design considerations', expect: ['considerations.pdf'] },
  { query: 'suicidality incidence finasteride', expect: ['ema_example.pdf'] },
  { query: 'heliotrope amendment sign-off', expect: ['heliotrope.txt'] },
];

let passed = 0;
for (const { query, expect } of CASES) {
  const results = searchOrgKnowledge(orgId, query, 8);
  const hitIndex = results.findIndex((r) => expect.includes(r.filename));
  const ok = hitIndex >= 0 && hitIndex < 3;
  if (ok) passed += 1;
  const got = results.slice(0, 3).map((r) => r.filename).join(', ') || '(no matches)';
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${query}"`);
  console.log(`      expected ${expect.join(' | ')} in top 3 — got: ${got}${hitIndex >= 3 ? ` (hit at #${hitIndex + 1})` : ''}`);
}

console.log(`\n${passed}/${CASES.length} queries ranked the expected document in the top 3.`);
process.exit(passed === CASES.length ? 0 : 1);
