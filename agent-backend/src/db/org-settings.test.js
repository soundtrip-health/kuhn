// Story 011-003: org settings — schema-validated JSON merged over defaults.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let settings;

const ORG = 1;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  settings = await import('./org-settings.js');
});

beforeEach(() => {
  querySync('DELETE FROM organizations');
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab')`);
});

describe('getOrgSettings', () => {
  it('returns the full default set for a fresh org', () => {
    expect(settings.getOrgSettings(ORG)).toEqual({
      default_member_role: 'editor',
      library_seeding: true,
      promotion_policy: 'approval-required',
    });
  });

  it('merges stored values over defaults and survives corrupt JSON', () => {
    querySync(`UPDATE organizations SET settings = '{"promotion_policy":"direct"}' WHERE id = ${ORG}`);
    expect(settings.getOrgSettings(ORG)).toMatchObject({
      promotion_policy: 'direct',
      default_member_role: 'editor',
    });
    querySync(`UPDATE organizations SET settings = 'not json' WHERE id = ${ORG}`);
    expect(settings.getOrgSettings(ORG).promotion_policy).toBe('approval-required');
  });

  it('returns null for a missing org', () => {
    expect(settings.getOrgSettings(999)).toBeNull();
  });
});

describe('updateOrgSettings', () => {
  it('validates, persists, and returns the merged settings', () => {
    const merged = settings.updateOrgSettings(ORG, {
      default_member_role: 'viewer', library_seeding: false,
    });
    expect(merged).toEqual({
      default_member_role: 'viewer',
      library_seeding: false,
      promotion_policy: 'approval-required',
    });
    // Persisted: a fresh read agrees.
    expect(settings.getOrgSettings(ORG)).toEqual(merged);
    // Stored JSON holds only what was set — defaults stay live, not frozen.
    const stored = JSON.parse(
      querySync(`SELECT settings FROM organizations WHERE id = ${ORG}`).rows[0].settings,
    );
    expect(stored).toEqual({ default_member_role: 'viewer', library_seeding: false });
  });

  it('rejects unknown keys with the offending field', () => {
    expect(() => settings.updateOrgSettings(ORG, { name: 'sneaky' }))
      .toThrow(settings.SettingsValidationError);
    try {
      settings.updateOrgSettings(ORG, { spend_ceiling: 100 });
    } catch (err) {
      expect(err.field).toBe('spend_ceiling');
    }
  });

  it('rejects bad enum values and non-boolean booleans, changing nothing', () => {
    expect(() => settings.updateOrgSettings(ORG, { default_member_role: 'owner' }))
      .toThrow(/must be one of/);
    expect(() => settings.updateOrgSettings(ORG, { library_seeding: 'yes' }))
      .toThrow(/must be a boolean/);
    try {
      settings.updateOrgSettings(ORG, { promotion_policy: 'anarchy' });
    } catch (err) {
      expect(err.field).toBe('promotion_policy');
    }
    expect(querySync(`SELECT settings FROM organizations WHERE id = ${ORG}`).rows[0].settings)
      .toBe('{}');
  });

  it('returns null for a missing org after validation', () => {
    expect(settings.updateOrgSettings(999, { library_seeding: false })).toBeNull();
  });
});
