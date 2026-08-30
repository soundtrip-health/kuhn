// Story 016: citation service — PubMed-grounded search and BibTeX upsert into
// the project bibliography. Consumed by the /cite editor command (routes) and
// the add_citation agent tool. Every candidate and every BibTeX field comes
// from PubMed metadata; nothing here is model-generated (Epic 003 grounding
// rule). The pure helpers are exported for tests.

import { arxivFetchById, crossrefFetchByDoi, pubmedSearch } from './agents/search.js';
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

// ---- Deterministic non-PubMed ingestion (STH-49) ---------------------------
//
// The bianchi2026 incident: the old add_reference took a free-form author
// list, the model filled it from parametric memory, and a real paper entered
// the store under three fabricated authors. The fix is structural: for any
// source with an identifier (arXiv id, DOI) the FULL record is fetched from
// the registry and stored with no model-authored field — the model only picks
// the identifier out of search results. Person-author fields no longer exist
// on the manual path at all.

/** "Given Family" → "Family, Given" (arXiv name order → BibTeX order). */
export function toFamilyFirst(name) {
  const s = String(name ?? '').trim();
  if (!s || s.includes(',')) return s;
  const parts = s.split(/\s+/);
  if (parts.length < 2) return s;
  return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
}

/** Map a parsed arXiv entry to the references.js insert shape. */
export function arxivToRef(entry) {
  return {
    title: entry.title,
    authors: (entry.authors ?? []).map(toFamilyFirst),
    year: entry.published?.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? null,
    url: entry.url || (entry.id ? `http://arxiv.org/abs/${entry.id}` : null),
    abstract: entry.summary,
    entryType: 'misc',
    sourceType: 'preprint',
  };
}

const CROSSREF_ENTRY_TYPES = {
  'journal-article': 'article',
  'proceedings-article': 'inproceedings',
  'book-chapter': 'incollection',
  book: 'book',
  monograph: 'book',
  report: 'techreport',
  'posted-content': 'misc',
};

/** Map a normalized Crossref work to the references.js insert shape. */
export function crossrefToRef(work) {
  return {
    title: work.title,
    authors: work.authors,
    year: work.year,
    journal: work.journal,
    volume: work.volume,
    issue: work.issue,
    pages: work.pages,
    publisher: work.publisher,
    doi: work.doi,
    url: work.url,
    abstract: work.abstract,
    entryType: CROSSREF_ENTRY_TYPES[work.type] ?? 'misc',
    sourceType: work.type === 'posted-content' ? 'preprint' : 'crossref',
  };
}

async function insertAndMaterialize(projectId, ref, bibPath) {
  const result = insertReference(projectId, ref);
  if (result.created) await materializeBib(projectId, bibPath);
  const bibtex = result.created ? formatBibEntry(ref, result.key, ref.entryType) : null;
  return { key: result.key, created: result.created, bibtex, path: bibPath };
}

/**
 * Add an arXiv preprint by id. The full record is fetched from the arXiv API;
 * nothing about it is caller-supplied.
 * @returns {Promise<{ key, created, bibtex, path }>}
 */
export async function addArxivReference(projectId, arxivId, bibPath = DEFAULT_BIB_PATH) {
  let entry;
  try {
    entry = await arxivFetchById(arxivId);
  } catch (err) {
    throw new UpstreamError(err.message);
  }
  if (!entry) throw new StorageError('not_found', `No arXiv record for id "${arxivId}"`);
  return insertAndMaterialize(projectId, arxivToRef(entry), bibPath);
}

/**
 * Add a DOI-registered work. The full record is fetched from Crossref;
 * nothing about it is caller-supplied.
 * @returns {Promise<{ key, created, bibtex, path }>}
 */
export async function addDoiReference(projectId, doi, bibPath = DEFAULT_BIB_PATH) {
  let work;
  try {
    work = await crossrefFetchByDoi(doi);
  } catch (err) {
    throw new UpstreamError(err.message);
  }
  if (!work) throw new StorageError('not_found', `DOI "${doi}" is not registered with Crossref`);
  return insertAndMaterialize(projectId, crossrefToRef(work), bibPath);
}

/**
 * Manual path — ONLY for identifier-less sources (web pages, government
 * guidance). Takes an organization as corporate author; person-name authors
 * are deliberately not accepted (STH-49): a person's name may only enter the
 * store from a registry record.
 * @param {object} input - { title, url, organization?, year?, publisher?,
 *   entry_type?, source_type? }
 * @returns {Promise<{ key, created, bibtex, path }>}
 */
export async function addManualReference(projectId, input, bibPath = DEFAULT_BIB_PATH) {
  const ref = {
    title: input.title,
    // Braced so BibTeX treats it as a corporate author, not "Given Family".
    authors: input.organization ? [`{${input.organization}}`] : [],
    year: input.year != null ? String(input.year) : null,
    publisher: input.publisher,
    url: input.url,
    entryType: input.entry_type ?? 'misc',
    sourceType: input.source_type ?? 'web',
  };
  return insertAndMaterialize(projectId, ref, bibPath);
}

// ---- Field-level verification (STH-49) -------------------------------------
//
// "Verified" used to mean "the work exists". Now it means: every stored field
// matches the authoritative registry record, checked by code.

