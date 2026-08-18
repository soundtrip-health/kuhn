// Issue #65: HTTP surface of the Kuhn knowledge catalog. The catalog itself
// (knowledge_packages / knowledge_items, seeded from guidance-docs/catalog.json)
// is org-independent and readable by any authenticated user; per-org state is
// org_knowledge_selections plus the linked org_documents rows. Enabling an
// item imports its content into the org library through the existing
// storeOrgDocument chokepoint (source 'guidance-import'), so ingestion,
// dedupe, status SSE, and FTS all reuse the 006-002 machinery unchanged.
// Org routes go through requireOrgRole with the standard non-leaking guard
// contract; selection writes are owner-only and audited (auth_events).

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { Router } from 'express';

import { querySync, transaction } from '../db.js';
import { recordAuthEvent } from '../db/auth-events.js';
import { CatalogError, readCatalogFile } from '../db/knowledge-catalog.js';
import { deleteOrgDocument, getOrgDocument } from '../db/org-documents.js';
import { queueIngest } from '../ingest.js';
import { StorageError, deleteOrgEntry } from '../storage.js';
import { requireOrgRole } from './guards.js';
import { storeOrgDocument } from './org-library.js';

const router = Router();

// ---- catalog views -----------------------------------------------------------

/** Tags are stored as a JSON array string; a malformed row degrades to []. */
function parseTags(raw) {
  try {
    const tags = JSON.parse(raw || '[]');
    return Array.isArray(tags) ? tags : [];
  } catch {
    return [];
  }
}

const publicItem = (row) => ({
  id: row.id,
  title: row.title,
  kind: row.kind,
  version: row.version,
  source_url: row.source_url,
  license: row.license,
  tags: parseTags(row.tags),
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
 * Whether a linked row is catalog-owned: created by a catalog import. A row
 * whose source is 'upload' or 'project-promotion' existed independently of the
 * catalog and was merely *adopted* by a selection via (org, sha256) dedupe —
 * the catalog may borrow it, but never owns (and never deletes) it.
 */
const catalogOwned = (doc) => doc.source === 'guidance-import';

/** Drop a row's catalog link, leaving the document itself untouched. */
function unlinkCatalogDoc(orgId, docId) {
  querySync(
    `UPDATE org_documents
     SET catalog_item_id = NULL, catalog_item_version = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE org_id = $1 AND id = $2`,
    [orgId, docId],
  );
}

/** Stamp a row as the org's imported copy of `item` at `version`. */
function linkCatalogDoc(orgId, docId, item, version) {
  querySync(
    `UPDATE org_documents
     SET catalog_item_id = $3, catalog_item_version = $4,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE org_id = $1 AND id = $2`,
    [orgId, docId, item.id, version],
  );
}

/**
 * Import one enabled item into the org library at its current catalog
 * version. Dedupe wrinkle: if the same bytes already live in the library as
 * an upload/promotion, storeOrgDocument returns that row (no catalog link) —
 * stamp the link on it so status/update detection work, rather than dropping
 * the import on the floor. The adopted row keeps its original source, which
 * is what marks it user-owned for removeImportedDoc/reimportItem below.
 *
 * If the deduped row is already serving a *different* catalog item, refuse:
 * one org_documents row carries at most one catalog link, so linking it here
 * would steal the other item's import, and skipping the link would leave this
 * item enabled with no document behind it. Same invariant as the changed-bytes
 * refusal in reimportItem.
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
  if (deduped && document.catalog_item_id != null && document.catalog_item_id !== item.id) {
    throw new CatalogError('conflict',
      `content of ${item.id} is identical to the already-enabled ${document.catalog_item_id}; `
      + 'disable that item first');
  }
  if (deduped && document.catalog_item_id == null) {
    linkCatalogDoc(orgId, document.id, item, item.version);
  }
  return document;
}

/**
 * Undo an item's import. Catalog-owned copies are deleted outright — bytes,
 * record, chunks (FK cascade), FTS. An adopted upload/promotion is only
 * unlinked: the user's document, bytes, and ingest state all survive.
 */
async function removeImportedDoc(orgId, itemId) {
  const doc = importedDoc(orgId, itemId);
  if (!doc) return;
  if (!catalogOwned(doc)) {
    unlinkCatalogDoc(orgId, doc.id);
    return;
  }
  try {
    await deleteOrgEntry(orgId, String(doc.id)); // the whole <docId>/ dir
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
    // Bytes already gone — still remove the record.
  }
  deleteOrgDocument(orgId, doc.id);
}

/**
 * Refresh an item's import to the current catalog content, never destroying
 * the last known-good copy on failure. Sequence: read the replacement first
 * (missing file, containment refusal → nothing has been touched); identical
 * bytes → restamp the version on the existing row; changed bytes → store the
 * replacement fully, then swap the catalog link in one transaction (the old
 * copy is deleted only if catalog-owned, an adopted upload is just unlinked)
 * and clean the old bytes up last (best-effort), after the swap is committed.
 */
async function reimportItem(orgId, item, userId) {
  const buffer = await readCatalogFile(item.path);
  const old = importedDoc(orgId, item.id);
  if (!old) return importItem(orgId, item, userId);

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 === old.sha256) {
    // Same bytes — nothing to replace. Restamp the version; retry a failed
    // ingest (the other reason owners reach for re-import).
    linkCatalogDoc(orgId, old.id, item, item.version);
    if (old.status === 'failed') queueIngest(orgId, old.id);
    return getOrgDocument(orgId, old.id);
  }

  // Changed bytes: stage the replacement before touching the old copy. Stored
  // without the catalog link — (org_id, catalog_item_id) is unique while the
  // old row still holds it. A storage failure here leaves the old import
  // intact (storeOrgDocument removes its own orphan row on write failure).
  const { document: fresh } = await storeOrgDocument(orgId, buffer, {
    filename: basename(item.path),
    title: item.title,
    source: 'guidance-import',
    createdBy: userId,
  });
  if (fresh.catalog_item_id != null) {
    // Dedupe landed on a row already serving a different catalog item (fresh
    // can't be `old`: the bytes differ). Stealing its link would break that
    // item's import — refuse, leaving the old copy in place.
    throw new CatalogError('conflict',
      `replacement bytes for ${item.id} are already imported as ${fresh.catalog_item_id}`);
  }
  transaction(() => {
    if (catalogOwned(old)) deleteOrgDocument(orgId, old.id);
    else unlinkCatalogDoc(orgId, old.id);
    linkCatalogDoc(orgId, fresh.id, item, item.version);
  });
  if (catalogOwned(old)) {
    // The swap is committed and the new import is live — from here on, a
    // failure to delete the replaced bytes must not fail the reimport (a
    // retry would take the identical-bytes branch and never reach this
    // delete again). Log the leaked directory and move on.
    try {
      await deleteOrgEntry(orgId, String(old.id));
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'not_found')) {
        console.error(
          `[knowledge] Failed to remove replaced import ${old.id} (org ${orgId}, item ${item.id}):`,
          err,
        );
      }
    }
  }
  return getOrgDocument(orgId, fresh.id);
}

