import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';
import { seed } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function initDb() {
  // Enable pgvector (must run outside a transaction)
  await query('CREATE EXTENSION IF NOT EXISTS vector');

  // Apply schema DDL
  const schemaPath = resolve(__dirname, 'schema.sql');
  const schemaSql = await readFile(schemaPath, 'utf-8');
  await query(schemaSql);
  console.log('[db] Schema applied.');

  // Seed agents, tools, and assignments
  await seed();
}