const normText = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const familyKey = (a) => String(a ?? '').replace(/[{}]/g, '').split(',')[0]
  .normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase();

/**
 * Compare a stored reference against an authoritative registry record, field
 * by field. Returns [{ field, stored, source }]; empty array means verified.
 * Authors compare as ordered family-name sequences; journals only flag when
 * the names share no overlap (abbreviations are legitimate).
 */
export function diffReferenceRecord(stored, source) {
  const issues = [];
  const flag = (field, s, a) => issues.push({ field, stored: s ?? null, source: a ?? null });

  if (source.title && normText(stored.title) !== normText(source.title)) {
    flag('title', stored.title, source.title);
  }

  const storedFams = (stored.authors ?? []).map(familyKey);
  const sourceFams = (source.authors ?? []).map(familyKey);
  if (sourceFams.length > 0
      && (storedFams.length !== sourceFams.length || storedFams.some((f, i) => f !== sourceFams[i]))) {
    flag('authors', (stored.authors ?? []).join(' and '), (source.authors ?? []).join(' and '));
  }

  if (source.year != null && String(stored.year ?? '') !== String(source.year)) {
    flag('year', stored.year, source.year);
  }

  const normDoi = (d) => String(d ?? '').trim().toLowerCase();
  if (stored.doi && source.doi && normDoi(stored.doi) !== normDoi(source.doi)) {
    flag('doi', stored.doi, source.doi);
  }

  for (const field of ['volume', 'issue']) {
    if (stored[field] && source[field] && String(stored[field]) !== String(source[field])) {
      flag(field, stored[field], source[field]);
    }
  }

  const normPages = (pg) => String(pg ?? '').replace(/\s*-+\s*/g, '-');
  if (stored.pages && source.pages && normPages(stored.pages) !== normPages(source.pages)) {
    flag('pages', stored.pages, source.pages);
  }

  const sj = normText(stored.journal);
  const candidates = [source.journal, source.journalAbbrev].map(normText).filter(Boolean);
  if (sj && candidates.length > 0
      && !candidates.some((c) => c === sj || c.includes(sj) || sj.includes(c))) {
    flag('journal', stored.journal, source.journal ?? source.journalAbbrev);
  }

  return issues;
}

/** The arXiv id embedded in a stored URL, or null. */
export function extractArxivId(url) {
  const m = String(url ?? '').match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i);
  return m ? m[1] : null;
}

/**
 * Verify one stored reference row against its authoritative registry:
 * PubMed (pmid), else Crossref (doi), else arXiv (arxiv.org url). Rows with
 * no identifier are reported unverifiable — those need a human check.
 */
export async function verifyReferenceRow(row) {
  const stored = {
    title: row.title,
    authors: row.authors ?? [],
    year: row.year,
    journal: row.journal,
    volume: row.volume,
    issue: row.issue,
    pages: row.pages,
    doi: row.doi,
  };
  const base = { cite_key: row.cite_key, title: row.title };
  const finish = (checkedAgainst, mismatches) => (mismatches.length === 0
    ? { ...base, checked_against: checkedAgainst, status: 'verified' }
    : { ...base, checked_against: checkedAgainst, status: 'mismatch', mismatches });
  try {
    if (row.pmid) {
      const rec = await fetchPubmedRecord(row.pmid);
      if (!rec) return { ...base, checked_against: `PubMed ${row.pmid}`, status: 'not_found' };
      return finish(`PubMed ${row.pmid}`, diffReferenceRecord(stored, rec));
    }
    if (row.doi) {
      const work = await crossrefFetchByDoi(row.doi);
      if (!work) return { ...base, checked_against: `Crossref ${row.doi}`, status: 'not_found' };
      return finish(`Crossref ${row.doi}`, diffReferenceRecord(stored, work));
    }
    const arxivId = extractArxivId(row.url);
    if (arxivId) {
      const entry = await arxivFetchById(arxivId);
      if (!entry) return { ...base, checked_against: `arXiv ${arxivId}`, status: 'not_found' };
      return finish(`arXiv ${arxivId}`, diffReferenceRecord(stored, arxivToRef(entry)));
    }
  } catch (err) {
    return { ...base, status: 'error', error: err.message };
  }
  return {
    ...base,
    status: 'unverifiable',
    note: 'No PMID, DOI, or arXiv id — verify by hand against the source URL.',
  };
}

/**
 * Field-level verification of a project's stored references (STH-49): the
 * deterministic check behind any "sources verified" claim. Sequential on
 * purpose — the registries rate-limit.
 * @returns {Promise<{ total, verified, mismatches, unverifiable, results }>}
 */
export async function verifyProjectReferences(projectId, citeKeys = null) {
  let refs = await listProjectReferences(projectId);
  if (citeKeys?.length) {
    const wanted = new Set(citeKeys);
    refs = refs.filter((r) => wanted.has(r.cite_key));
  }
  const results = [];
  for (const row of refs) results.push(await verifyReferenceRow(row));
  return {
    total: results.length,
    verified: results.filter((r) => r.status === 'verified').length,
    mismatches: results.filter((r) => r.status === 'mismatch').length,
    unverifiable: results.filter((r) => r.status === 'unverifiable').length,
    results,
  };
}
