import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, querySync, transaction } from '../db.js';
import { AGENTS, TOOLS, ASSIGNMENTS, DEFAULT_ORG, DEFAULT_USER } from './seed-data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Seed the default tenant, agents, tools, and agent↔tool assignments.
//
// Source of truth: agent system prompts are db/prompts/<slug>.md; tool and
// assignment definitions are db/seed-data.js. To change a prompt, edit its .md
// file and re-run `npm run db:seed`. Everything here is idempotent.
// ---------------------------------------------------------------------------
export async function seed() {
  // --- Default tenant (story 005): a non-orphaned baseline -------------------
  await query(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING',
    [DEFAULT_ORG.name, DEFAULT_ORG.slug],
  );
  await query(
    'INSERT INTO users (email, display_name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
    [DEFAULT_USER.email, DEFAULT_USER.displayName],
  );
  await query(
    `INSERT INTO memberships (user_id, org_id, role)
     SELECT u.id, o.id, 'owner'
     FROM users u, organizations o
     WHERE u.email = $1 AND o.slug = $2
     ON CONFLICT (user_id, org_id) DO NOTHING`,
    [DEFAULT_USER.email, DEFAULT_ORG.slug],
  );

  // --- Agents (prompts from db/prompts/<slug>.md) ----------------------------
  for (const a of AGENTS) {
    const prompt = await readFile(resolve(__dirname, 'prompts', `${a.slug}.md`), 'utf-8');
    await query(
      `INSERT INTO agents (slug, name, description, system_prompt, model)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         system_prompt = excluded.system_prompt,
         model = excluded.model,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [a.slug, a.name, a.description, prompt, a.model],
    );
  }

  // --- Tools -----------------------------------------------------------------
  for (const t of TOOLS) {
    await query(
      `INSERT INTO tools (slug, name, description, parameter_schema)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         parameter_schema = excluded.parameter_schema,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [t.slug, t.name, t.description, JSON.stringify(t.parameterSchema)],
    );
  }

  // --- Agent ↔ tool assignments (rebuilt from scratch) -----------------------
  transaction(() => {
    querySync('DELETE FROM agent_tools');
    for (const [agentSlug, toolSlug] of ASSIGNMENTS) {
      querySync(
        `INSERT INTO agent_tools (agent_id, tool_id)
         SELECT a.id, t.id FROM agents a, tools t
         WHERE a.slug = $1 AND t.slug = $2
         ON CONFLICT (agent_id, tool_id) DO NOTHING`,
        [agentSlug, toolSlug],
      );
    }
  });

  console.log('[seed] Applied default tenant, agents, tools, and assignments.');
}

// Allow standalone execution: node src/db/seed.js
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  seed()
    .then(() => { console.log('[seed] Done.'); process.exit(0); })
    .catch((err) => { console.error('[seed] Failed:', err); process.exit(1); });
}
