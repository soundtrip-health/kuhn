import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Seed agents, tools, and agent↔tool assignments from db/seed.sql.
//
// seed.sql is the source of truth for agent system prompts (and tool/assignment
// definitions). To change a prompt, edit seed.sql and re-run: `npm run db:seed`.
// All statements in seed.sql are idempotent (ON CONFLICT upserts).
// ---------------------------------------------------------------------------
export async function seed() {
  const sqlPath = resolve(__dirname, 'seed.sql');
  const sql = await readFile(sqlPath, 'utf-8');
  await query(sql);
  console.log('[seed] Applied db/seed.sql (agents, tools, assignments).');
}

// Allow standalone execution: node src/db/seed.js
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  seed()
    .then(() => { console.log('[seed] Done.'); process.exit(0); })
    .catch((err) => { console.error('[seed] Failed:', err); process.exit(1); });
}
