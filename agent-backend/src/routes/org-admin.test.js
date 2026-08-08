// Org administration routes (stories 010-003 members, 011-002 invitations,
// 011-003 settings). Real in-memory SQLite — role guards, the invitation
// lifecycle, and the last-owner invariant are SQL, so no DB mocks. The auth
// router is mounted too: invitation redemption goes through the real verify
// door, end to end.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

// Capture invitation/login links instead of logging/sending them.
vi.mock('../mailer.js', () => ({
  sendLoginLink: vi.fn(async () => {}),
  sendInviteLink: vi.fn(async () => {}),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORG = 1;
const OWNER = 1;
const EDITOR = 2;
const VIEWER = 3;

let config; let exec; let querySync;
let sendInviteLink;
let createSession;
let server; let base;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';

  ({ exec, querySync } = await import('../db.js'));
  ({ sendInviteLink } = await import('../mailer.js'));
  ({ createSession } = await import('../db/auth.js'));
  const { session } = await import('../session.js');
  const { authRouter } = await import('./auth.js');
  const { default: orgsRouter } = await import('./orgs.js');
  const { default: orgAdminRouter } = await import('./org-admin.js');
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  const app = express();
  app.use(express.json());
  app.use(authRouter); // the verify door — invite redemption lives here
  app.use(session);
  app.use(orgsRouter); // GET /api/orgs — rename must be reflected there
  app.use(orgAdminRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  config.auth.mode = 'dev';
  config.auth.sessionSecret = '';
  await new Promise((ok) => server.close(ok));
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of ['auth_events', 'invitations', 'sessions', 'memberships', 'users', 'organizations']) {
    querySync(`DELETE FROM ${table}`);
  }
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab')`);
  querySync(`INSERT INTO users (id, email) VALUES (${OWNER}, 'owner@lab.org')`);
  querySync(`INSERT INTO users (id, email) VALUES (${EDITOR}, 'editor@lab.org')`);
  querySync(`INSERT INTO users (id, email) VALUES (${VIEWER}, 'viewer@lab.org')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${OWNER}, ${ORG}, 'owner')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${EDITOR}, ${ORG}, 'editor')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${VIEWER}, ${ORG}, 'viewer')`);
});

async function cookieFor(userId) {
  const { cookieValue } = await createSession(userId);
  return cookieValue;
}

const api = (method, path, { cookie, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: `kuhn_session=${encodeURIComponent(cookie)}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

const eventTypes = () =>
  querySync('SELECT type FROM auth_events ORDER BY id').rows.map((r) => r.type);

describe('guard discipline (010-003 / 011-002 AC2)', () => {
  const routes = [
    ['GET', `/api/orgs/${ORG}/members`],
    ['PATCH', `/api/orgs/${ORG}/members/${EDITOR}`, { role: 'viewer' }],
    ['DELETE', `/api/orgs/${ORG}/members/${EDITOR}`],
    ['GET', `/api/orgs/${ORG}/invitations`],
    ['POST', `/api/orgs/${ORG}/invitations`, { email: 'x@lab.org', role: 'editor' }],
    ['DELETE', `/api/orgs/${ORG}/invitations/1`],
    ['GET', `/api/orgs/${ORG}/settings`],
    ['PATCH', `/api/orgs/${ORG}/settings`, { promotion_policy: 'direct' }],
  ];

  it('an editor gets 403 requires owner role on every org-admin route', async () => {
    const cookie = await cookieFor(EDITOR);
    for (const [method, path, body] of routes) {
      const res = await api(method, path, { cookie, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: 'requires owner role' });
    }
  });

  it('a non-member gets a non-leaking 404 on every org-admin route', async () => {
    querySync("INSERT INTO users (id, email) VALUES (4, 'stranger@other.org')");
    const cookie = await cookieFor(4);
    for (const [method, path, body] of routes) {
      const res = await api(method, path, { cookie, body });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: 'organization not found' });
    }
  });

  it('a suspended org refuses even its owner with 403 organization suspended', async () => {
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG}`);
    const res = await api('GET', `/api/orgs/${ORG}/members`, { cookie: await cookieFor(OWNER) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization suspended' });
  });
});

