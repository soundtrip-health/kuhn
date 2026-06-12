import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Agent definitions — slug → AGENTS.md path (relative to repo root) + model.
//
// Per-agent model tiers (story 021): premium models for planning and complex
// writing (pm, writer), mid-tier for analysis/review/domain work, cheap for
// high-volume literature search (ra). Override per role with
// AGENT_MODEL_<SLUG> (e.g. AGENT_MODEL_RA=claude-sonnet-4-6); a NULL model
// falls back to AGENT_MODEL, then the SDK default, at runtime.
// ---------------------------------------------------------------------------
const model = (slug, fallback) => process.env[`AGENT_MODEL_${slug.toUpperCase()}`] || fallback;

const AGENT_DEFS = [
  { slug: 'pm',       name: 'Project Manager',        path: 'agents/pm/AGENTS.md',       model: model('pm', 'claude-opus-4-8') },
  { slug: 'writer',   name: 'Writer',                 path: 'agents/writer/AGENTS.md',   model: model('writer', 'claude-opus-4-8') },
  { slug: 'ra',       name: 'Research Assistant',      path: 'agents/research/AGENTS.md', model: model('ra', 'claude-haiku-4-5') },
  { slug: 'advisor',  name: 'Domain Expert (Advisor)', path: 'agents/advisor/AGENTS.md',  model: model('advisor', 'claude-sonnet-4-6') },
  { slug: 'reviewer', name: 'Critical Reviewer',       path: 'agents/review/AGENTS.md',   model: model('reviewer', 'claude-sonnet-4-6') },
  { slug: 'analyst',  name: 'Analyst',                 path: 'agents/analyst/AGENTS.md',  model: model('analyst', 'claude-sonnet-4-6') },
];

// ---------------------------------------------------------------------------
// Tool definitions — slug, name, description, JSON Schema for parameters
// ---------------------------------------------------------------------------
const TOOL_DEFS = [
  {
    slug: 'file_read',
    name: 'Read File',
    description: 'Read the contents of a project file',
    parameter_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the project' },
      },
      required: ['path'],
    },
  },
  {
    slug: 'file_write',
    name: 'Write File',
    description: 'Write or update a project file',
    parameter_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the project' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    slug: 'file_list',
    name: 'List Files',
    description: 'List contents of a project directory',
    parameter_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path within the project' },
      },
      required: ['path'],
    },
  },
  {
    slug: 'pubmed_search',
    name: 'PubMed Search',
    description: 'Search PubMed for scientific papers',
    parameter_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'integer', description: 'Maximum results to return', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    slug: 'arxiv_search',
    name: 'arXiv Search',
    description: 'Search arXiv and bioRxiv for preprints',
    parameter_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'integer', description: 'Maximum results to return', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    slug: 'web_search',
    name: 'Web Search',
    description: 'General web search for documents, guidelines, and references',
    parameter_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'integer', description: 'Maximum results to return', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    slug: 'ask_user',
    name: 'Ask User',
    description: 'Ask the user a question mid-task and wait for their reply',
    parameter_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to show the user' },
      },
      required: ['question'],
    },
  },
  {
    slug: 'project_config',
    name: 'Save Project Config',
    description: 'Persist the structured project configuration gathered in the intake interview',
    parameter_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project title' },
        project_type: {
          type: 'string',
          enum: ['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'],
          description: 'Document type',
        },
        research_question: { type: 'string', description: 'Central research question or document purpose' },
        deliverables: { type: 'array', items: { type: 'string' }, description: 'Key deliverables' },
        timeline: { type: 'string', description: 'Key milestones and dates' },
        source_materials: { type: 'array', items: { type: 'string' }, description: 'Existing source materials' },
        notes: { type: 'string', description: 'Other interview findings worth preserving' },
      },
      required: ['title', 'project_type', 'research_question', 'deliverables', 'timeline'],
    },
  },
  {
    slug: 'spawn_agent',
    name: 'Spawn Agent',
    description: 'Dispatch a sub-agent to perform a focused task',
    parameter_schema: {
      type: 'object',
      properties: {
        agent_slug: { type: 'string', description: 'Slug of the agent to spawn' },
        task: { type: 'string', description: 'Task description for the sub-agent' },
        context: { type: 'string', description: 'Additional context for the sub-agent' },
      },
      required: ['agent_slug', 'task'],
    },
  },
];

