// Issue #65: HTTP surface of the Kuhn knowledge catalog. The catalog itself
// (knowledge_packages / knowledge_items, seeded from guidance-docs/catalog.json)
// is org-independent and readable by any authenticated user; per-org state is
// org_knowledge_selections plus the linked org_documents rows. Enabling an
// item imports its content into the org library through the existing
// storeOrgDocument chokepoint (source 'guidance-import'), so ingestion,
// dedupe, status SSE, and FTS all reuse the 006-002 machinery unchanged.
// Org routes go through requireOrgRole with the standard non-leaking guard
// contract; selection writes are owner-only and audited (auth_events).

import { basename } from 'node:path';

import { Router } from 'express';

import { querySync } from '../db.js';
import { recordAuthEvent } from '../db/auth-events.js';
import { CatalogError, readCatalogFile } from '../db/knowledge-catalog.js';
import { deleteOrgDocument, getOrgDocument } from '../db/org-documents.js';
import { StorageError, deleteOrgEntry } from '../storage.js';
import { requireOrgRole } from './guards.js';
import { storeOrgDocument } from './org-library.js';

const router = Router();

// ---- catalog views -----------------------------------------------------------

const publicItem = (row) => ({
  id: row.id,
  title: row.title,
  kind: row.kind,
  version: row.version,
  source_url: row.source_url,
  license: row.license,
  tags: JSON.parse(row.tags || '[]'),
  available: !!row.available,
});

/**
 * The catalog as `{ packages: [...] }` — a flat package list linked by
 * `parent` (webapp api.ts KnowledgePackage). With an orgId, each item is
 * merged with that org's selection/import state (OrgKnowledgeItem).
 */
function catalogPayload(orgId = null) {
  const packages = querySync(
    'SELECT * FROM knowledge_packages ORDER BY sort_order, id',
  ).rows;
  const items = querySync(
    'SELECT * FROM knowledge_items ORDER BY package_id, id',
  ).rows;

  let selected = null;
  let docsByItem = null;
  if (orgId != null) {
    selected = new Set(querySync(
      'SELECT item_id FROM org_knowledge_selections WHERE org_id = $1', [orgId],
    ).rows.map((r) => r.item_id));
    docsByItem = new Map(querySync(
      `SELECT id, status, status_detail, catalog_item_id, catalog_item_version
       FROM org_documents WHERE org_id = $1 AND catalog_item_id IS NOT NULL`, [orgId],
    ).rows.map((r) => [r.catalog_item_id, r]));
  }

  const byPackage = new Map(packages.map((p) => [p.id, []]));
  for (const row of items) {
    let item = publicItem(row);
    if (orgId != null) {
      const doc = docsByItem.get(row.id) ?? null;
      item = {
        ...item,
        enabled: selected.has(row.id),
        doc_id: doc?.id ?? null,
        doc_status: doc?.status ?? null,
        doc_status_detail: doc?.status_detail ?? null,
        imported_version: doc?.catalog_item_version ?? null,
        update_available: doc?.catalog_item_version != null
          && doc.catalog_item_version < row.version,
      };
    }
    byPackage.get(row.package_id)?.push(item);
  }

  return packages.map((p) => ({
    id: p.id,
    parent: p.parent_id,
    title: p.title,
    description: p.description,
    available: !!p.available,
    items: byPackage.get(p.id),
  }));
}

// ---- selection mechanics -----------------------------------------------------

/**
 * Validate a request's item-id list against the catalog. Returns the item
 * rows, or null after sending the 400/409. `requireAvailable` refuses items
 * whose content file is absent in this deploy.
 */
function resolveItems(res, ids, { requireAvailable = false } = {}) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'item ids must be an array of strings' });
    return null;
  }
  const items = [];
  for (const id of ids) {
    const { rows } = querySync('SELECT * FROM knowledge_items WHERE id = $1', [id]);
    if (!rows[0]) {
      res.status(400).json({ error: `unknown catalog item: ${id}` });
      return null;
    }
    if (requireAvailable && !rows[0].available) {
      res.status(409).json({ error: `catalog item unavailable in this deploy: ${id}` });
      return null;
    }
    items.push(rows[0]);
  }
  return items;
}

/** The org's imported copy of a catalog item, if any. */
function importedDoc(orgId, itemId) {
  const { rows } = querySync(
    'SELECT * FROM org_documents WHERE org_id = $1 AND catalog_item_id = $2',
    [orgId, itemId],
  );
  return rows[0] ?? null;
}

/**
 * Import one enabled item into the org library at its current catalog
 * version. Dedupe wrinkle: if the same bytes already live in the library as
 * an upload/promotion, storeOrgDocument returns that row (no catalog link) —
 * stamp the link on it so status/update detection work, rather than dropping
 * the import on the floor.
 */
