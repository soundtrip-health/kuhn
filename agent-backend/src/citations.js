// Story 016: citation service — PubMed-grounded search and BibTeX upsert into
// the project bibliography. Consumed by the /cite editor command (routes) and
// the add_citation agent tool. Every candidate and every BibTeX field comes
// from PubMed metadata; nothing here is model-generated (Epic 003 grounding
// rule). The pure helpers are exported for tests.

import { pubmedSearch } from './agents/search.js';
import { StorageError, writeProjectFile } from './storage.js';
import {
  insertReference, materializeBib, findByPmid, listProjectReferences,
  updateReferenceFields, deleteReference, exportBibtex, rowToBibRecord,
  DEFAULT_BIB_PATH,
} from './db/references.js';

// Re-exported from db/references.js (its true home since 012-003, so
// render.js can share it without pulling this module's PubMed machinery).
export { DEFAULT_BIB_PATH };

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

/** Render a normalized record as a BibTeX entry (defaults to @article). */
export function formatBibEntry(record, key, entryType = 'article') {
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
  add('url', record.url);
  add('pmid', record.pmid);
  return `@${entryType}{${key},\n${fields.join(',\n')}\n}`;
}

/** Map a normalized PubMed record to the references.js insert shape. */
function pubmedToRef(record) {
  return {
    title: record.title,
    authors: record.authors,
    year: record.year,
    journal: record.journal ?? record.journalAbbrev,
    volume: record.volume,
    issue: record.issue,
    pages: record.pages,
    doi: record.doi,
    pmid: record.pmid,
    abstract: record.abstract,
    entryType: 'article',
    sourceType: 'pubmed',
  };
}

/**
 * Add a PubMed citation to the project's reference store (SQLite, canonical),
 * deduping by PMID/DOI, and regenerate the derived bibliography file. Returns
 * the same shape the /cite route and the add_citation agent tool expect.
 * @returns {Promise<{ key, created, bibtex, path }>}
 */
/**
 * Whether a path is a bibliography file the reference store materializes —
 * i.e. one whose contents are DERIVED from SQLite and clobbered on the next
 * regeneration. Agent file tools refuse direct writes to such paths (issue
 * #42): the write would silently vanish; the deterministic add_citation /
 * add_reference tools are the supported way to change the bibliography.
 */
export async function isDerivedBibPath(projectId, path) {
  if (typeof path !== 'string' || !path.toLowerCase().endsWith('.bib')) return false;
  const refs = await listProjectReferences(projectId);
  return refs.length > 0;
}

export async function upsertCitation(projectId, pmid, bibPath = DEFAULT_BIB_PATH) {
  // Re-citing a work already stored never needs a PubMed round-trip.
  const existing = await findByPmid(projectId, pmid);
  if (existing) {
    return { key: existing.cite_key, created: false, bibtex: null, path: bibPath };
  }

  const record = await fetchPubmedRecord(pmid);
  if (!record) throw new StorageError('not_found', `No PubMed record for PMID ${pmid}`);

  const ref = pubmedToRef(record);
  const result = insertReference(projectId, ref);
  if (result.created) await materializeBib(projectId, bibPath);
  const bibtex = result.created ? formatBibEntry(ref, result.key) : null;
  return { key: result.key, created: result.created, bibtex, path: bibPath };
}

/**
 * Add a non-PubMed reference (preprint, web, manual) to the project's reference
 * store by full metadata, then regenerate the derived bibliography file.
 * @param {object} input - { title, authors[], year, entry_type?, journal?, doi?,
 *   url?, source_type?, abstract? }
 * @returns {Promise<{ key, created, bibtex, path }>}
 */
export async function addReference(projectId, input, bibPath = DEFAULT_BIB_PATH) {
  const ref = {
    title: input.title,
    authors: input.authors ?? [],
    year: input.year,
    journal: input.journal,
    doi: input.doi,
    url: input.url,
    abstract: input.abstract,
    entryType: input.entry_type ?? 'article',
    sourceType: input.source_type ?? 'manual',
  };
  const result = insertReference(projectId, ref);
  if (result.created) await materializeBib(projectId, bibPath);
  const bibtex = result.created ? formatBibEntry(ref, result.key, ref.entryType) : null;
  return { key: result.key, created: result.created, bibtex, path: bibPath };
}

/**
 * Correct fields of a stored reference by cite key and regenerate the derived
 * bibliography (issue #41: the deterministic alternative to hand-editing the
 * .bib). The cite key itself never changes — in-text [@key] citations keep
 * resolving.
 * @returns {Promise<{ key, bibtex, path }>} bibtex is the corrected entry
 */
export async function updateReference(projectId, citeKey, changes, bibPath = DEFAULT_BIB_PATH) {
  const row = updateReferenceFields(projectId, citeKey, changes);
  if (!row) throw new StorageError('not_found', `No reference with cite key "${citeKey}" in this project`);
  await materializeBib(projectId, bibPath);
  const bibtex = formatBibEntry(rowToBibRecord(row), row.cite_key, row.entry_type || 'article');
  return { key: row.cite_key, bibtex, path: bibPath };
}

/**
 * Delete a stored reference by cite key and regenerate the derived
 * bibliography (issue #41). Unlike materializeBib, removal writes the file
 * even when it becomes empty — the last entry must actually disappear.
 * @returns {Promise<{ key, path }>}
 */
export async function removeReference(projectId, citeKey, bibPath = DEFAULT_BIB_PATH) {
  if (!deleteReference(projectId, citeKey)) {
    throw new StorageError('not_found', `No reference with cite key "${citeKey}" in this project`);
  }
  await writeProjectFile(projectId, bibPath, await exportBibtex(projectId));
  return { key: citeKey, path: bibPath };
}
