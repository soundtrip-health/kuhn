// Per-project reference store (SQLite). Canonical home for citations; the
// draft/references.bib file is a derived artifact materialized from here for
// Pandoc/Typst rendering. Identity resolution adapts ds-sciwriter's three-tier
// scheme: DOI/PMID strong match, title+author+year weak hash, then a fresh
// insert with a deduplicated cite key.

import { createHash } from 'node:crypto';

import { query, querySync, transaction } from '../db.js';
import { formatBibEntry, makeCitekey } from '../citations.js';
import { writeProjectFile } from '../storage.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** A cite key an import may supply (issue #153): letters/digits/_ then
 *  letters/digits/_/:/./-. Conservative on purpose — Pandoc allows more, but
 *  these are the keys every Kuhn consumer (regex-based) handles. */
export const CITE_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_:.\-]*$/;

const normalizeDoi = (doi) => String(doi ?? '').trim().replace(/[.,;)\s]+$/, '').toLowerCase() || null;
const cleanPmid = (pmid) => (pmid == null ? null : String(pmid).trim() || null);

/** SHA1 over normalized title | first-author family | year — the weak id. */
function weakIdHash(record) {
  const title = String(record.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const family = String(record.authors?.[0] ?? '').split(',')[0].toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
  const year = record.year ?? '';
  return createHash('sha1').update(`${title}|${family}|${year}`).digest('hex');
}

/** Parse a stored reference row's authors_json to an array. */
function parseRef(row) {
  if (row && typeof row.authors_json === 'string') {
    row.authors = JSON.parse(row.authors_json || '[]');
  }
  return row;
}

/** Find a project's reference by PMID (to skip a PubMed refetch when re-citing). */
export async function findByPmid(projectId, pmid) {
  const clean = cleanPmid(pmid);
  if (!clean) return null;
  const { rows } = await query(
    'SELECT id, cite_key FROM bib_references WHERE project_id = $1 AND pmid = $2 LIMIT 1',
    [projectId, clean],
  );
  return rows[0] ?? null;
}

/** All references for a project, with parsed authors. */
export async function listProjectReferences(projectId) {
  const { rows } = await query(
    `SELECT id, cite_key, entry_type, title, authors_json, year, journal, volume,
            issue, pages, publisher, doi, pmid, pmcid, url, abstract, source_type,
            identity_status, created_at
     FROM bib_references WHERE project_id = $1 ORDER BY cite_key`,
    [projectId],
  );
  return rows.map(parseRef);
}

/** Convert a stored row to the shape formatBibEntry expects. */
export function rowToBibRecord(row) {
  return {
    authors: typeof row.authors_json === 'string' ? JSON.parse(row.authors_json || '[]') : (row.authors ?? []),
    title: row.title,
    journal: row.journal,
    year: row.year,
    volume: row.volume,
    issue: row.issue,
    pages: row.pages,
    doi: row.doi,
    url: row.url,
    pmid: row.pmid,
  };
}

/**
 * Insert a reference into a project, deduping by DOI/PMID (strong) then by the
 * weak title+author+year hash. Returns { key, created, id }. `record` carries
 * normalized fields: { title, authors[], year, journal, volume, issue, pages,
 * publisher, doi, pmid, pmcid, url, abstract, entryType, sourceType }.
 */
export function insertReference(projectId, record) {
  const doi = normalizeDoi(record.doi);
  const pmid = cleanPmid(record.pmid);
  const weak = weakIdHash(record);

  return transaction(() => {
    // Strong match: same DOI or PMID already in this project.
    const strong = querySync(
      `SELECT id, cite_key FROM bib_references
       WHERE project_id = $1 AND (($2 IS NOT NULL AND doi = $2) OR ($3 IS NOT NULL AND pmid = $3))
       LIMIT 1`,
      [projectId, doi, pmid],
    ).rows[0];
    if (strong) return { key: strong.cite_key, created: false, id: strong.id };

    // Weak match: same title+author+year (only when no strong id to rely on).
    if (!doi && !pmid) {
      const weakHit = querySync(
        'SELECT id, cite_key FROM bib_references WHERE project_id = $1 AND weak_id_hash = $2 LIMIT 1',
        [projectId, weak],
      ).rows[0];
      if (weakHit) return { key: weakHit.cite_key, created: false, id: weakHit.id };
    }

    // Fresh insert with a project-unique cite key.
    const key = makeCitekey(record, takenKeys(projectId));
    return { key, created: true, id: insertRow(projectId, key, record, { doi, pmid, weak }) };
  });
}

function takenKeys(projectId) {
  return new Set(
    querySync('SELECT cite_key FROM bib_references WHERE project_id = $1', [projectId])
      .rows.map((r) => r.cite_key),
  );
}

/** The one INSERT. Caller has normalized doi/pmid and computed the weak hash. */
function insertRow(projectId, key, record, { doi, pmid, weak }) {
  const { rows } = querySync(
    `INSERT INTO bib_references
       (project_id, cite_key, entry_type, title, authors_json, year, journal,
        volume, issue, pages, publisher, doi, pmid, pmcid, url, abstract,
        source_type, identity_status, weak_id_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id`,
    [
      projectId, key, record.entryType ?? 'article', record.title,
      JSON.stringify(record.authors ?? []), record.year ?? null, record.journal ?? null,
      record.volume ?? null, record.issue ?? null, record.pages ?? null, record.publisher ?? null,
      doi, pmid, record.pmcid ?? null, record.url ?? null, record.abstract ?? null,
      record.sourceType ?? null, (doi || pmid) ? 'strong' : 'weak', weak,
    ],
  );
  return rows[0].id;
}

/**
 * Insert-or-refresh a reference under a caller-chosen cite key (issue #153,
 * interchange spec §3). The three outcomes, in order:
 *
 *   matched  — the requested key already holds this reference (same DOI/PMID,
 *              or same title+author+year when neither side has a strong id),
 *              OR a strong/weak match exists under ANOTHER key. Mutable fields
 *              are refreshed from `record`; `key` is the existing key.
 *   renamed  — the requested key is held by a DIFFERENT reference: inserted
 *              under the requested key plus a letter suffix.
 *   created  — nothing matches: inserted under the requested key.
 *
 * `record` is the insertReference shape plus `citeKey`. The caller rewrites
 * in-text citations whenever `key !== record.citeKey`.
 * @returns {{status: 'created'|'matched'|'renamed', key: string, id: number}}
 */
export function upsertReferenceByKey(projectId, record) {
  const citeKey = String(record.citeKey ?? '').trim();
  if (!CITE_KEY_RE.test(citeKey)) throw new Error(`invalid cite key: ${JSON.stringify(record.citeKey)}`);
  const doi = normalizeDoi(record.doi);
  const pmid = cleanPmid(record.pmid);
  const weak = weakIdHash(record);

  return transaction(() => {
    const byKey = querySync(
      'SELECT * FROM bib_references WHERE project_id = $1 AND cite_key = $2 LIMIT 1',
      [projectId, citeKey],
    ).rows[0] ?? null;
    const strong = (doi || pmid)
      ? querySync(
        `SELECT * FROM bib_references
         WHERE project_id = $1 AND (($2 IS NOT NULL AND doi = $2) OR ($3 IS NOT NULL AND pmid = $3))
         LIMIT 1`,
        [projectId, doi, pmid],
      ).rows[0] ?? null
      : null;
    const weakHit = (!doi && !pmid)
      ? querySync(
        'SELECT * FROM bib_references WHERE project_id = $1 AND weak_id_hash = $2 LIMIT 1',
        [projectId, weak],
      ).rows[0] ?? null
      : null;

    let target = null;
    if (byKey) {
      const same = strong ? strong.id === byKey.id : byKey.weak_id_hash === weak;
      if (same) target = byKey;
    }
    if (!target && !byKey) target = strong ?? weakHit ?? null;
    if (!target && byKey && strong && strong.id !== byKey.id) target = strong;

    if (target) {
      // Descriptive fields follow the bundle (its tool is the source of
      // truth). Identity fields are only ever ADDED: a bundle that omits a
      // DOI must not strip one the project already holds.
      applyFieldChanges(target, {
        title: record.title, authors: record.authors ?? [], year: record.year ?? null,
        journal: record.journal ?? null, volume: record.volume ?? null, issue: record.issue ?? null,
        pages: record.pages ?? null, publisher: record.publisher ?? null, url: record.url ?? null,
        abstract: record.abstract ?? null, entryType: record.entryType ?? target.entry_type,
        ...(doi ? { doi } : {}), ...(pmid ? { pmid } : {}), ...(record.pmcid ? { pmcid: record.pmcid } : {}),
      });
      return { status: 'matched', key: target.cite_key, id: target.id };
    }

    if (byKey) {
      const taken = takenKeys(projectId);
      let key = citeKey;
      for (let i = 0; taken.has(key); i++) {
        key = `${citeKey}${String.fromCharCode(97 + (i % 26)).repeat(Math.floor(i / 26) + 1)}`;
      }
      return { status: 'renamed', key, id: insertRow(projectId, key, record, { doi, pmid, weak }) };
    }

    return { status: 'created', key: citeKey, id: insertRow(projectId, citeKey, record, { doi, pmid, weak }) };
  });
}

/** One reference by cite key, with parsed authors, or null. */
export async function getReferenceByKey(projectId, citeKey) {
  const { rows } = await query(
    'SELECT * FROM bib_references WHERE project_id = $1 AND cite_key = $2 LIMIT 1',
    [projectId, citeKey],
  );
  return rows[0] ? parseRef(rows[0]) : null;
}

// Columns an update_reference correction may change (issue #41). cite_key is
// deliberately immutable — in-text [@key] citations anchor to it.
const UPDATABLE_COLUMNS = {
  title: 'title', year: 'year', journal: 'journal', volume: 'volume',
  issue: 'issue', pages: 'pages', publisher: 'publisher', url: 'url',
  abstract: 'abstract', entryType: 'entry_type', sourceType: 'source_type',
  pmcid: 'pmcid',
};

/** The UPDATE behind updateReferenceFields, for callers already inside a
 *  transaction. `row` is the current bib_references row. */
function applyFieldChanges(row, changes) {
  const sets = [];
  const params = [];
  const push = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
    if (changes[key] !== undefined) push(column, changes[key]);
  }
  if (changes.authors !== undefined) push('authors_json', JSON.stringify(changes.authors ?? []));
  if (changes.doi !== undefined) push('doi', normalizeDoi(changes.doi));
  if (changes.pmid !== undefined) push('pmid', cleanPmid(changes.pmid));
  if (sets.length === 0) return parseRef(row);

  // Recompute derived identity fields from the merged record.
  const merged = {
    title: changes.title ?? row.title,
    authors: changes.authors ?? JSON.parse(row.authors_json || '[]'),
    year: changes.year ?? row.year,
  };
  push('weak_id_hash', weakIdHash(merged));
  const doi = changes.doi !== undefined ? normalizeDoi(changes.doi) : row.doi;
  const pmid = changes.pmid !== undefined ? cleanPmid(changes.pmid) : row.pmid;
  push('identity_status', (doi || pmid) ? 'strong' : 'weak');
  push('updated_at', new Date().toISOString());

  params.push(row.id);
  const { rows } = querySync(
    `UPDATE bib_references SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return parseRef(rows[0]);
}

/**
 * Correct fields of a stored reference (issue #41: the deterministic
 * alternative to hand-editing the derived .bib). Only provided keys change;
 * `authors` (array), `doi`, and `pmid` get their normal normalization, and the
 * weak-id hash / identity_status are recomputed from the merged record.
 * @returns {object|null} the updated row (parsed), or null if no such cite key
 */
export function updateReferenceFields(projectId, citeKey, changes) {
  return transaction(() => {
    const row = querySync(
      'SELECT * FROM bib_references WHERE project_id = $1 AND cite_key = $2 LIMIT 1',
      [projectId, citeKey],
    ).rows[0];
    if (!row) return null;
    return applyFieldChanges(row, changes);
  });
}

/**
 * Delete a reference by cite key (issue #41).
 * @returns {boolean} true if a row was deleted
 */
export function deleteReference(projectId, citeKey) {
  const { rows } = querySync(
    'DELETE FROM bib_references WHERE project_id = $1 AND cite_key = $2 RETURNING id',
    [projectId, citeKey],
  );
  return rows.length > 0;
}

/**
 * Where the project's derived references.bib lives. One canonical path,
 * shared by the citation tools (which default to it) and render/export
 * (which materialize and read it here regardless of where the source
 * document sits) — the DB is the source of truth and this file is its
 * readout, so there is exactly one of it. (Story 012-003.)
 */
export const DEFAULT_BIB_PATH = 'draft/references.bib';

// Shown at the top of the materialized .bib — the file opens read-write in
// the editor's text view, so the provenance warning has to live in the file.
const BIB_HEADER = `% Generated from this project's reference database — do not edit by hand.
% This file is refreshed on every render and export, so direct edits are
% overwritten. To add, change, or remove references, ask the Research
% Assistant (RA) agent.

`;

/** Render a project's references as BibTeX text (sorted by cite key). */
export async function exportBibtex(projectId) {
  const refs = await listProjectReferences(projectId);
  return refs
    .map((r) => formatBibEntry(rowToBibRecord(r), r.cite_key, r.entry_type || 'article'))
    .join('\n\n') + (refs.length ? '\n' : '');
}

/**
 * Write the project's references.bib from the DB. The .bib is a derived
 * artifact; this is the single place that regenerates it.
 * @returns {Promise<boolean>} true if any references were written
 */
export async function materializeBib(projectId, bibPath = DEFAULT_BIB_PATH) {
  const text = await exportBibtex(projectId);
  if (!text.trim()) return false;
  await writeProjectFile(projectId, bibPath, BIB_HEADER + text);
  return true;
}

export { NOW };
