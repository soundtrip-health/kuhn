// Org secrets store: encryption at rest, write-only contract, org scoping,
// name/value validation, project-scoped resolution. Real in-memory SQLite.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let secrets;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  secrets = await import('./org-secrets.js');
});

beforeEach(() => {
  for (const table of ['org_secrets', 'projects', 'users', 'organizations']) {
    querySync(`DELETE FROM ${table}`);
  }
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Lab', 'lab'), (2, 'Rival', 'rival')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@lab.local')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (10, 1, 'Trial', 'manuscript')");
});

describe('org secrets store', () => {
  it('stores encrypted, lists metadata only, resolves the value server-side', () => {
    const meta = secrets.setOrgSecret(1, 'nsduh-db', 'postgresql://u:pw@host/db', {
      description: 'NSDUH warehouse', createdBy: 1,
    });
    expect(meta).toEqual(expect.objectContaining({ name: 'nsduh-db', description: 'NSDUH warehouse', created_by: 1 }));
    expect(JSON.stringify(meta)).not.toContain('pw@host');

    const listed = secrets.listOrgSecrets(1);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('postgresql');
    expect(listed[0]).not.toHaveProperty('ciphertext');

    // At rest: ciphertext, not plaintext.
    const { rows } = querySync('SELECT ciphertext FROM org_secrets');
    expect(rows[0].ciphertext).not.toContain('postgresql');

    expect(secrets.getOrgSecretValue(1, 'nsduh-db')).toBe('postgresql://u:pw@host/db');
  });

  it('encrypts with a random IV (same plaintext, different ciphertext)', () => {
    expect(secrets.encryptValue('same')).not.toBe(secrets.encryptValue('same'));
    expect(secrets.decryptValue(secrets.encryptValue('same'))).toBe('same');
  });

  it('upserts on the same name and bumps updated_at semantics', () => {
    secrets.setOrgSecret(1, 'api-key', 'v1');
    secrets.setOrgSecret(1, 'api-key', 'v2', { description: 'renewed' });
    expect(secrets.listOrgSecrets(1)).toHaveLength(1);
    expect(secrets.getOrgSecretValue(1, 'api-key')).toBe('v2');
    expect(secrets.listOrgSecrets(1)[0].description).toBe('renewed');
  });

  it('scopes by org', () => {
    secrets.setOrgSecret(1, 'nsduh-db', 'lab-value');
    expect(secrets.getOrgSecretValue(2, 'nsduh-db')).toBeNull();
    expect(secrets.listOrgSecrets(2)).toHaveLength(0);
    expect(secrets.deleteOrgSecret(2, 'nsduh-db')).toBe(false);
    expect(secrets.getOrgSecretValue(1, 'nsduh-db')).toBe('lab-value');
  });

  it('validates names and values', () => {
    for (const bad of ['', 'UPPER', '1starts-with-digit', 'has space', 'a'.repeat(65), 'ünïcode']) {
      expect(() => secrets.setOrgSecret(1, bad, 'v')).toThrow(secrets.SecretError);
    }
    expect(() => secrets.setOrgSecret(1, 'ok-name', '')).toThrow(secrets.SecretError);
    expect(() => secrets.setOrgSecret(1, 'ok-name', 42)).toThrow(secrets.SecretError);
    expect(() => secrets.setOrgSecret(1, 'ok-name', 'x'.repeat(9 * 1024))).toThrow(/exceeds/);
  });

  it('deletes and reports absence', () => {
    secrets.setOrgSecret(1, 'gone-soon', 'v');
    expect(secrets.deleteOrgSecret(1, 'gone-soon')).toBe(true);
    expect(secrets.deleteOrgSecret(1, 'gone-soon')).toBe(false);
    expect(secrets.getOrgSecretValue(1, 'gone-soon')).toBeNull();
  });

  it('resolves through a project to its org', () => {
    secrets.setOrgSecret(1, 'nsduh-db', 'dsn');
    expect(secrets.getSecretValueForProject(10, 'nsduh-db')).toBe('dsn');
    expect(secrets.getSecretValueForProject(999, 'nsduh-db')).toBeNull();
    expect(secrets.listSecretNamesForProject(10)).toEqual([
      { name: 'nsduh-db', description: null },
    ]);
    expect(secrets.listSecretNamesForProject(999)).toEqual([]);
  });

  it('maps names to env vars', () => {
    expect(secrets.secretEnvName('nsduh-db')).toBe('KUHN_SECRET_NSDUH_DB');
    expect(secrets.secretEnvName('ncbi-api-key')).toBe('KUHN_SECRET_NCBI_API_KEY');
  });
});
