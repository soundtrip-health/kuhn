/**
 * Fixture-driven fakes for the two networked services the app runtime
 * touches (STH-5). The vitest test file's vi.mock factories delegate to
 * these; the harness sets the fixtures per scenario via setSearchFixture() /
 * setSandboxFixture().
 *
 * These fakes replace only the network I/O (PubMed/ArXiv HTTP, the Docker
 * sandbox). Everything around them — the tool handlers, argument
 * validation, result shaping — is the real application code.
 */
let searchFixture = { pmids: {}, searches: {}, arxiv: {} };
let sandboxFixture = { scripts: {} };

export function setSearchFixture(f) { searchFixture = f ?? { pmids: {}, searches: {}, arxiv: {} }; }
export function setSandboxFixture(f) { sandboxFixture = f ?? { scripts: {} }; }

/** pubmedSearch(searchQuery, maxResults) — matches the fixture's scripted
 * query→PMID map (query substring) first, then the indexed records. */
export async function fakePubmedSearch(query, maxResults = 10) {
  const q = String(query).toLowerCase();
  for (const [key, pmids] of Object.entries(searchFixture.searches ?? {})) {
    if (q.includes(key.toLowerCase())) {
      return pmids.map((pmid) => ({ pmid, ...((searchFixture.pmids ?? {})[String(pmid)] ?? {}) }));
    }
  }
  const hits = Object.entries(searchFixture.pmids ?? {})
    .filter(([, rec]) => JSON.stringify(rec).toLowerCase().includes(q.slice(0, 16)))
    .slice(0, maxResults)
    .map(([pmid, rec]) => ({ pmid, ...rec }));
  return hits;
}

/** arxivSearch(searchQuery, maxResults) — scripted query→hit map. */
export async function fakeArxivSearch(query, maxResults = 10) {
  const q = String(query).toLowerCase();
  for (const [key, hits] of Object.entries(searchFixture.arxiv ?? {})) {
    if (q.includes(key.toLowerCase())) return hits.slice(0, maxResults);
  }
  return [];
}

export class SandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/** runScriptSandboxed(projectId, { script, args, language }) — the fixture
 * keys by the script's workspace-relative path. */
export function fakeRunScriptSandboxed(projectId, { script, language }) {
  const spec = (sandboxFixture.scripts ?? {})[script];
  if (!spec) throw new SandboxError('script_not_found', `No such script: ${script}`);
  if (spec.exitCode != null && spec.exitCode !== 0) {
    throw new SandboxError('nonzero_exit', `Script exited ${spec.exitCode}: ${spec.stderr ?? ''}`);
  }
  return { stdout: spec.stdout ?? '', stderr: spec.stderr ?? '', exitCode: spec.exitCode ?? 0, language };
}

// ---------------------------------------------------------------------------
// PubMed efetch (citations.js's fetchPubmedRecord calls globalThis.fetch
// directly — the only remaining network hop in the citation path). The fake
// renders fixture PMIDs as the NBIB text the real parseNbib() expects, so the
// real parse/insert/materialize code runs.
// ---------------------------------------------------------------------------
let fetchFixture = { pmids: {} };

export function setFetchFixture(f) { fetchFixture = f ?? { pmids: {} }; }

/** NBIB (Medline) text for one fixture record — the `TAG - value` format. */
export function nbibText(pmid, rec) {
  const lines = [`PMID- ${pmid}`];
  if (rec?.title) lines.push(`TI   - ${rec.title}`);
  for (const author of rec?.authors ?? []) lines.push(`FAU  - ${author}`);
  if (rec?.journal) lines.push(`JT   - ${rec.journal}`);
  if (rec?.pubdate) lines.push(`DP   - ${rec.pubdate}`);
  if (rec?.doi) lines.push(`LID  - ${rec.doi} [doi]`);
  return lines.join('\n');
}

let realFetch = null;

/** Install the eutils intercept once; non-eutils URLs pass through. */
export function installFetchFake() {
  if (realFetch) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('eutils.ncbi.nlm.nih.gov')) {
      const pmid = new URL(u).searchParams.get('id');
      const rec = fetchFixture.pmids?.[String(pmid ?? '')];
      if (!rec) return new Response('', { status: 404 });
      return new Response(nbibText(pmid, rec), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return realFetch(url, opts);
  };
}

export function restoreFetchFake() {
  if (!realFetch) return;
  globalThis.fetch = realFetch;
  realFetch = null;
}
