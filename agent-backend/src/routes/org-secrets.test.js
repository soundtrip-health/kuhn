// Org secrets routes: role matrix, write-only value contract, validation,
// audit events, non-leaking 404s. Real in-memory SQLite + real session auth.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

const ORG = 1;
const OTHER_ORG = 2;

let config; let querySync;
let server; let base; let cookies = {};
let saved;

function call(method, path, principal = 'owner', json) {
  const headers = { Cookie: `kuhn_session=${encodeURIComponent(cookies[principal])}` };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  return fetch(new URL(path, base), { method, headers, body });
}

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  saved = { mode: config.auth.mode, secret: config.auth.sessionSecret };
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';

  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf-8'));
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org', 'org'), (${OTHER_ORG}, 'Other', 'other')`);
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@test'), (2, 'editor@test'), (3, 'viewer@test'), (4, 'outsider@test')");
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES
             (1, ${ORG}, 'owner'), (2, ${ORG}, 'editor'), (3, ${ORG}, 'viewer'), (4, ${OTHER_ORG}, 'owner')`);

  const { createSession } = await import('../db/auth.js');
  for (const [name, id] of [['owner', 1], ['editor', 2], ['viewer', 3], ['outsider', 4]]) {
    cookies[name] = (await createSession(id)).cookieValue;
  }

  const { session } = await import('../session.js');
  const app = express();
  app.use(express.json());
  app.use(session);
  app.use((await import('./org-secrets.js')).default);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  config.auth.mode = saved.mode;
  config.auth.sessionSecret = saved.secret;
  await new Promise((ok) => server.close(ok));
});

describe('org secrets routes', () => {
  it('editor creates; response and list carry metadata but never the value', async () => {
    const put = await call('PUT', `/api/orgs/${ORG}/secrets/nsduh-db`, 'editor', {
      value: 'postgresql://kuhn_analyst:s3cret@kuhn-nsduh-db:5432/nsduh',
      description: 'NSDUH warehouse (read-only role)',
    });
    expect(put.status).toBe(200);
    const putBody = await put.text();
    expect(putBody).not.toContain('s3cret');
    expect(JSON.parse(putBody).secret).toMatchObject({ name: 'nsduh-db', created_by: 2 });

    const list = await call('GET', `/api/orgs/${ORG}/secrets`, 'viewer');
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).not.toContain('s3cret');
    expect(JSON.parse(listText).secrets.map((s) => s.name)).toContain('nsduh-db');

    // At rest: encrypted.
    const { rows } = querySync('SELECT ciphertext FROM org_secrets WHERE name = $1', ['nsduh-db']);
    expect(rows[0].ciphertext).not.toContain('s3cret');

    // Audited by name only.
    const events = querySync("SELECT type, meta FROM auth_events WHERE type = 'secret.saved'").rows;
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1).meta).toBe('{"name":"nsduh-db"}');
  });

  it('replaces on the same name (write-only upsert)', async () => {
    await call('PUT', `/api/orgs/${ORG}/secrets/rotate-me`, 'owner', { value: 'v1' });
    const res = await call('PUT', `/api/orgs/${ORG}/secrets/rotate-me`, 'owner', { value: 'v2' });
    expect(res.status).toBe(200);
    const { getOrgSecretValue } = await import('../db/org-secrets.js');
    expect(getOrgSecretValue(ORG, 'rotate-me')).toBe('v2');
  });

  it('enforces the role matrix', async () => {
    expect((await call('PUT', `/api/orgs/${ORG}/secrets/nope`, 'viewer', { value: 'v' })).status).toBe(403);
    expect((await call('DELETE', `/api/orgs/${ORG}/secrets/nsduh-db`, 'viewer')).status).toBe(403);
    // Non-members get the non-leaking 404, on every verb.
    expect((await call('GET', `/api/orgs/${ORG}/secrets`, 'outsider')).status).toBe(404);
    expect((await call('PUT', `/api/orgs/${ORG}/secrets/x`, 'outsider', { value: 'v' })).status).toBe(404);
    expect((await call('DELETE', `/api/orgs/${ORG}/secrets/x`, 'outsider')).status).toBe(404);
  });

  it('validates name and value with 400s', async () => {
    expect((await call('PUT', `/api/orgs/${ORG}/secrets/Bad%20Name`, 'editor', { value: 'v' })).status).toBe(400);
    expect((await call('PUT', `/api/orgs/${ORG}/secrets/empty-value`, 'editor', { value: '' })).status).toBe(400);
    expect((await call('PUT', `/api/orgs/${ORG}/secrets/no-value`, 'editor', {})).status).toBe(400);
  });

  it('deletes with audit; absent name is a 404', async () => {
    await call('PUT', `/api/orgs/${ORG}/secrets/doomed`, 'editor', { value: 'v' });
    expect((await call('DELETE', `/api/orgs/${ORG}/secrets/doomed`, 'editor')).status).toBe(204);
    expect((await call('DELETE', `/api/orgs/${ORG}/secrets/doomed`, 'editor')).status).toBe(404);
    const events = querySync("SELECT meta FROM auth_events WHERE type = 'secret.deleted'").rows;
    expect(events.at(-1).meta).toBe('{"name":"doomed"}');
  });

  it('scopes secrets to their org', async () => {
    const list = await call('GET', `/api/orgs/${OTHER_ORG}/secrets`, 'outsider');
    expect(list.status).toBe(200);
    expect((await list.json()).secrets).toEqual([]);
  });
});
