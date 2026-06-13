import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../db/orgs.js', () => ({
  listUserOrgs: vi.fn(async () => []),
  createOrg: vi.fn(),
  isMember: vi.fn(async () => true),
}));
vi.mock('../db/projects.js', () => ({ listOrgProjects: vi.fn(async () => []) }));

import { listUserOrgs, createOrg, isMember } from '../db/orgs.js';
import { listOrgProjects } from '../db/projects.js';
import orgsRouter from './orgs.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(orgsRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(() => new Promise((ok) => server.close(ok)));

beforeEach(() => {
  vi.clearAllMocks();
  isMember.mockResolvedValue(true);
});

describe('GET /api/orgs', () => {
  it('returns the session user\'s orgs', async () => {
    listUserOrgs.mockResolvedValue([{ id: 7, name: 'Default Organization', slug: 'default', role: 'owner' }]);
    const res = await fetch(`${base}/api/orgs`);
    expect(res.status).toBe(200);
    expect((await res.json()).orgs).toHaveLength(1);
    expect(listUserOrgs).toHaveBeenCalledWith(1);
  });
});

describe('POST /api/orgs', () => {
  it('400s without a name', async () => {
    const res = await fetch(`${base}/api/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('creates an org with a slug derived from the name', async () => {
    createOrg.mockResolvedValue({ id: 8, name: 'Okafor Lab', slug: 'okafor-lab', role: 'owner' });
    const res = await fetch(`${base}/api/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Okafor Lab' }),
    });
    expect(res.status).toBe(201);
    expect(createOrg).toHaveBeenCalledWith({ name: 'Okafor Lab', slug: 'okafor-lab', userId: 1 });
  });

  it('409s on a duplicate slug', async () => {
    createOrg.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const res = await fetch(`${base}/api/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Default Organization' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/orgs/:id/projects', () => {
  it('lists projects for a member', async () => {
    listOrgProjects.mockResolvedValue([{ id: 1, org_id: 7 }]);
    const res = await fetch(`${base}/api/orgs/7/projects`);
    expect(res.status).toBe(200);
    expect(listOrgProjects).toHaveBeenCalledWith(7);
  });

  it('404s for a non-member', async () => {
    isMember.mockResolvedValue(false);
    const res = await fetch(`${base}/api/orgs/999/projects`);
    expect(res.status).toBe(404);
    expect(listOrgProjects).not.toHaveBeenCalled();
  });
});
