// Story 011-001: syncSuperadmins mirrors KUHN_SUPERADMIN_EMAILS onto
// users.is_superadmin at boot — flips both ways, creates missing users.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let syncSuperadmins;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  ({ syncSuperadmins } = await import('./users.js'));
});

beforeEach(() => {
  querySync('DELETE FROM users');
});

const flags = () => Object.fromEntries(
  querySync('SELECT email, is_superadmin FROM users ORDER BY email').rows
    .map((r) => [r.email, r.is_superadmin]),
);

describe('syncSuperadmins', () => {
  it('creates a users row for a listed email that has never logged in', () => {
    syncSuperadmins(['admin@lab.org']);
    expect(flags()).toEqual({ 'admin@lab.org': 1 });
    expect(querySync("SELECT display_name FROM users WHERE email = 'admin@lab.org'").rows)
      .toEqual([{ display_name: 'admin' }]);
  });

  it('flips both ways: listed users gain the flag, unlisted users lose it', () => {
    querySync("INSERT INTO users (email, is_superadmin) VALUES ('old@lab.org', 1)");
    querySync("INSERT INTO users (email) VALUES ('new@lab.org')");
    syncSuperadmins(['new@lab.org']);
    expect(flags()).toEqual({ 'old@lab.org': 0, 'new@lab.org': 1 });
    // And back again on the next boot with a changed list.
    syncSuperadmins(['old@lab.org']);
    expect(flags()).toEqual({ 'old@lab.org': 1, 'new@lab.org': 0 });
  });

  it('an empty (or absent) list clears every flag', () => {
    querySync("INSERT INTO users (email, is_superadmin) VALUES ('a@lab.org', 1)");
    querySync("INSERT INTO users (email, is_superadmin) VALUES ('b@lab.org', 1)");
    syncSuperadmins([]);
    expect(flags()).toEqual({ 'a@lab.org': 0, 'b@lab.org': 0 });
    querySync("UPDATE users SET is_superadmin = 1 WHERE email = 'a@lab.org'");
    syncSuperadmins(undefined);
    expect(flags()).toEqual({ 'a@lab.org': 0, 'b@lab.org': 0 });
  });

  it('normalizes case/whitespace and dedupes without duplicating rows', () => {
    querySync("INSERT INTO users (email) VALUES ('admin@lab.org')");
    syncSuperadmins(['  Admin@LAB.org ', 'admin@lab.org', '']);
    expect(flags()).toEqual({ 'admin@lab.org': 1 });
    expect(querySync('SELECT COUNT(*) AS n FROM users').rows[0].n).toBe(1);
  });

  it('is idempotent across repeated boots', () => {
    syncSuperadmins(['admin@lab.org']);
    syncSuperadmins(['admin@lab.org']);
    expect(flags()).toEqual({ 'admin@lab.org': 1 });
  });
});
