import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Real in-memory SQLite: the cap is a count + insert in one transaction, and
// that atomicity is the substance (issue #113 item 5, threat T-21).
process.env.KUHN_SQLITE_PATH = ':memory:';
const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync;
let jobs;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  jobs = await import('./jobs.js');
});

beforeEach(() => {
  querySync('DELETE FROM jobs');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'A', 'a'), (2, 'B', 'b')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'one@a.test'), (2, 'two@a.test')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (5, 1, 'Alpha', 'manuscript'), (6, 1, 'Beta', 'manuscript'), (7, 2, 'Other', 'manuscript')");
});

const limits = { orgId: 1, perUser: 2, perOrg: 3 };
const run = (userId, projectId = 5) => jobs.createJob({ role: 'pm', projectId, input: 'go', userId }, { limits });

describe('createJob concurrency caps (issue #113 item 5)', () => {
  it('refuses the run past the per-user cap with the documented message and leaves no job row', async () => {
    await run(1);
    await run(1, 6);
    expect(jobs.countOpenRunsSync({ orgId: 1, userId: 1 })).toEqual({ org: 2, user: 2 });
    let err;
    try { await run(1); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(jobs.RunCapError);
    expect(err).toMatchObject({ code: 'concurrency_limit', scope: 'user', used: 2, limit: 2 });
    expect(err.message).toBe('You already have 2 of 2 runs in progress. Wait for one to finish, or stop it, before starting another.');
    expect(querySync('SELECT COUNT(*) AS n FROM jobs').rows[0].n).toBe(2);
  });

  it('refuses at the org cap across users, and counts only open top-level jobs of that org', async () => {
    const first = await run(1);
    await run(1, 6);
    await run(2);
    let err;
    try { await run(2); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'concurrency_limit', scope: 'org', used: 3, limit: 3 });
    expect(err.message).toMatch(/^Your organization already has 3 of 3 runs in progress/);
    // A finished run, a sub-job and another org's run do not count.
    querySync("UPDATE jobs SET status = 'done' WHERE user_id = 2");
    querySync("INSERT INTO jobs (project_id, user_id, role, status, input, parent_job_id) VALUES (5, 2, 'ra', 'running', 'sub', $1)", [first.id]);
    querySync("INSERT INTO jobs (project_id, user_id, role, status, input) VALUES (7, 2, 'pm', 'running', 'elsewhere')");
    expect(jobs.countOpenRunsSync({ orgId: 1, userId: 2 })).toEqual({ org: 2, user: 0 });
    await expect(run(2)).resolves.toMatchObject({ role: 'pm', user_id: 2 });
  });

  it('never caps a sub-job, and a zero cap disables the check', async () => {
    const first = await run(1);
    await run(1, 6);
    const sub = await jobs.createJob({ role: 'ra', projectId: 5, input: 'sub', userId: 1, parentJobId: first.id, rootJobId: first.id }, { limits });
    expect(sub.parent_job_id).toBe(first.id);
    const uncapped = await jobs.createJob({ role: 'pm', projectId: 5, input: 'go', userId: 1 }, { limits: { orgId: 1, perUser: 0, perOrg: 0 } });
    expect(uncapped.root_job_id).toBe(uncapped.id);
    const noLimits = await jobs.createJob({ role: 'pm', projectId: 5, input: 'go', userId: 1 });
    expect(noLimits.root_job_id).toBe(noLimits.id);
  });
});
