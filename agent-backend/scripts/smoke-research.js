// Story 011 smoke test: research agent answers a PubMed-style query
// end-to-end through the agent-task boundary.
//
// Requires: ANTHROPIC_API_KEY set (SQLite DB is created in-process on startup).
// Usage: node scripts/smoke-research.js ["your research question"]

import { initDb } from '../src/db/init.js';
import { query } from '../src/db.js';
import { runAgentTask } from '../src/agents/runtime.js';

const question = process.argv[2]
  || 'Find 3 recent peer-reviewed papers on target trial emulation in real-world evidence studies. For each, give PMID, title, and one sentence on relevance.';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[smoke] ANTHROPIC_API_KEY not set — relying on Claude Code login credentials.');
}

await initDb();

// Reuse (or create) a dedicated smoke-test project
const existing = await query("SELECT id FROM projects WHERE name = 'Smoke Test' LIMIT 1");
const projectId = existing.rows[0]?.id
  ?? (await query(
    "INSERT INTO projects (name, project_type) VALUES ('Smoke Test', 'manuscript') RETURNING id",
  )).rows[0].id;

console.log(`[smoke] Project ${projectId}; asking research agent:\n  ${question}\n`);

let failed = false;
for await (const event of runAgentTask({ role: 'research', projectId, input: question })) {
  switch (event.type) {
    case 'text':
      console.log(`\n[${event.agent}] ${event.content}`);
      break;
    case 'file_change':
      console.log(`[${event.agent}] ${event.kind} ${event.path}`);
      break;
    case 'error':
      console.error(`[${event.agent}] ERROR: ${event.message}`);
      failed = true;
      break;
    case 'done':
      console.log(`\n[smoke] Done. job=${event.jobId} session=${event.sessionId} `
        + `tokens in=${event.usage.inputTokens} out=${event.usage.outputTokens}`);
      break;
    default:
      console.log(`[event] ${JSON.stringify(event)}`);
  }
}

process.exit(failed ? 1 : 0);
