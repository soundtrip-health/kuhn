import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from '../db.js';
import { seed } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function initDb() {
  // Apply schema DDL (multi-statement script).
  const schemaPath = resolve(__dirname, 'schema.sql');
  const schemaSql = await readFile(schemaPath, 'utf-8');
  exec(schemaSql);
  console.log('[db] Schema applied.');

  // Seed default tenant, agents, tools, and assignments.
  await seed();
}
