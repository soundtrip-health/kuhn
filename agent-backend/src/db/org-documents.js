// Story 006-001: org knowledge library records. Bytes live under the
// org-scoped storage root (storage.js); this module owns the metadata rows.
// Synchronous (querySync), matching the other db/ modules.

import { querySync } from '../db.js';

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
