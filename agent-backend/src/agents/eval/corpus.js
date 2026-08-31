/**
 * Quality-baseline corpus loader (STH-31).
 *
 * The corpus is a versioned, public, fully synthetic fixture set
 * (corpus/manifest.json + the files it lists). Every case in cases.js
 * composes its project fixture out of corpus files, so the corpus hash
 * recorded in a result run is the single fixture identity both the
 * pre-migration Claude baseline and the post-migration Pi run share.
 *
 * Nothing here imports Kuhn application code — the corpus must be loadable
 * (and hashable) before any production module is imported, because the
 * runner pins environment variables before importing config.js.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CORPUS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'corpus');

/** sha256 over the canonical JSON of the value (sorted keys). */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

/**
 * Load the corpus: manifest + every listed file (text), plus literature.json
 * parsed. Returns { version, hash, manifest, files: {rel: content}, literature }.
 * Throws on a missing file or a file listed twice — a corrupt corpus must
 * never silently produce a "valid" baseline run.
 */
export function loadCorpus() {
  const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf-8'));
  const files = {};
  for (const entry of manifest.files) {
    const abs = join(CORPUS_DIR, entry.path);
    if (!existsSync(abs)) throw new Error(`corpus file missing: ${entry.path}`);
    if (files[entry.path] != null) throw new Error(`corpus file listed twice: ${entry.path}`);
    files[entry.path] = readFileSync(abs, 'utf-8');
  }
  const literature = JSON.parse(files['literature.json']);
  // Fixture identity: version + content hash over the canonical corpus JSON.
  const hash = createHash('sha256')
    .update(canonicalJson({ version: manifest.version, files }))
    .digest('hex');
  return { version: manifest.version, hash, manifest, files, literature };
}

/**
 * Compose the seedFixture() fixture shape (conformance/harness.js) from the
 * corpus for one eval case. `caseFixture` maps project-relative paths to
 * corpus file keys, names org documents, and selects the literature subset.
 */
export function composeCaseFixture(corpus, caseFixture) {
  const files = {};
  for (const [relPath, corpusKey] of Object.entries(caseFixture.files ?? {})) {
    if (!(corpusKey in corpus.files)) {
      throw new Error(`case fixture: unknown corpus file ${corpusKey} (for ${relPath})`);
    }
    files[relPath] = corpus.files[corpusKey];
  }

  const orgDocuments = (caseFixture.orgDocuments ?? []).map((doc) => {
    const key = doc.corpusKey;
    if (!(key in corpus.files)) throw new Error(`case fixture: unknown corpus org document ${key}`);
    const body = corpus.files[key];
    const chunks = [];
    // Chunk on markdown headings the way the org-knowledge ingestion does,
    // so search_org_knowledge ranks per-section.
    const headingRe = /^(#{1,6})\s+(.*)$/;
    let path = [];
    for (const line of body.split('\n')) {
      const m = line.match(headingRe);
      if (m) {
        path = [...path.slice(0, m[1].length - 1), m[2].trim()];
        continue;
      }
      if (line.trim() === '') continue;
      chunks.push({ headingPath: path.length > 0 ? path.join(' > ') : null, text: line.trim() });
    }
    return { title: doc.title, filename: doc.filename ?? key, chunks };
  });

  // Literature subset: keep only the PMIDs the case's checks reason about,
  // but keep the full search map (a case's checks may reference the queries
  // the model is expected to issue).
  const literature = { pmids: {}, searches: {}, arxiv: {} };
  const keep = new Set(caseFixture.literature ?? Object.keys(corpus.literature.pmids));
  for (const pmid of keep) {
    if (!(pmid in corpus.literature.pmids)) {
      throw new Error(`case fixture: unknown corpus PMID ${pmid}`);
    }
    literature.pmids[pmid] = corpus.literature.pmids[pmid];
  }
  for (const [q, pmids] of Object.entries(corpus.literature.searches ?? {})) {
    const hits = pmids.filter((p) => keep.has(p));
    if (hits.length > 0) literature.searches[q] = hits;
  }
  return {
    project: caseFixture.project ?? null,
    files,
    orgDocuments,
    literature,
  };
}