describe('member management (story 010-003)', () => {
  it('lists members owners-first, then by email', async () => {
    const res = await api('GET', `/api/orgs/${ORG}/members`, { cookie: await cookieFor(OWNER) });
    expect(res.status).toBe(200);
    const { members } = await res.json();
    expect(members.map((m) => [m.email, m.role])).toEqual([
      ['owner@lab.org', 'owner'],
      ['editor@lab.org', 'editor'],
      ['viewer@lab.org', 'viewer'],
    ]);
  });

  it('changes a role, records the audit event, and rejects garbage roles', async () => {
    const cookie = await cookieFor(OWNER);
    const res = await api('PATCH', `/api/orgs/${ORG}/members/${EDITOR}`, {
      cookie, body: { role: 'viewer' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).member).toMatchObject({ user_id: EDITOR, role: 'viewer' });
    expect(eventTypes()).toEqual(['member.role_changed']);

    const bad = await api('PATCH', `/api/orgs/${ORG}/members/${VIEWER}`, {
      cookie, body: { role: 'admin' },
    });
    expect(bad.status).toBe(400);
  });

  it('refuses to demote or remove the last owner with 409 last_owner', async () => {
    const cookie = await cookieFor(OWNER);
    const demote = await api('PATCH', `/api/orgs/${ORG}/members/${OWNER}`, {
      cookie, body: { role: 'editor' },
    });
    expect(demote.status).toBe(409);
    expect(await demote.json()).toMatchObject({ code: 'last_owner' });

    const remove = await api('DELETE', `/api/orgs/${ORG}/members/${OWNER}`, { cookie });
    expect(remove.status).toBe(409);
    expect(await remove.json()).toMatchObject({ code: 'last_owner' });
    // Nothing changed and no audit event was recorded for the refusals.
    expect(querySync(
      `SELECT role FROM memberships WHERE user_id = ${OWNER} AND org_id = ${ORG}`,
    ).rows).toEqual([{ role: 'owner' }]);
    expect(eventTypes()).toEqual([]);
  });

  it('removes a member (and 404s an unknown one)', async () => {
    const cookie = await cookieFor(OWNER);
    const res = await api('DELETE', `/api/orgs/${ORG}/members/${VIEWER}`, { cookie });
    expect(res.status).toBe(200);
    expect(querySync(
      `SELECT COUNT(*) AS n FROM memberships WHERE user_id = ${VIEWER}`,
    ).rows[0].n).toBe(0);
    expect(eventTypes()).toEqual(['member.removed']);

    expect((await api('DELETE', `/api/orgs/${ORG}/members/999`, { cookie })).status).toBe(404);
    expect((await api('PATCH', `/api/orgs/${ORG}/members/999`, {
      cookie, body: { role: 'viewer' },
    })).status).toBe(404);
  });
});

describe('invitation lifecycle through the verify door (story 011-002)', () => {
  /** Owner invites `email` at `role`; returns the emailed verify URL. */
  async function invite(email, role = 'viewer') {
    const res = await api('POST', `/api/orgs/${ORG}/invitations`, {
      cookie: await cookieFor(OWNER), body: { email, role },
    });
    expect(res.status).toBe(201);
    const { invitation } = await res.json();
    const [to, url, opts] = sendInviteLink.mock.calls.at(-1);
    expect(to).toBe(email.toLowerCase());
    expect(opts).toEqual({ orgName: 'Lab' });
    return { invitation, url };
  }

  it('invite → mail capture → redeem → membership at the invited role → live session', async () => {
    const { invitation, url } = await invite('new@lab.org', 'editor');
    expect(url).toContain('/api/auth/verify?invite=');
    // The client never sees the secret.
    expect(invitation.token_hash).toBeUndefined();
    expect(invitation).toMatchObject({ email: 'new@lab.org', role: 'editor', state: 'pending' });

    const verify = await fetch(url, { redirect: 'manual' });
    expect(verify.status).toBe(302);
    expect(verify.headers.get('location')).toBe(`${config.auth.appUrl}/`);
    const cookie = decodeURIComponent(
      (verify.headers.get('set-cookie') ?? '').match(/kuhn_session=([^;]+)/)[1],
    );

    // Membership landed at the invited role, and the session is live.
    expect(querySync(
      `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE u.email = 'new@lab.org' AND m.org_id = ${ORG}`,
    ).rows).toEqual([{ role: 'editor' }]);
    const orgs = await api('GET', '/api/orgs', { cookie });
    expect(orgs.status).toBe(200);
    expect((await orgs.json()).orgs).toMatchObject([{ id: ORG, role: 'editor' }]);

    // The invitation is spent, and both ends were audited.
    const list = await api('GET', `/api/orgs/${ORG}/invitations`, { cookie: await cookieFor(OWNER) });
    const rows = (await list.json()).invitations;
    expect(rows.find((r) => r.email === 'new@lab.org').state).toBe('accepted');
    expect(rows.every((r) => r.token_hash === undefined)).toBe(true);
    expect(eventTypes()).toEqual(['invite.issued', 'invite.redeemed']);
  });

  it('refuses to invite an existing member with 409', async () => {
    const res = await api('POST', `/api/orgs/${ORG}/invitations`, {
      cookie: await cookieFor(OWNER), body: { email: 'Editor@LAB.org', role: 'viewer' },
    });
    expect(res.status).toBe(409);
    expect(sendInviteLink).not.toHaveBeenCalled();
  });

  it('rejects malformed emails and unknown roles', async () => {
    const cookie = await cookieFor(OWNER);
    expect((await api('POST', `/api/orgs/${ORG}/invitations`, {
      cookie, body: { email: 'not-an-email', role: 'viewer' },
    })).status).toBe(400);
    expect((await api('POST', `/api/orgs/${ORG}/invitations`, {
      cookie, body: { email: 'ok@lab.org', role: 'member' },
    })).status).toBe(400);
    expect(sendInviteLink).not.toHaveBeenCalled();
  });

  it('revoke kills the link: redeem redirects to invite-revoked, second revoke 404s', async () => {
    const { invitation, url } = await invite('new@lab.org');
    const cookie = await cookieFor(OWNER);
    const res = await api('DELETE', `/api/orgs/${ORG}/invitations/${invitation.id}`, { cookie });
    expect(res.status).toBe(200);

    const verify = await fetch(url, { redirect: 'manual' });
    expect(verify.headers.get('location')).toBe(`${config.auth.appUrl}/?login=invite-revoked`);
    expect(verify.headers.get('set-cookie')).toBeNull();

    expect((await api('DELETE', `/api/orgs/${ORG}/invitations/${invitation.id}`, { cookie })).status).toBe(404);
    expect(eventTypes()).toEqual(['invite.issued', 'invite.revoked']);
  });

  it('expired and reused links redirect with their own reasons', async () => {
    const { invitation, url } = await invite('new@lab.org');
    querySync('UPDATE invitations SET expires_at = $1 WHERE id = $2',
      ['2020-01-01T00:00:00.000Z', invitation.id]);
    const expired = await fetch(url, { redirect: 'manual' });
    expect(expired.headers.get('location')).toBe(`${config.auth.appUrl}/?login=invite-expired`);

    querySync('UPDATE invitations SET expires_at = $1 WHERE id = $2',
      ['2099-01-01T00:00:00.000Z', invitation.id]);
    expect((await fetch(url, { redirect: 'manual' })).headers.get('location'))
      .toBe(`${config.auth.appUrl}/`);
    const reused = await fetch(url, { redirect: 'manual' });
    expect(reused.headers.get('location')).toBe(`${config.auth.appUrl}/?login=invite-used`);
    expect(reused.headers.get('set-cookie')).toBeNull();
  });

  it('a garbage token redirects to invite-invalid', async () => {
    const res = await fetch(`${base}/api/auth/verify?invite=nonsense`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`${config.auth.appUrl}/?login=invite-invalid`);
  });

  it('suspension refuses WITHOUT burning the token; unsuspend → same link redeems', async () => {
    const { url } = await invite('new@lab.org');
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG}`);
    const refused = await fetch(url, { redirect: 'manual' });
    expect(refused.headers.get('location')).toBe(`${config.auth.appUrl}/?login=invite-suspended`);
    expect(refused.headers.get('set-cookie')).toBeNull();
    expect(querySync('SELECT accepted_at FROM invitations').rows).toEqual([{ accepted_at: null }]);

    querySync(`UPDATE organizations SET status = 'active' WHERE id = ${ORG}`);
    const ok = await fetch(url, { redirect: 'manual' });
    expect(ok.headers.get('location')).toBe(`${config.auth.appUrl}/`);
  });

  it('an already-member redemption burns the invite but never changes the role', async () => {
    // The invitee joins by other means between issue and redemption.
    const { invitation, url } = await invite('late@lab.org', 'owner');
    querySync("INSERT INTO users (id, email) VALUES (5, 'late@lab.org')");
    querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (5, ${ORG}, 'viewer')`);

    const verify = await fetch(url, { redirect: 'manual' });
    expect(verify.headers.get('location'))
      .toBe(`${config.auth.appUrl}/?login=invite-already-member`);
    expect(verify.headers.get('set-cookie')).toBeNull();
    // Role untouched, invitation spent.
    expect(querySync(
      `SELECT role FROM memberships WHERE user_id = 5 AND org_id = ${ORG}`,
    ).rows).toEqual([{ role: 'viewer' }]);
    expect(querySync(
      'SELECT accepted_at FROM invitations WHERE id = $1', [invitation.id],
    ).rows[0].accepted_at).toBeTruthy();
    expect(eventTypes()).toEqual(['invite.issued', 'invite.redeemed']);
  });
});