/**
 * Batch-failure HTTP shape, shared by selections and reimport: a deliberate
 * refusal (CatalogError 'conflict') is a 409 the operator can act on; every
 * other import failure is a 502.
 */
function sendImportFailure(res, err) {
  const conflict = err instanceof CatalogError && err.code === 'conflict';
  res.status(conflict ? 409 : 502)
    .json({ error: `knowledge import ${conflict ? 'refused' : 'failed'}: ${err.message}` });
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

  // Items are applied one at a time, each all-or-nothing, and the batch stops
  // at the first failure: a failed import records no selection (the item stays
  // visibly disabled and re-checkable), a failed removal keeps both selection
  // and document (retry disables again). The audit rows list exactly the items
  // that actually changed, whether or not the batch finished.
  const disabled = [];
  const enabled = [];
  let failure = null;
  try {
    for (const item of disable) {
      await removeImportedDoc(ctx.orgId, item.id);
      querySync(
        'DELETE FROM org_knowledge_selections WHERE org_id = $1 AND item_id = $2',
        [ctx.orgId, item.id],
      );
      disabled.push(item.id);
    }
    for (const item of enable) {
      // Idempotent re-enable: an existing import stays as-is (reimport is the
      // explicit refresh path), a missing one is imported now — before the
      // selection row, so a failed import leaves the item cleanly disabled.
      if (!importedDoc(ctx.orgId, item.id)) {
        await importItem(ctx.orgId, item, req.user.id);
      }
      querySync(
        `INSERT INTO org_knowledge_selections (org_id, item_id, enabled_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (org_id, item_id) DO NOTHING`,
        [ctx.orgId, item.id, req.user.id],
      );
      enabled.push(item.id);
    }
  } catch (err) {
    if (!(err instanceof CatalogError || err instanceof StorageError)) throw err;
    failure = err;
  }

  if (enabled.length > 0) {
    recordAuthEvent({
      type: 'knowledge.enable', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { items: enabled },
    });
  }
  if (disabled.length > 0) {
    recordAuthEvent({
      type: 'knowledge.disable', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { items: disabled },
    });
  }
  if (failure) {
    sendImportFailure(res, failure);
    return;
  }
  res.json({ packages: catalogPayload(ctx.orgId) });
});

/**
 * POST /api/orgs/:orgId/knowledge/reimport — owner-only `{ items: [itemId…] }`.
 * Re-import enabled items (failed ingests, catalog version bumps) via
 * reimportItem: the replacement is read and stored before the previous copy is
 * replaced, so a failed reimport always leaves the last good import usable.
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

  // Same batch semantics as selections: stop at the first failure, audit what
  // actually happened. A failed item keeps its previous imported copy.
  const reimported = [];
  let failure = null;
  try {
    for (const item of items) {
      await reimportItem(ctx.orgId, item, req.user.id);
      reimported.push(item.id);
    }
  } catch (err) {
    if (!(err instanceof CatalogError || err instanceof StorageError)) throw err;
    failure = err;
  }

  if (reimported.length > 0) {
    recordAuthEvent({
      type: 'knowledge.reimport', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { items: reimported },
    });
  }
  if (failure) {
    sendImportFailure(res, failure);
    return;
  }
  res.json({ packages: catalogPayload(ctx.orgId) });
});

export default router;
