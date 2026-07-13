// Story 006-001: org knowledge library records. Bytes live under the
// org-scoped storage root (storage.js); this module owns the metadata rows.
// Synchronous (querySync), matching the other db/ modules.

import { querySync, transaction } from '../db.js';

const COLS =
  'id, org_id, filename, title, mime, size_bytes, sha256, status, status_detail, ' +
  'source, source_project_id, created_by, created_at, updated_at';

/**
 * Insert a library document record, deduplicating on (org_id, sha256): the
 * same bytes uploaded twice return the existing row instead of a duplicate.
 * @returns {{ document: object, deduped: boolean }}
 */
export function insertOrgDocument({
  orgId, filename, title = null, mime = null, sizeBytes, sha256,
  source = 'upload', sourceProjectId = null, createdBy = null,
}) {
  try {
    const { rows } = querySync(
      `INSERT INTO org_documents
         (org_id, filename, title, mime, size_bytes, sha256, source, source_project_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLS}`,
      [orgId, filename, title, mime, sizeBytes, sha256, source, sourceProjectId, createdBy],
    );
    return { document: rows[0], deduped: false };
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT') || err.code === '23505') {
      const { rows } = querySync(
        `SELECT ${COLS} FROM org_documents WHERE org_id = $1 AND sha256 = $2`,
        [orgId, sha256],
      );
      if (rows[0]) return { document: rows[0], deduped: true };
    }
    throw err;
  }
}

/** All of an org's library documents, newest first. */
export function listOrgDocuments(orgId) {
  const { rows } = querySync(
    `SELECT ${COLS} FROM org_documents WHERE org_id = $1 ORDER BY created_at DESC, id DESC`,
    [orgId],
  );
  return rows;
}

/** One document — org-scoped lookup so a doc id can't cross tenants. */
export function getOrgDocument(orgId, docId) {
  const { rows } = querySync(
    `SELECT ${COLS} FROM org_documents WHERE org_id = $1 AND id = $2`,
    [orgId, docId],
  );
  return rows[0] ?? null;
}

/** Delete a document record (org-scoped). Returns true if a row was removed. */
export function deleteOrgDocument(orgId, docId) {
  const { rowCount } = querySync(
    'DELETE FROM org_documents WHERE org_id = $1 AND id = $2',
    [orgId, docId],
  );
  return rowCount > 0;
}

/** Ingestion lifecycle transition (story 006-002 drives this). */
export function setOrgDocumentStatus(orgId, docId, status, statusDetail = null) {
  querySync(
    `UPDATE org_documents
     SET status = $3, status_detail = $4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE org_id = $1 AND id = $2`,
    [orgId, docId, status, statusDetail],
  );
}

// ---- Chunks & full-text search (story 006-002) --------------------------------

/**
 * Atomically replace a document's chunks (re-ingestion overwrites, never
 * appends). The schema triggers keep the FTS index in sync for both the
 * deletes and the inserts.
 * @param {Array<{ seq: number, headingPath: string|null, text: string }>} chunks
 */
export function replaceDocumentChunks(docId, chunks) {
  transaction(() => {
    querySync('DELETE FROM org_document_chunks WHERE doc_id = $1', [docId]);
    for (const chunk of chunks) {
      querySync(
        'INSERT INTO org_document_chunks (doc_id, seq, heading_path, text) VALUES ($1, $2, $3, $4)',
        [docId, chunk.seq, chunk.headingPath ?? null, chunk.text],
      );
    }
  });
}

export function countDocumentChunks(docId) {
  return querySync(
    'SELECT COUNT(*) AS n FROM org_document_chunks WHERE doc_id = $1', [docId],
  ).rows[0].n;
}

/**
 * FTS5 queries have their own operator syntax; a raw user string ("AND",
 * quotes, parens) can be a syntax error. Quote each term so input is always
 * treated as literal words.
 */
function sanitizeFtsQuery(query) {
  return String(query)
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ''))
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(' ');
}

/**
 * BM25-ranked passage search over an org's ready documents (story 006-002).
 * @returns {Array<{ docId, title, filename, headingPath, seq, snippet, rank }>}
 */
export function searchOrgKnowledge(orgId, query, limit = 8) {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const cap = Math.min(Math.max(parseInt(limit) || 8, 1), 25);
  const { rows } = querySync(
    `SELECT c.doc_id AS docId, d.title, d.filename, c.heading_path AS headingPath, c.seq,
            snippet(org_chunks_fts, 0, '>>', '<<', ' … ', 16) AS snippet,
            bm25(org_chunks_fts) AS rank
     FROM org_chunks_fts
     JOIN org_document_chunks c ON c.id = org_chunks_fts.rowid
     JOIN org_documents d ON d.id = c.doc_id
     WHERE org_chunks_fts MATCH $2 AND d.org_id = $1 AND d.status = 'ready'
     ORDER BY rank
     LIMIT ${cap}`,
    [orgId, match],
  );
  return rows;
}