describe('org settings (story 011-003)', () => {
  it('GET returns org identity plus settings merged over defaults', async () => {
    const res = await api('GET', `/api/orgs/${ORG}/settings`, { cookie: await cookieFor(OWNER) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      org: { id: ORG, name: 'Lab', slug: 'lab', status: 'active' },
      settings: {
        default_member_role: 'editor',
        library_seeding: true,
        promotion_policy: 'approval-required',
      },
    });
  });

  it('PATCH persists knobs and a rename together; the rename shows in GET /api/orgs', async () => {
    const cookie = await cookieFor(OWNER);
    const res = await api('PATCH', `/api/orgs/${ORG}/settings`, {
      cookie, body: { name: 'Renamed Lab', promotion_policy: 'direct' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      org: { name: 'Renamed Lab', slug: 'lab' },
      settings: { promotion_policy: 'direct' },
    });
    const orgs = await api('GET', '/api/orgs', { cookie });
    expect((await orgs.json()).orgs).toMatchObject([{ id: ORG, name: 'Renamed Lab' }]);
    expect(eventTypes()).toEqual(['org.renamed']);
  });

  it('rejects unknown keys with the offending field, applying nothing', async () => {
    const res = await api('PATCH', `/api/orgs/${ORG}/settings`, {
      cookie: await cookieFor(OWNER),
      body: { name: 'Sneaky', spend_ceiling: 100 },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown setting: spend_ceiling', field: 'spend_ceiling' });
    // Validate-before-write: the rename did NOT half-apply.
    expect(querySync(`SELECT name FROM organizations WHERE id = ${ORG}`).rows)
      .toEqual([{ name: 'Lab' }]);
  });

  it('slug is immutable and name must be a non-empty string', async () => {
    const cookie = await cookieFor(OWNER);
    const slug = await api('PATCH', `/api/orgs/${ORG}/settings`, {
      cookie, body: { slug: 'new-slug' },
    });
    expect(slug.status).toBe(400);
    expect(await slug.json()).toEqual({ error: 'slug is immutable', field: 'slug' });

    const name = await api('PATCH', `/api/orgs/${ORG}/settings`, {
      cookie, body: { name: '   ' },
    });
    expect(name.status).toBe(400);
    expect(await name.json()).toEqual({ error: 'name must be a non-empty string', field: 'name' });
  });
});