// ---------------------------------------------------------------------------
// Agent → tool assignment matrix
// ---------------------------------------------------------------------------
const AGENT_TOOL_MAP = {
  file_read:      ['pm', 'writer', 'ra', 'advisor', 'reviewer', 'analyst'],
  file_write:     ['writer', 'analyst'],
  file_list:      ['pm', 'writer', 'ra', 'advisor', 'reviewer', 'analyst'],
  pubmed_search:  ['ra'],
  arxiv_search:   ['ra'],
  web_search:     ['ra', 'advisor'],
  spawn_agent:    ['pm', 'writer'],
  ask_user:       ['pm'],
  project_config: ['pm'],
};

// ---------------------------------------------------------------------------
// Seed logic
// ---------------------------------------------------------------------------

async function seedAgents() {
  let count = 0;
  for (const def of AGENT_DEFS) {
    const filePath = resolve(REPO_ROOT, def.path);
    let content;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      console.warn(`[seed] Warning: could not read ${def.path} — ${err.message}`);
      continue;
    }

    // Extract description from the "## Role:" heading
    const roleMatch = content.match(/^##\s+Role:\s*(.+)$/m);
    const description = roleMatch ? roleMatch[1].trim() : def.name;

    await query(
      `INSERT INTO agents (slug, name, description, system_prompt, model)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         system_prompt = EXCLUDED.system_prompt,
         model = EXCLUDED.model,
         updated_at = now()`,
      [def.slug, def.name, description, content, def.model ?? null],
    );
    count++;
  }
  console.log(`[seed] Seeded ${count} agents.`);
}

async function seedTools() {
  for (const def of TOOL_DEFS) {
    await query(
      `INSERT INTO tools (slug, name, description, parameter_schema)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         parameter_schema = EXCLUDED.parameter_schema,
         updated_at = now()`,
      [def.slug, def.name, def.description, JSON.stringify(def.parameter_schema)],
    );
  }
  console.log(`[seed] Seeded ${TOOL_DEFS.length} tools.`);
}

async function seedAgentTools() {
  // Build slug → id maps
  const { rows: agentRows } = await query('SELECT id, slug FROM agents');
  const { rows: toolRows } = await query('SELECT id, slug FROM tools');
  const agentMap = Object.fromEntries(agentRows.map((r) => [r.slug, r.id]));
  const toolMap = Object.fromEntries(toolRows.map((r) => [r.slug, r.id]));

  // Clear stale assignments and re-insert
  await query('DELETE FROM agent_tools');

  let count = 0;
  for (const [toolSlug, agentSlugs] of Object.entries(AGENT_TOOL_MAP)) {
    const toolId = toolMap[toolSlug];
    if (!toolId) {
      console.warn(`[seed] Warning: tool "${toolSlug}" not found in DB — skipping assignments`);
      continue;
    }
    for (const agentSlug of agentSlugs) {
      const agentId = agentMap[agentSlug];
      if (!agentId) {
        console.warn(`[seed] Warning: agent "${agentSlug}" not found in DB — skipping`);
        continue;
      }
      await query(
        'INSERT INTO agent_tools (agent_id, tool_id) VALUES ($1, $2)',
        [agentId, toolId],
      );
      count++;
    }
  }
  console.log(`[seed] Seeded ${count} agent-tool assignments.`);
}

export async function seed() {
  await seedAgents();
  await seedTools();
  await seedAgentTools();
}

// Allow standalone execution: node src/db/seed.js
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  seed()
    .then(() => { console.log('[seed] Done.'); process.exit(0); })
    .catch((err) => { console.error('[seed] Failed:', err); process.exit(1); });
}
