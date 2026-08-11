import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, querySync, transaction } from '../db.js';
import { AGENTS, TOOLS, ASSIGNMENTS, DEFAULT_ORG, DEFAULT_USER } from './seed-data.js';
import { catalogFileExists, loadCatalogManifest } from './knowledge-catalog.js';

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

  await seedKnowledgeCatalog();

  console.log('[seed] Applied default tenant, agents, tools, assignments, and knowledge catalog.');
}

/**
 * Issue #65: seed knowledge_packages/knowledge_items from
 * guidance-docs/catalog.json. Idempotent upserts, same discipline as agents/
 * tools above, with two catalog-specific rules: rows that leave the manifest
 * are marked available = 0, never deleted (orgs may hold imported copies);
 * items whose content file is absent in this checkout are seeded but
 * unavailable, with a warning rather than an error.
 */
export async function seedKnowledgeCatalog() {
  const manifest = await loadCatalogManifest();
  if (!manifest) {
    console.warn('[seed] guidance-docs/catalog.json not found — knowledge catalog not seeded.');
    return;
  }

  const seenPackages = [];
  const seenItems = [];
  let missingFiles = 0;

  // Availability checks are async, so gather everything before the
  // synchronous transaction below.
  const packageRows = [];
  const itemRows = [];
  for (const [index, pkg] of manifest.packages.entries()) {
    let availableItems = 0;
    const rows = [];
    for (const item of pkg.items) {
      const exists = await catalogFileExists(item.path);
      if (!exists) {
        missingFiles += 1;
        console.warn(`[seed] knowledge item ${item.id}: content file missing (${item.path}) — marked unavailable.`);
      } else {
        availableItems += 1;
      }
      rows.push({ ...item, packageId: pkg.id, available: exists ? 1 : 0 });
    }
    packageRows.push({
      id: pkg.id,
      parentId: pkg.parent ?? null,
      title: pkg.title,
      description: pkg.description ?? null,
      sortOrder: index,
      // A package with items but none present in this deploy is unavailable
      // (private content dir absent); an empty package stays available.
      available: pkg.items.length === 0 || availableItems > 0 ? 1 : 0,
    });
    itemRows.push(...rows);
    seenPackages.push(pkg.id);
    seenItems.push(...pkg.items.map((i) => i.id));
  }

  transaction(() => {
    for (const p of packageRows) {
      querySync(
        `INSERT INTO knowledge_packages (id, parent_id, title, description, sort_order, available)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           parent_id = excluded.parent_id,
           title = excluded.title,
           description = excluded.description,
           sort_order = excluded.sort_order,
           available = excluded.available`,
        [p.id, p.parentId, p.title, p.description, p.sortOrder, p.available],
      );
    }
    for (const i of itemRows) {
      querySync(
        `INSERT INTO knowledge_items (id, package_id, title, path, version, kind, source_url, license, tags, available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           package_id = excluded.package_id,
           title = excluded.title,
           path = excluded.path,
           version = excluded.version,
           kind = excluded.kind,
           source_url = excluded.source_url,
           license = excluded.license,
           tags = excluded.tags,
           available = excluded.available`,
        [i.id, i.packageId, i.title, i.path, i.version, i.kind,
          i.source_url ?? null, i.license ?? null, JSON.stringify(i.tags ?? []), i.available],
      );
    }
    // Never delete: anything the manifest no longer lists goes unavailable.
    querySync(
      `UPDATE knowledge_items SET available = 0
       WHERE id NOT IN (SELECT value FROM json_each($1))`,
      [JSON.stringify(seenItems)],
    );
    querySync(
      `UPDATE knowledge_packages SET available = 0
       WHERE id NOT IN (SELECT value FROM json_each($1))`,
      [JSON.stringify(seenPackages)],
    );
  });

  const note = missingFiles ? ` (${missingFiles} item(s) unavailable — content missing)` : '';
  console.log(`[seed] Knowledge catalog v${manifest.catalog_version}: ${packageRows.length} packages, ${itemRows.length} items${note}.`);
}

// Allow standalone execution: node src/db/seed.js
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  seed()
    .then(() => { console.log('[seed] Done.'); process.exit(0); })
    .catch((err) => { console.error('[seed] Failed:', err); process.exit(1); });
}
