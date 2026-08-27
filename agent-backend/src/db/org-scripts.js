// Issue #68: an org's shared-script library. Scripts carry an append-only
// version history in org_script_versions — the current version is the max —
// and the code text lives in the DB (small, diffable, atomically written with
// its metadata), deliberately not in storage.js files. Synchronous
// (querySync), matching the other db/ modules.

import { createHash } from 'node:crypto';

import { querySync, transaction } from '../db.js';

export const SCRIPT_STATUSES = ['active', 'disabled'];

export class ScriptError extends Error {
  /** @param {'slug_taken'|'not_found'|'invalid'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
  }
}

export const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

// Client shape: the script row joined with its current version's metadata
// (never the content — lists stay light) and the catalog's current version
// for update detection.
const JOINED_SELECT = `
  SELECT s.*,
         v.version AS current_version, v.sha256 AS current_sha256,
         v.entrypoint AS current_entrypoint, v.created_at AS current_version_at,
         c.version AS catalog_version, c.available AS catalog_available
  FROM org_scripts s
  JOIN org_script_versions v ON v.script_id = s.id
    AND v.version = (SELECT MAX(version) FROM org_script_versions WHERE script_id = s.id)
  LEFT JOIN catalog_scripts c ON c.id = s.catalog_script_id`;

const withUpdateFlag = (row) => row && {
  ...row,
  update_available: row.catalog_script_version != null
    && row.catalog_version != null
    && row.catalog_script_version < row.catalog_version,
};

/** An org's scripts (all statuses), newest first. */
export function listOrgScripts(orgId, { status = null } = {}) {
  const { rows } = querySync(
    `${JOINED_SELECT}
     WHERE s.org_id = $1 AND ($2 IS NULL OR s.status = $2)
     ORDER BY s.created_at DESC, s.id DESC`,
    [orgId, status],
  );
  return rows.map(withUpdateFlag);
}

/** One script by numeric id or slug — org-scoped so ids can't cross tenants. */
export function getOrgScript(orgId, idOrSlug) {
  const numeric = /^\d+$/.test(String(idOrSlug));
  const { rows } = querySync(
    `${JOINED_SELECT}
     WHERE s.org_id = $1 AND ${numeric ? 's.id = $2' : 's.slug = $2'}`,
    [orgId, numeric ? Number(idOrSlug) : idOrSlug],
  );
  return withUpdateFlag(rows[0] ?? null);
}

/** One version row (with content); org-scoped through the parent script. */
export function getScriptVersion(orgId, scriptId, version) {
  const { rows } = querySync(
    `SELECT v.*, u.email AS created_by_email
     FROM org_script_versions v
     JOIN org_scripts s ON s.id = v.script_id
     LEFT JOIN users u ON u.id = v.created_by
     WHERE s.org_id = $1 AND v.script_id = $2
       AND ($3 IS NULL OR v.version = $3)
     ORDER BY v.version DESC
     LIMIT 1`,
    [orgId, scriptId, version],
  );
  return rows[0] ?? null;
}

/** A script's version history (no content — metadata only), newest first. */
export function listScriptVersions(orgId, scriptId) {
  const { rows } = querySync(
    `SELECT v.id, v.version, v.sha256, v.entrypoint, v.change_note,
            v.source_project_id, v.source_path, v.created_by, v.created_at,
            u.email AS created_by_email
     FROM org_script_versions v
     JOIN org_scripts s ON s.id = v.script_id
     LEFT JOIN users u ON u.id = v.created_by
     WHERE s.org_id = $1 AND v.script_id = $2
     ORDER BY v.version DESC`,
    [orgId, scriptId],
  );
  return rows;
}

/**
 * Create a script with its version 1 in one transaction.
 * @throws {ScriptError('slug_taken')} when the org already uses the slug
 */
export function createOrgScript({
  orgId, slug, title, language, description = null, args = [],
  source, catalogScriptId = null, catalogScriptVersion = null,
  content, entrypoint, changeNote = null,
  sourceProjectId = null, sourcePath = null, createdBy = null,
}) {
  return transaction(() => {
    const { rows: taken } = querySync(
      'SELECT id FROM org_scripts WHERE org_id = $1 AND slug = $2', [orgId, slug],
    );
    if (taken[0]) {
      throw new ScriptError('slug_taken', `script slug already in use: ${slug}`);
    }
    const { rows } = querySync(
      `INSERT INTO org_scripts (org_id, slug, title, language, description, args_json,
                                source, catalog_script_id, catalog_script_version, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [orgId, slug, title, language, description, JSON.stringify(args),
        source, catalogScriptId, catalogScriptVersion, createdBy],
    );
    const scriptId = rows[0].id;
    insertVersion({
      scriptId, version: 1, content, entrypoint, changeNote,
      sourceProjectId, sourcePath, createdBy,
    });
    return getOrgScript(orgId, scriptId);
  });
}

function insertVersion({
  scriptId, version, content, entrypoint, changeNote,
  sourceProjectId, sourcePath, createdBy,
}) {
  querySync(
    `INSERT INTO org_script_versions (script_id, version, content, sha256, entrypoint,
                                      change_note, source_project_id, source_path, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [scriptId, version, content, sha256Hex(content), entrypoint,
      changeNote, sourceProjectId, sourcePath, createdBy],
  );
}

/**
 * Append the next version of an existing script (update proposal approved, or
 * catalog reimport). Version numbering is computed inside the transaction so
 * concurrent appenders can't collide.
 * @returns {object} the refreshed joined script row
 */
export function addScriptVersion(orgId, scriptId, {
  content, entrypoint, changeNote = null,
  sourceProjectId = null, sourcePath = null, createdBy = null,
  catalogScriptVersion = undefined,
}) {
  return transaction(() => {
    const { rows } = querySync(
      'SELECT id FROM org_scripts WHERE org_id = $1 AND id = $2', [orgId, scriptId],
    );
    if (!rows[0]) throw new ScriptError('not_found', `no such script: ${scriptId}`);
    const { rows: [{ next }] } = querySync(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM org_script_versions WHERE script_id = $1',
      [scriptId],
    );
    insertVersion({
      scriptId, version: next, content, entrypoint, changeNote,
      sourceProjectId, sourcePath, createdBy,
    });
    querySync(
      `UPDATE org_scripts
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           ${catalogScriptVersion !== undefined ? ', catalog_script_version = $3' : ''}
       WHERE id = $1 AND org_id = $2`,
      catalogScriptVersion !== undefined
        ? [scriptId, orgId, catalogScriptVersion]
        : [scriptId, orgId],
    );
    return getOrgScript(orgId, scriptId);
  });
}

/** Restamp the imported catalog version without a new version row (identical bytes). */
export function stampCatalogVersion(orgId, scriptId, catalogScriptVersion) {
  querySync(
    `UPDATE org_scripts
     SET catalog_script_version = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = $1 AND org_id = $2`,
    [scriptId, orgId, catalogScriptVersion],
  );
}

/** Enable/disable. Returns the refreshed row, or null when missing/other org. */
export function setScriptStatus(orgId, scriptId, status) {
  if (!SCRIPT_STATUSES.includes(status)) {
    throw new ScriptError('invalid', `status must be one of ${SCRIPT_STATUSES.join(', ')}`);
  }
  const { rows } = querySync(
    `UPDATE org_scripts
     SET status = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = $1 AND org_id = $2
     RETURNING id`,
    [scriptId, orgId, status],
  );
  return rows[0] ? getOrgScript(orgId, scriptId) : null;
}

/** The org's import of one catalog script, if any (regardless of status). */
export function getOrgScriptByCatalogId(orgId, catalogScriptId) {
  const { rows } = querySync(
    `${JOINED_SELECT} WHERE s.org_id = $1 AND s.catalog_script_id = $2`,
    [orgId, catalogScriptId],
  );
  return withUpdateFlag(rows[0] ?? null);
}
