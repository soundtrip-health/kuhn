// Story 016: citation service — PubMed-grounded search and BibTeX upsert into
// the project bibliography. Consumed by the /cite editor command (routes) and
// the add_citation agent tool. Every candidate and every BibTeX field comes
// from PubMed metadata; nothing here is model-generated (Epic 003 grounding
// rule). The pure helpers are exported for tests.

import { pubmedSearch } from './agents/search.js';
import { StorageError, readProjectFile, writeProjectFile } from './storage.js';

export const DEFAULT_BIB_PATH = 'draft/references.bib';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/** Upstream (NCBI) failure — routes map this to 502 instead of 500. */
export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
  }
}

// NCBI E-utilities allows 3 requests/second without an API key; space all
// calls from this process so bursts from the picker or agents stay polite.
const MIN_REQUEST_INTERVAL_MS = 350;
let nextSlot = 0;
async function rateLimit() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_REQUEST_INTERVAL_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Search PubMed for citation candidates.
 * @returns {Promise<Array<{pmid, title, authors, journal, year, doi}>>}
 */
export async function searchCitations(query, maxResults = 8) {
  await rateLimit();
  let results;
  try {
    results = await pubmedSearch(query, maxResults);
  } catch (err) {
    throw new UpstreamError(err.message);
  }
  return results.map((doc) => ({
    pmid: doc.pmid,
    title: doc.title,
    authors: doc.authors,
    journal: doc.journal,
    year: doc.pubdate?.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? null,
    doi: doc.doi,
  }));
}

/**
 * Fetch the full PubMed record for a PMID (efetch, MEDLINE/nbib format) and
 * normalize it to the fields a BibTeX entry needs. Returns null when PubMed
 * has no record for the id.
 */
export async function fetchPubmedRecord(pmid) {
  const params = new URLSearchParams({
    db: 'pubmed',
    id: String(pmid),
    rettype: 'medline',
    retmode: 'text',
  });
  let res;
  for (let attempt = 0; ; attempt++) {
    await rateLimit();
    res = await fetch(`${EUTILS}/efetch.fcgi?${params}`);
    if (res.status !== 429 || attempt >= 2) break;
    // NCBI throttles in bursts; back off and retry a couple of times
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  if (!res.ok) throw new UpstreamError(`PubMed efetch failed: HTTP ${res.status}`);
  const record = parseNbib(await res.text())[0];
  if (!record?.pmid) return null;
  return record;
}

/**
 * Parse MEDLINE/nbib text (the `TAG - value` format efetch returns) into
 * normalized records. Continuation lines (leading whitespace) extend the
 * previous tag's value.
 */
export function parseNbib(text) {
  const records = [];
  let current = null;
  let lastKey = null;

  const ensure = () => {
    if (!current) current = { authors: [], authorsShort: [] };
    return current;
  };
  const push = () => {
    if (current?.pmid || current?.title) {
      if (current.authors.length === 0) current.authors = current.authorsShort;
      delete current.authorsShort;
      records.push(current);
    }
    current = null;
    lastKey = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      push();
      continue;
    }
    const match = line.match(/^([A-Z0-9]{2,4})\s*-\s(.*)$/);
    if (!match) {
      // Continuation of the previous field
      if (lastKey && current && typeof current[lastKey] === 'string') {
        current[lastKey] += ` ${line.trim()}`;
      }
      continue;
    }
    const [, tag, value] = match;
    const rec = ensure();
    lastKey = null;
    if (tag === 'PMID') rec.pmid = value.trim();
    else if (tag === 'TI') { rec.title = value; lastKey = 'title'; }
    else if (tag === 'AB') { rec.abstract = value; lastKey = 'abstract'; }
    else if (tag === 'FAU') rec.authors.push(value.trim());
    else if (tag === 'AU') rec.authorsShort.push(value.trim());
    else if (tag === 'JT') rec.journal = value.trim();
    else if (tag === 'TA') rec.journalAbbrev = value.trim();
    else if (tag === 'DP') rec.year = value.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? null;
    else if (tag === 'VI') rec.volume = value.trim();
    else if (tag === 'IP') rec.issue = value.trim();
    else if (tag === 'PG') rec.pages = value.trim();
    else if ((tag === 'LID' || tag === 'AID') && value.includes('[doi]')) {
      rec.doi = value.replace(/\s*\[doi\]\s*$/, '').trim();
    }
  }
  push();
  return records;
}

const normalizeDoi = (doi) => String(doi ?? '').trim().replace(/[.,;)\s]+$/, '').toLowerCase();

