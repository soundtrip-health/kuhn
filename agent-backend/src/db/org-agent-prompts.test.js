// Issue #67: org agent-prompt additions — upsert/clear semantics, trimming,
// and the length cap. Real in-memory SQLite, no mocks.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let prompts;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  prompts = await import('./org-agent-prompts.js');
});

beforeEach(() => {
  querySync('DELETE FROM org_agent_prompts');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Lab', 'lab'), (2, 'Rival', 'rival')");
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@lab.local')");
});

describe('setOrgAgentPrompt', () => {
  it('inserts a trimmed addition and reads it back', () => {
    const { cleared, row } = prompts.setOrgAgentPrompt(1, 'analyst', '  No PHI queries.  ', 1);
    expect(cleared).toBe(false);
    expect(row).toMatchObject({ org_id: 1, agent_slug: 'analyst', addition: 'No PHI queries.', updated_by: 1 });
    expect(prompts.getOrgAgentPrompt(1, 'analyst').addition).toBe('No PHI queries.');
  });

  it('upserts on the (org, agent) key and restamps updated_by', () => {
    prompts.setOrgAgentPrompt(1, 'analyst', 'v1', 1);
    const { row } = prompts.setOrgAgentPrompt(1, 'analyst', 'v2', null);
    expect(row.addition).toBe('v2');
    expect(row.updated_by).toBeNull();
    expect(querySync('SELECT COUNT(*) AS n FROM org_agent_prompts').rows[0].n).toBe(1);
  });

  it('clears (deletes the row) on an empty or whitespace addition', () => {
    prompts.setOrgAgentPrompt(1, 'analyst', 'rule', 1);
    const { cleared, row } = prompts.setOrgAgentPrompt(1, 'analyst', '   ', 1);
    expect(cleared).toBe(true);
    expect(row).toBeNull();
    expect(prompts.getOrgAgentPrompt(1, 'analyst')).toBeNull();
  });

  it('rejects a non-string and an over-cap addition with the field named', () => {
    expect(() => prompts.setOrgAgentPrompt(1, 'analyst', 42, 1))
      .toThrow(prompts.PromptValidationError);
    const long = 'x'.repeat(prompts.MAX_ADDITION_CHARS + 1);
    try {
      prompts.setOrgAgentPrompt(1, 'analyst', long, 1);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(prompts.PromptValidationError);
      expect(err.field).toBe('addition');
    }
    // exactly at the cap is fine
    expect(prompts.setOrgAgentPrompt(1, 'analyst', 'x'.repeat(prompts.MAX_ADDITION_CHARS), 1).cleared).toBe(false);
  });
});

describe('scoping', () => {
  it('keeps additions org- and agent-scoped', () => {
    prompts.setOrgAgentPrompt(1, 'analyst', 'lab rule', 1);
    prompts.setOrgAgentPrompt(2, 'analyst', 'rival rule', null);
    prompts.setOrgAgentPrompt(1, 'writer', 'style rule', 1);
    expect(prompts.getOrgAgentPrompt(1, 'analyst').addition).toBe('lab rule');
    expect(prompts.getOrgAgentPrompt(2, 'analyst').addition).toBe('rival rule');
    expect(prompts.getOrgAgentPrompt(2, 'writer')).toBeNull();
    const lab = prompts.listOrgAgentPrompts(1);
    expect(lab.map((r) => r.agent_slug).sort()).toEqual(['analyst', 'writer']);
    expect(lab.find((r) => r.agent_slug === 'analyst').updated_by_email).toBe('owner@lab.local');
  });
});
