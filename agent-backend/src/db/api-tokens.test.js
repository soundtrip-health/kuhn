// Personal API tokens (issue #152): the store. Real in-memory SQLite — the
// lifecycle (mint → resolve → revoke/expire) is SQL, so nothing is mocked.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync; let exec;
let createApiToken; let listApiTokens; let revokeApiToken; let resolveApiToken;
let ApiTokenError; let TOKEN_PREFIX; let MAX_TTL_DAYS;
let alice; let bob;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  ({
    createApiToken, listApiTokens, revokeApiToken, resolveApiToken,
    ApiTokenError, TOKEN_PREFIX, MAX_TTL_DAYS,
  } = await import('./api-tokens.js'));
});

beforeEach(() => {
  querySync('DELETE FROM api_tokens');
  querySync('DELETE FROM users');
  alice = querySync("INSERT INTO users (email, display_name) VALUES ('alice@lab.org', 'Alice') RETURNING id").rows[0].id;
  bob = querySync("INSERT INTO users (email, display_name) VALUES ('bob@lab.org', 'Bob') RETURNING id").rows[0].id;
});

describe('mint', () => {
  it('returns a prefixed raw token once and stores only its hash', () => {
    const { token, row } = createApiToken(alice, { name: 'sciwriter laptop' });
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(TOKEN_PREFIX.length + 30);
    expect(row).toMatchObject({ name: 'sciwriter laptop', lastUsedAt: null, revokedAt: null });
    expect(row).not.toHaveProperty('tokenHash');
    const stored = querySync('SELECT token_hash FROM api_tokens WHERE id = $1', [row.id]).rows[0];
    expect(stored.token_hash).not.toContain(token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults to 90 days and honors an explicit expiry up to the cap', () => {
    const day = 24 * 60 * 60 * 1000;
    const { row: dflt } = createApiToken(alice, { name: 'a' });
    expect(Date.parse(dflt.expiresAt) - Date.now()).toBeGreaterThan(89 * day);
    expect(Date.parse(dflt.expiresAt) - Date.now()).toBeLessThanOrEqual(90 * day);
    const { row: short } = createApiToken(alice, { name: 'b', expiresInDays: 7 });
    expect(Date.parse(short.expiresAt) - Date.now()).toBeLessThanOrEqual(7 * day);
    expect(() => createApiToken(alice, { name: 'c', expiresInDays: MAX_TTL_DAYS + 1 })).toThrow(ApiTokenError);
    expect(() => createApiToken(alice, { name: 'c', expiresInDays: 0 })).toThrow(ApiTokenError);
    expect(() => createApiToken(alice, { name: 'c', expiresInDays: 1.5 })).toThrow(ApiTokenError);
  });

  it('requires a name of 1-64 characters', () => {
    expect(() => createApiToken(alice, { name: '' })).toThrow(ApiTokenError);
    expect(() => createApiToken(alice, { name: '   ' })).toThrow(ApiTokenError);
    expect(() => createApiToken(alice, { name: 'x'.repeat(65) })).toThrow(ApiTokenError);
    expect(() => createApiToken(alice, {})).toThrow(ApiTokenError);
    expect(createApiToken(alice, { name: '  trimmed  ' }).row.name).toBe('trimmed');
  });
});

describe('resolve', () => {
  it('maps a live token to its user (the session-user shape) and stamps last_used_at', () => {
    const { token, row } = createApiToken(alice, { name: 'a' });
    const user = resolveApiToken(token);
    expect(user).toMatchObject({ id: alice, email: 'alice@lab.org', display_name: 'Alice', is_superadmin: 0, tokenId: row.id });
    expect(listApiTokens(alice)[0].lastUsedAt).not.toBeNull();
  });

  it('refuses unknown, unprefixed, revoked and expired tokens', () => {
    const { token, row } = createApiToken(alice, { name: 'a' });
    expect(resolveApiToken(token.slice(TOKEN_PREFIX.length))).toBeNull(); // prefix stripped
    expect(resolveApiToken(`${token}x`)).toBeNull();
    expect(resolveApiToken(null)).toBeNull();
    expect(resolveApiToken('')).toBeNull();

    const { token: expiring, row: expRow } = createApiToken(alice, { name: 'old' });
    querySync("UPDATE api_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = $1", [expRow.id]);
    expect(resolveApiToken(expiring)).toBeNull();

    expect(revokeApiToken(alice, row.id)).toMatchObject({ id: row.id });
    expect(resolveApiToken(token)).toBeNull();
  });

  it('a deleted user takes their tokens with them', () => {
    const { token } = createApiToken(alice, { name: 'a' });
    querySync('DELETE FROM users WHERE id = $1', [alice]);
    expect(resolveApiToken(token)).toBeNull();
    expect(querySync('SELECT COUNT(*) AS n FROM api_tokens').rows[0].n).toBe(0);
  });
});

describe('list and revoke', () => {
  it('lists only the owner\'s unrevoked tokens, newest first, without hashes', () => {
    createApiToken(alice, { name: 'first' });
    createApiToken(alice, { name: 'second' });
    const { row: other } = createApiToken(bob, { name: 'bobs' });
    const { row: gone } = createApiToken(alice, { name: 'gone' });
    revokeApiToken(alice, gone.id);
    const names = listApiTokens(alice).map((t) => t.name);
    expect(names).toEqual(['second', 'first']);
    expect(listApiTokens(bob).map((t) => t.id)).toEqual([other.id]);
    for (const t of listApiTokens(alice)) expect(Object.keys(t)).not.toContain('token_hash');
  });

  it('revoke is scoped to the owner and idempotent-safe', () => {
    const { row } = createApiToken(alice, { name: 'a' });
    expect(revokeApiToken(bob, row.id)).toBeNull();      // not bob's
    expect(revokeApiToken(alice, row.id)).not.toBeNull();
    expect(revokeApiToken(alice, row.id)).toBeNull();    // already revoked
    expect(revokeApiToken(alice, 999)).toBeNull();
  });
});
