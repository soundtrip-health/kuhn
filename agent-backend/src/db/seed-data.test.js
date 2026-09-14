// Seed-data integrity (issue #170 follow-up). A bad merge once fused two
// entries of TOOLS into one object literal, so the later `slug` key silently
// won and `search_kuhn_guide` was never seeded — the help agent shipped with
// no tools and hallucinated calls as text. The runtime roster test
// (agents/tools/tools.test.js) reads the registry, not this file, so nothing
// caught it. These checks pin the seed data to the registry and to itself.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: { agent: { maxDispatchDepth: 3, questionTimeoutMs: 1000, tokenBudget: 1 }, ingest: { maxPdfPages: 1 } },
}));
vi.mock('../db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), querySync: vi.fn(() => ({ rows: [] })), transaction: (fn) => fn() }));

import { AGENTS, ASSIGNMENTS, TOOLS } from './seed-data.js';
import { createToolContext, listTools } from '../agents/tools/registry.js';

const agentSlugs = new Set(AGENTS.map((a) => a.slug));
const toolSlugs = new Set(TOOLS.map((t) => t.slug));

describe('seed data', () => {
  it('has unique, well-formed agent and tool entries', () => {
    expect(agentSlugs.size).toBe(AGENTS.length);
    expect(toolSlugs.size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      expect(t.slug, JSON.stringify(t)).toMatch(/^[a-z_]+$/);
      expect(t.name, t.slug).toBeTruthy();
      expect(t.parameterSchema?.type, t.slug).toBe('object');
    }
    for (const a of AGENTS) {
      expect(a.slug).toMatch(/^[a-z]+$/);
      expect(a.model, a.slug).toBeTruthy();
    }
  });

  it('assigns only known tools to known agents, and every agent gets at least one', () => {
    const granted = new Map(AGENTS.map((a) => [a.slug, new Set()]));
    for (const [agent, tool] of ASSIGNMENTS) {
      expect(agentSlugs.has(agent), `unknown agent "${agent}" in ASSIGNMENTS`).toBe(true);
      expect(toolSlugs.has(tool), `unknown tool "${tool}" assigned to ${agent}`).toBe(true);
      granted.get(agent).add(tool);
    }
    for (const [agent, tools] of granted) expect(tools.size, `${agent} has no tools`).toBeGreaterThan(0);
  });

  it('matches the runtime registry: every grant a runtime tool needs is a seeded tool, and vice versa', () => {
    const ctx = createToolContext({
      agent: { slug: 'x', name: 'x', system_prompt: '', model: 'm', tools: [...toolSlugs] },
      projectId: 1, depth: 0, budget: { used: 0, limit: 1 }, parentJob: { id: 1 },
      channel: { push() {} }, userId: 1, seeding: false, context: null, dispatch: async function* () {},
    });
    const runtimeGrants = new Set(listTools(ctx).flatMap((t) => t.grants));
    for (const grant of runtimeGrants) expect(toolSlugs.has(grant), `runtime grant "${grant}" has no TOOLS row`).toBe(true);
    for (const slug of toolSlugs) expect(runtimeGrants.has(slug), `seeded tool "${slug}" is granted by no runtime tool`).toBe(true);
  });
});
