// The "Project memory" prompt section (issue #150, spec §6): headlines not
// bodies, the three groups, the size budget, delta mode, and nothing when
// there is nothing to say. Real in-memory SQLite through db/memory.js.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('../logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const P = 1;

let memory;
let mc;
let querySync;

beforeAll(async () => {
  let exec;
  ({ exec, querySync } = await import('../db.js'));
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync("INSERT INTO users (id, email, display_name) VALUES (7, 'pi@example.org', 'PI')");
  querySync("INSERT INTO projects (id, name, project_type, org_id) VALUES (1, 'A', 'manuscript', 1)");
  memory = await import('../db/memory.js');
  mc = await import('./memory-context.js');
});

beforeEach(() => {
  querySync('DELETE FROM project_memory');
});

describe('headline', () => {
  it('flattens markdown to one line and cuts at a word boundary with an ellipsis', () => {
    expect(mc.headline('# Title\n\n- first point\n- second')).toBe('Title first point second');
    const long = mc.headline(`${'word '.repeat(80)}end`, 50);
    expect(long.length).toBeLessThanOrEqual(51);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/wor…$/);
  });

  it('renders the citable line', () => {
    const line = mc.renderEntryLine({ id: 12, kind: 'decision', key: 'target-journal', source_agent: null, created_at: '2026-09-10T12:00:00.000Z', body: 'JAMA' });
    expect(line).toBe('- [#12 decision target-journal, user, 2026-09-10] JAMA');
  });
});

describe('buildMemorySection', () => {
  it('returns null on an empty memory', () => {
    expect(mc.buildMemorySection(P, { taskText: 'anything' })).toBeNull();
  });

  it('groups decisions/issues, recent task outcomes and task-text matches as headlines', () => {
    const t = memory.remember(P, { kind: 'task_state', key: 'task:11', body: `Removed the 13 corrupted arXiv keys.\n${'Detail line.\n'.repeat(60)}`, sourceAgent: 'ra', auto: true }).entry;
    const d = memory.remember(P, { kind: 'decision', key: 'target-journal', body: 'PI chose JAMA Network Open.', sourceAgent: null, userId: 7 }).entry;
    const i = memory.remember(P, { kind: 'issue', body: 'Power calculation questioned.', sourceAgent: 'reviewer' }).entry;
    const f = memory.remember(P, { kind: 'fact', body: 'The arXiv registry fetch is deterministic now.', sourceAgent: 'ra' }).entry;
    memory.remember(P, { kind: 'fact', body: 'Unrelated fact about figure sizes.', sourceAgent: 'analyst' });

    const text = mc.buildMemorySection(P, { taskText: 'Audit the arXiv references for corrupted keys', agent: 'ra', jobId: 9 });
    expect(text.startsWith('## Project memory')).toBe(true);
    expect(text).toMatch(/source of truth/);
    const sections = text.split('### ').slice(1).map((s) => s.split('\n')[0]);
    expect(sections).toEqual(['Decisions and open issues', 'Recent task outcomes', 'Related to this task']);
    expect(text).toContain(`- [#${i.id} issue, reviewer,`);
    expect(text).toContain(`- [#${d.id} decision target-journal, user,`);
    expect(text).toContain(`- [#${t.id} task_state task:11, ra,`);
    // Headlines: the long body is cut, and the fact that shares vocabulary is
    // the match; the unrelated fact is not injected.
    expect(text).not.toContain('Detail line. Detail line. Detail line. Detail line. Detail line. Detail line. Detail line. Detail line. Detail line. Detail line. Detail line. Detail line. Detail line. Detail line.');
    expect(text).toContain(`- [#${f.id} fact, ra,`);
    expect(text).not.toContain('figure sizes');
    // An entry already shown as a decision/task is not repeated as a match.
    expect(text.split(`#${t.id} `).length).toBe(2);
  });

  it('keeps within the size budget by dropping matches, then old task outcomes, then old decisions', () => {
    for (let k = 0; k < 10; k += 1) {
      memory.remember(P, { kind: 'task_state', body: `Outcome ${k}: ${'lorem ipsum '.repeat(30)}`, sourceAgent: 'writer', auto: true });
      memory.remember(P, { kind: 'decision', body: `Decision ${k}: ${'dolor sit '.repeat(30)}`, sourceAgent: 'pm' });
      memory.remember(P, { kind: 'fact', body: `Fact ${k} about lorem: ${'amet '.repeat(30)}`, sourceAgent: 'ra' });
    }
    const full = mc.buildMemorySection(P, { taskText: 'lorem ipsum amet' });
    expect(full.length).toBeLessThanOrEqual(3072);
    const small = mc.buildMemorySection(P, { taskText: 'lorem ipsum amet' }, { maxChars: 900 });
    expect(small.length).toBeLessThanOrEqual(900);
    expect(small).not.toContain('Related to this task');
    expect(small).toContain('Decisions and open issues');
  });

  it('delta mode shows only entries created after `since` and says so', () => {
    memory.remember(P, { kind: 'decision', body: 'Old decision.', sourceAgent: 'pm' });
    const cut = memory.recall(P, { limit: 1 })[0].created_at;
    expect(mc.buildMemorySection(P, { taskText: 'x', since: cut })).toBeNull();
    querySync("UPDATE project_memory SET created_at = '2000-01-01T00:00:00.000Z'");
    memory.remember(P, { kind: 'issue', body: 'New issue since then.', sourceAgent: 'reviewer' });
    const delta = mc.buildMemorySection(P, { taskText: 'x', since: '2001-01-01T00:00:00.000Z' });
    expect(delta).toContain('New since your previous turn');
    expect(delta).toContain('New issue since then.');
    expect(delta).not.toContain('Old decision.');
  });
});