/**
 * Generate a citation key: first author's last name + year (`smith2024`),
 * with `a`, `b`, … suffixes when the base key is already taken by a
 * different work.
 */
export function makeCitekey(record, takenKeys) {
  const firstAuthor = record.authors?.[0] ?? '';
  const lastName = firstAuthor.split(',')[0].normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase() || 'anon';
  const base = `${lastName}${record.year ?? 'nd'}`;
  if (!takenKeys.has(base)) return base;
  for (let i = 0; ; i++) {
    const candidate = `${base}${String.fromCharCode(97 + (i % 26)).repeat(Math.floor(i / 26) + 1)}`;
    if (!takenKeys.has(candidate)) return candidate;
  }
}

const escapeBib = (value) => String(value).replace(/([&%#])/g, '\\$1');

/** Render a normalized PubMed record as a BibTeX @article entry. */
export function formatBibEntry(record, key) {
  const fields = [];
  const add = (name, value) => {
    if (value != null && String(value).trim() !== '') fields.push(`  ${name} = {${escapeBib(value)}}`);
  };
  add('author', record.authors?.length ? record.authors.join(' and ') : null);
  add('title', record.title?.replace(/\.$/, ''));
  add('journal', record.journal ?? record.journalAbbrev);
  add('year', record.year);
  add('volume', record.volume);
  add('number', record.issue);
  add('pages', record.pages?.includes('-') ? record.pages.replace(/\s*-\s*/, '--') : record.pages);
  add('doi', record.doi);
  add('pmid', record.pmid);
  return `@article{${key},\n${fields.join(',\n')}\n}`;
}

/**
 * Parse a BibTeX file just far enough for dedup: entry keys plus any doi and
 * pmid fields. Tolerant of hand-edited files; entries it cannot parse are
 * skipped (their text is preserved untouched on upsert, which only appends).
 */
export function parseBibEntries(bibText) {
  const entries = [];
  for (const chunk of bibText.split(/^(?=@)/m)) {
    const head = chunk.match(/^@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/);
    if (!head) continue;
    entries.push({
      type: head[1].toLowerCase(),
      key: head[2],
      doi: normalizeDoi(chunk.match(/^\s*doi\s*=\s*[{"]([^}"]+)[}"]/im)?.[1] ?? '') || null,
      pmid: chunk.match(/^\s*pmid\s*=\s*[{"]([^}"]+)[}"]/im)?.[1]?.trim() ?? null,
    });
  }
  return entries;
}

/**
 * Upsert a PubMed record into BibTeX text (pure). Citing an already-present
 * work (same PMID or DOI) reuses its key instead of adding a duplicate.
 * @returns {{ bibText, key, created, bibtex }}
 */
export function upsertBibText(bibText, record) {
  const entries = parseBibEntries(bibText);
  const doi = normalizeDoi(record.doi ?? '');
  const existing = entries.find(
    (e) => (record.pmid && e.pmid === String(record.pmid)) || (doi && e.doi === doi),
  );
  if (existing) {
    return { bibText, key: existing.key, created: false, bibtex: null };
  }
  const key = makeCitekey(record, new Set(entries.map((e) => e.key)));
  const bibtex = formatBibEntry(record, key);
  const trimmed = bibText.replace(/\s+$/, '');
  return {
    bibText: trimmed ? `${trimmed}\n\n${bibtex}\n` : `${bibtex}\n`,
    key,
    created: true,
    bibtex,
  };
}

/**
 * Add a PubMed citation to the project bibliography (default
 * draft/references.bib), deduping against existing entries.
 * @returns {Promise<{ key, created, bibtex, path }>}
 */
export async function upsertCitation(projectId, pmid, bibPath = DEFAULT_BIB_PATH) {
  let bibText = '';
  try {
    bibText = (await readProjectFile(projectId, bibPath)).toString('utf-8');
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
  }

  // Re-citing a work already in the bibliography never needs PubMed
  const already = parseBibEntries(bibText).find((e) => e.pmid === String(pmid));
  if (already) {
    return { key: already.key, created: false, bibtex: null, path: bibPath };
  }

  const record = await fetchPubmedRecord(pmid);
  if (!record) throw new StorageError('not_found', `No PubMed record for PMID ${pmid}`);

  const result = upsertBibText(bibText, record);
  if (result.created) {
    await writeProjectFile(projectId, bibPath, result.bibText);
  }
  return { key: result.key, created: result.created, bibtex: result.bibtex, path: bibPath };
}
