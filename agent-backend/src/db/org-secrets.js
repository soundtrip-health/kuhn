// Org secrets store: named credentials for agent-side use (a Postgres DSN the
// analyst's sandboxed scripts connect with, an NCBI API key the citation
// tools attach). Contract:
//
//   - Values are WRITE-ONLY at every API surface. Routes return metadata only;
//     `getOrgSecretValue` is for server-side resolution at the point of use
//     (sandbox env injection, backend tool calls) — its result must never be
//     echoed into a model context or an HTTP response.
//   - Encrypted at rest with AES-256-GCM. The key comes from KUHN_SECRETS_KEY
//     (32-byte hex), else is derived from the session secret; a dev deployment
//     with neither gets a fixed dev key and a startup warning — fine for the
//     disposable dev DB, not for production (threat-model TB-7: ciphertext and
//     key must live in different domains, so the DB backup never contains the
//     key).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { config } from '../config.js';
import { querySync } from '../db.js';

/** Validation failure — routes map to 400. */
export class SecretError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretError';
  }
}

// Handle agents reference (run_script `secrets: [...]`), also the env-var
// stem: nsduh-db → KUHN_SECRET_NSDUH_DB. Lowercase so names read like the
// script/knowledge slugs elsewhere in the product.
export const SECRET_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_VALUE_BYTES = 8 * 1024;

/** The env-var name a secret is injected as in the sandbox. */
export function secretEnvName(name) {
  return `KUHN_SECRET_${name.toUpperCase().replace(/-/g, '_')}`;
}

let cachedKey = null;
function encryptionKey() {
  if (cachedKey) return cachedKey;
  const hex = config.secrets.key;
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new SecretError('KUHN_SECRETS_KEY must be 64 hex characters (32 bytes)');
    }
    cachedKey = Buffer.from(hex, 'hex');
    return cachedKey;
  }
  const seed = config.auth.sessionSecret;
  if (!seed) {
    console.warn('[org-secrets] No KUHN_SECRETS_KEY or KUHN_SESSION_SECRET — using the fixed dev key (dev only).');
  }
  cachedKey = scryptSync(seed || 'kuhn-dev-secrets', 'kuhn-org-secrets-v1', 32);
  return cachedKey;
}

/** Test hook: drop the cached key after mutating config secrets/session. */
export function resetKeyCache() {
  cachedKey = null;
}

export function encryptValue(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decryptValue(ciphertext) {
  const [iv, tag, data] = ciphertext.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

const publicRow = (row) => ({
  name: row.name,
  description: row.description,
  created_by: row.created_by,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/** Metadata only — no values, ever. */
export function listOrgSecrets(orgId) {
  const { rows } = querySync(
    'SELECT * FROM org_secrets WHERE org_id = $1 ORDER BY name',
    [orgId],
  );
  return rows.map(publicRow);
}

/**
 * Create or replace a secret (values are replace-only: there is no read-back,
 * so there is nothing to patch). Returns metadata.
 */
export function setOrgSecret(orgId, name, value, { description = null, createdBy = null } = {}) {
  if (!SECRET_NAME_PATTERN.test(name ?? '')) {
    throw new SecretError('name must be 1-64 chars: lowercase letters, digits, dashes; starting with a letter');
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecretError('value must be a non-empty string');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new SecretError(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  }
  const ciphertext = encryptValue(value);
  const { rows } = querySync(
    `INSERT INTO org_secrets (org_id, name, description, ciphertext, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, name) DO UPDATE SET
       description = excluded.description,
       ciphertext = excluded.ciphertext,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING *`,
    [orgId, name, description, ciphertext, createdBy],
  );
  return publicRow(rows[0]);
}

/** @returns {boolean} true if a row was deleted */
export function deleteOrgSecret(orgId, name) {
  const { rows } = querySync(
    'DELETE FROM org_secrets WHERE org_id = $1 AND name = $2 RETURNING id',
    [orgId, name],
  );
  return rows.length > 0;
}

/**
 * Server-side resolution — the ONLY read path for values. Never put the
 * result in a tool result, model prompt, log line, or HTTP response.
 * @returns {string|null} the plaintext value, or null if absent
 */
export function getOrgSecretValue(orgId, name) {
  const { rows } = querySync(
    'SELECT ciphertext FROM org_secrets WHERE org_id = $1 AND name = $2',
    [orgId, name],
  );
  if (rows.length === 0) return null;
  return decryptValue(rows[0].ciphertext);
}

/** Resolve through a project to its org (the run_script / tool path). */
export function getSecretValueForProject(projectId, name) {
  const { rows } = querySync('SELECT org_id FROM projects WHERE id = $1', [projectId]);
  const orgId = rows[0]?.org_id;
  return orgId == null ? null : getOrgSecretValue(orgId, name);
}

/** Names + descriptions visible to agents for discovery (no values). */
export function listSecretNamesForProject(projectId) {
  const { rows } = querySync('SELECT org_id FROM projects WHERE id = $1', [projectId]);
  const orgId = rows[0]?.org_id;
  return orgId == null ? [] : listOrgSecrets(orgId).map(({ name, description }) => ({ name, description }));
}
