// Issue #68b: script-run provenance rows — recording (non-throwing), tails,
// and the project-scoped listing.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let runs;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  runs = await import('./script-runs.js');
});

beforeEach(() => {
  for (const table of ['script_runs', 'org_script_versions', 'org_scripts', 'projects', 'organizations']) {
    querySync(`DELETE FROM ${table}`);
  }
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Lab', 'lab')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (10, 1, 'Trial', 'manuscript'), (11, 1, 'Other', 'manuscript')");
  querySync(`INSERT INTO org_scripts (id, org_id, slug, title, language, source)
             VALUES (5, 1, 'gamm-fit', 'GAMM fit', 'r', 'project-promotion')`);
});

describe('recordScriptRun / listScriptRuns', () => {
  it('records an org-script run with the slug joined in the listing', () => {
    const row = runs.recordScriptRun({
      projectId: 10, jobId: null, orgScriptId: 5, scriptVersion: 2,
      args: ['--input', 'x.csv'], status: 'ok', exitCode: 0, durationMs: 1200,
      outputDir: 'analyst/output/run-1-1', stdout: 'done\n',
    });
    expect(row).toMatchObject({ project_id: 10, org_script_id: 5, script_version: 2, status: 'ok' });
    const listed = runs.listScriptRuns(10);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ org_script_slug: 'gamm-fit', args_json: '["--input","x.csv"]' });
    expect(runs.listScriptRuns(11)).toHaveLength(0);
  });

  it('records failures with truncated tails and never throws on bad input', () => {
    const long = 'e'.repeat(20000);
    const row = runs.recordScriptRun({
      projectId: 10, scriptPath: 'analyst/fit.R', args: [], status: 'error',
      exitCode: 1, stderr: long,
    });
    expect(row.stderr_tail).toHaveLength(16 * 1024);
    // Unknown status violates the CHECK constraint — swallowed, returns null.
    expect(runs.recordScriptRun({ projectId: 10, args: [], status: 'nope' })).toBeNull();
  });

  it('lists newest first with a limit', () => {
    for (let i = 0; i < 5; i++) {
      runs.recordScriptRun({ projectId: 10, scriptPath: `analyst/${i}.R`, args: [], status: 'ok', exitCode: 0 });
    }
    const listed = runs.listScriptRuns(10, { limit: 3 });
    expect(listed.map((r) => r.script_path)).toEqual(['analyst/4.R', 'analyst/3.R', 'analyst/2.R']);
  });
});
