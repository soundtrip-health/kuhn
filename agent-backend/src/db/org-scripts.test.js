// Issue #68: org script library — create/version/status semantics, slug
// uniqueness, catalog update detection. Real in-memory SQLite, no mocks.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let scripts;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  scripts = await import('./org-scripts.js');
});

beforeEach(() => {
  for (const table of ['org_script_versions', 'org_scripts', 'catalog_scripts', 'projects', 'users', 'organizations']) {
    querySync(`DELETE FROM ${table}`);
  }
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Lab', 'lab'), (2, 'Rival', 'rival')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@lab.local')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (10, 1, 'Trial', 'manuscript')");
  querySync(`INSERT INTO catalog_scripts (id, title, language, path, entrypoint, version)
             VALUES ('r/summarize-csv', 'Summarize CSV', 'r', 'r/summarize_csv.R', 'summarize_csv.R', 3)`);
});

const create = (extra = {}) => scripts.createOrgScript({
  orgId: 1, slug: 'gamm-fit', title: 'GAMM fit', language: 'r',
  source: 'project-promotion', content: 'library(mgcv)\n', entrypoint: 'gamm_fit.R',
  sourceProjectId: 10, sourcePath: 'analyst/gamm_fit.R', createdBy: 1, ...extra,
});

describe('createOrgScript', () => {
  it('creates the script with version 1 and a content hash', () => {
    const script = create();
    expect(script).toMatchObject({
      org_id: 1, slug: 'gamm-fit', language: 'r', status: 'active',
      source: 'project-promotion', current_version: 1,
      current_entrypoint: 'gamm_fit.R', update_available: false,
    });
    const v1 = scripts.getScriptVersion(1, script.id, 1);
    expect(v1.content).toBe('library(mgcv)\n');
    expect(v1.sha256).toBe(scripts.sha256Hex('library(mgcv)\n'));
    expect(v1.source_path).toBe('analyst/gamm_fit.R');
  });

  it('refuses a slug the org already uses, but allows it in another org', () => {
    create();
    expect(() => create({ content: 'other' })).toThrow(scripts.ScriptError);
    expect(create({ orgId: 2, sourceProjectId: null }).slug).toBe('gamm-fit');
  });
});

describe('addScriptVersion', () => {
  it('appends monotonically and the joined row tracks the latest', () => {
    const script = create();
    scripts.addScriptVersion(1, script.id, { content: 'v2', entrypoint: 'gamm_fit.R', createdBy: 1 });
    const after = scripts.addScriptVersion(1, script.id, { content: 'v3', entrypoint: 'gamm_fit.R' });
    expect(after.current_version).toBe(3);
    expect(scripts.getScriptVersion(1, script.id, null).content).toBe('v3');
    expect(scripts.getScriptVersion(1, script.id, 2).content).toBe('v2');
    expect(scripts.listScriptVersions(1, script.id).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('is org-scoped: another org cannot append', () => {
    const script = create();
    expect(() => scripts.addScriptVersion(2, script.id, { content: 'x', entrypoint: 'e.R' }))
      .toThrow(scripts.ScriptError);
  });
});

describe('catalog linkage', () => {
  it('flags update_available when the catalog moves past the import', () => {
    const script = create({
      slug: 'summarize-csv', source: 'catalog-import',
      catalogScriptId: 'r/summarize-csv', catalogScriptVersion: 2,
    });
    expect(script.update_available).toBe(true); // catalog at 3, imported at 2
    scripts.stampCatalogVersion(1, script.id, 3);
    expect(scripts.getOrgScript(1, script.id).update_available).toBe(false);
    expect(scripts.getOrgScriptByCatalogId(1, 'r/summarize-csv').id).toBe(script.id);
    expect(scripts.getOrgScriptByCatalogId(2, 'r/summarize-csv')).toBeNull();
  });
});

describe('setScriptStatus / lookup', () => {
  it('disables without deleting, and getOrgScript resolves by slug or id', () => {
    const script = create();
    const disabled = scripts.setScriptStatus(1, script.id, 'disabled');
    expect(disabled.status).toBe('disabled');
    expect(scripts.listOrgScripts(1, { status: 'active' })).toHaveLength(0);
    expect(scripts.listOrgScripts(1)).toHaveLength(1);
    expect(scripts.getOrgScript(1, 'gamm-fit').id).toBe(script.id);
    expect(scripts.getOrgScript(2, 'gamm-fit')).toBeNull(); // org-scoped
    expect(scripts.setScriptStatus(2, script.id, 'active')).toBeNull();
    expect(() => scripts.setScriptStatus(1, script.id, 'archived')).toThrow(scripts.ScriptError);
  });
});