async function importItem(orgId, item, userId) {
  const buffer = await readCatalogFile(item.path);
  const { document, deduped } = await storeOrgDocument(orgId, buffer, {
    filename: basename(item.path),
    title: item.title,
    source: 'guidance-import',
    createdBy: userId,
    catalogItemId: item.id,
    catalogItemVersion: item.version,
  });
  if (deduped && document.catalog_item_id == null) {
    querySync(
      `UPDATE org_documents SET catalog_item_id = $3, catalog_item_version = $4
       WHERE org_id = $1 AND id = $2`,
      [orgId, document.id, item.id, item.version],
    );
  }
  return document;
}

/** Remove an item's imported copy: bytes, record, chunks (FK cascade), FTS. */
async function removeImportedDoc(orgId, itemId) {
  const doc = importedDoc(orgId, itemId);
  if (!doc) return;
  try {
    await deleteOrgEntry(orgId, String(doc.id)); // the whole <docId>/ dir
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
    // Bytes already gone — still remove the record.
  }
  deleteOrgDocument(orgId, doc.id);
}

// ---- routes ------------------------------------------------------------------

/** GET /api/knowledge/catalog — the Kuhn catalog tree. Any authenticated user. */
router.get('/api/knowledge/catalog', (req, res) => {
  res.json({ packages: catalogPayload() });
});

/** GET /api/orgs/:orgId/knowledge — catalog merged with this org's state. */
router.get('/api/orgs/:orgId/knowledge', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  res.json({ packages: catalogPayload(ctx.orgId) });
});

/**
 * PUT /api/orgs/:orgId/knowledge/selections — owner-only batch toggle:
 * `{ enable: [itemId…], disable: [itemId…] }`. Enabling records the selection
 * and imports the content; disabling removes both the selection and the
 * imported document. Package-level toggles are client-side expansion — this
 * API is item-granular only. Returns the refreshed merged state.
 */
router.put('/api/orgs/:orgId/knowledge/selections', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;

  const enable = resolveItems(res, req.body?.enable ?? [], { requireAvailable: true });
  if (!enable) return;
  const disable = resolveItems(res, req.body?.disable ?? []);
  if (!disable) return;
  const overlap = enable.find((i) => disable.some((d) => d.id === i.id));
  if (overlap) {
    res.status(400).json({ error: `item in both enable and disable: ${overlap.id}` });
    return;
  }

  try {
    for (const item of disable) {
      await removeImportedDoc(ctx.orgId, item.id);
      querySync(
        'DELETE FROM org_knowledge_selections WHERE org_id = $1 AND item_id = $2',
        [ctx.orgId, item.id],
      );
    }
    for (const item of enable) {
      querySync(
        `INSERT INTO org_knowledge_selections (org_id, item_id, enabled_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (org_id, item_id) DO NOTHING`,
        [ctx.orgId, item.id, req.user.id],
      );
      // Idempotent re-enable: an existing import stays as-is (reimport is the
      // explicit refresh path), a missing one is imported now.
      if (!importedDoc(ctx.orgId, item.id)) {
        await importItem(ctx.orgId, item, req.user.id);
      }
    }
  } catch (err) {
    if (err instanceof CatalogError || err instanceof StorageError) {
      res.status(502).json({ error: `knowledge import failed: ${err.message}` });
      return;
    }
    throw err;
  }

  if (enable.length > 0) {
    recordAuthEvent({
      type: 'knowledge.enable', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { items: enable.map((i) => i.id) },
    });
  }
  if (disable.length > 0) {
    recordAuthEvent({
      type: 'knowledge.disable', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { items: disable.map((i) => i.id) },
    });
  }
  res.json({ packages: catalogPayload(ctx.orgId) });
});

/**
 * POST /api/orgs/:orgId/knowledge/reimport — owner-only `{ items: [itemId…] }`.
 * Re-import enabled items (failed ingests, catalog version bumps): delete the
 * imported copy and store it fresh at the current catalog version.
 */
router.post('/api/orgs/:orgId/knowledge/reimport', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;

  const items = resolveItems(res, req.body?.items ?? [], { requireAvailable: true });
  if (!items) return;
  const notEnabled = items.find((item) => querySync(
    'SELECT 1 FROM org_knowledge_selections WHERE org_id = $1 AND item_id = $2',
    [ctx.orgId, item.id],
  ).rows.length === 0);
  if (notEnabled) {
    res.status(409).json({ error: `catalog item not enabled: ${notEnabled.id}` });
    return;
  }

  try {
    for (const item of items) {
      await removeImportedDoc(ctx.orgId, item.id);
      await importItem(ctx.orgId, item, req.user.id);
    }
  } catch (err) {
    if (err instanceof CatalogError || err instanceof StorageError) {
      res.status(502).json({ error: `knowledge import failed: ${err.message}` });
      return;
    }
    throw err;
  }

  res.json({ packages: catalogPayload(ctx.orgId) });
});

export default router;
