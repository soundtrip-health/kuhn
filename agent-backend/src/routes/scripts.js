// Issue #68: HTTP surface of the shared-script library. The Kuhn catalog
// (catalog_scripts, seeded from shared-scripts/catalog.json) is
// org-independent and readable by any authenticated user; org state is
// org_scripts + org_script_versions (import/promote/version) and
// script_promotion_requests (the owner review queue). Org routes go through
// requireOrgRole with the standard non-leaking guard contract; library writes
// are owner-only and audited (auth_events). Script code is text in the DB —
// nothing here touches storage.js or the ingestion pipeline.

import { Router } from 'express';

import { config } from '../config.js';
import { querySync } from '../db.js';
import { recordAuthEvent } from '../db/auth-events.js';
import {
  ScriptError,
  addScriptVersion,
  createOrgScript,
  getOrgScript,
  getOrgScriptByCatalogId,
  getScriptVersion,
  listOrgScripts,
  listScriptVersions,
  setScriptStatus,
  sha256Hex,
  stampCatalogVersion,
} from '../db/org-scripts.js';
import {
  claimScriptPromotionDecision,
  getScriptPromotion,
  listScriptPromotions,
  revertScriptPromotionToPending,
  setScriptPromotionResult,
} from '../db/script-promotions.js';
import { ScriptCatalogError, readCatalogScript } from '../db/script-catalog.js';
import { StorageError, readProjectFile } from '../storage.js';
import { publishOrgEvent, publishProjectEvent } from '../project-events.js';
import { requireOrgRole } from './guards.js';

const router = Router();

// ---- payload shapes ----------------------------------------------------------

function parseJsonArray(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const publicCatalogScript = (row) => ({
  id: row.id,
  title: row.title,
  language: row.language,
  entrypoint: row.entrypoint,
  version: row.version,
  description: row.description,
  args: parseJsonArray(row.args_json),
  tags: parseJsonArray(row.tags),
  available: !!row.available,
});

export const publicOrgScript = (row) => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  language: row.language,
  description: row.description,
  args: parseJsonArray(row.args_json),
  source: row.source,
  status: row.status,
  catalog_script_id: row.catalog_script_id,
  catalog_script_version: row.catalog_script_version,
  update_available: !!row.update_available,
  current_version: row.current_version,
  current_sha256: row.current_sha256,
  current_entrypoint: row.current_entrypoint,
  current_version_at: row.current_version_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const catalogRows = () => querySync(
  'SELECT * FROM catalog_scripts ORDER BY id',
).rows;

const catalogRow = (id) => querySync(
  'SELECT * FROM catalog_scripts WHERE id = $1', [id],
).rows[0] ?? null;

/** Merged payload for one org: catalog (with import state) + org scripts. */
function orgScriptsPayload(orgId) {
  const scripts = listOrgScripts(orgId);
  const byCatalogId = new Map(
    scripts.filter((s) => s.catalog_script_id).map((s) => [s.catalog_script_id, s]),
  );
  const catalog = catalogRows().map((row) => {
    const imported = byCatalogId.get(row.id) ?? null;
    return {
      ...publicCatalogScript(row),
      org_script_id: imported?.id ?? null,
      org_script_status: imported?.status ?? null,
    };
  });
  return { catalog, scripts: scripts.map(publicOrgScript) };
}

/** The catalog id's tail is the default org-script slug ("r/summarize-csv" → "summarize-csv"). */
const slugFromCatalogId = (id) => id.split('/').pop();

// ---- catalog views -----------------------------------------------------------

/** GET /api/scripts/catalog — the Kuhn script catalog. Any authenticated user. */
router.get('/api/scripts/catalog', (req, res) => {
  res.json({ scripts: catalogRows().map(publicCatalogScript) });
});

/** GET /api/orgs/:orgId/scripts — catalog merged with this org's library. */
router.get('/api/orgs/:orgId/scripts', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  res.json(orgScriptsPayload(ctx.orgId));
});

/**
 * GET /api/orgs/:orgId/scripts/:idOrSlug — one script with its current
 * content and version history. Viewer: org members may read the code the
 * org's agents run (same stance as agent prompts, issue #67).
 */
router.get('/api/orgs/:orgId/scripts/:idOrSlug', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  const script = getOrgScript(ctx.orgId, req.params.idOrSlug);
  if (!script) {
    res.status(404).json({ error: 'script not found' });
    return;
  }
  const current = getScriptVersion(ctx.orgId, script.id, null);
  res.json({
    script: publicOrgScript(script),
    content: current?.content ?? '',
    versions: listScriptVersions(ctx.orgId, script.id),
  });
});

/** GET /api/orgs/:orgId/scripts/:idOrSlug/versions/:version — historical content. */
router.get('/api/orgs/:orgId/scripts/:idOrSlug/versions/:version', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  const script = getOrgScript(ctx.orgId, req.params.idOrSlug);
  const version = Number(req.params.version);
  if (!script || !Number.isInteger(version)) {
    res.status(404).json({ error: 'script not found' });
    return;
  }
  const row = getScriptVersion(ctx.orgId, script.id, version);
  if (!row) {
    res.status(404).json({ error: 'version not found' });
    return;
  }
  res.json({ version: row });
});

// ---- library writes (owner) --------------------------------------------------

function validateIdList(res, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'scripts must be a non-empty array of catalog ids' });
    return null;
  }
  return ids;
}

/**
 * POST /api/orgs/:orgId/scripts/import — owner, { scripts: [catalogId…] }.
 * Imports each catalog script as an org script (code copied at the current
 * catalog version). Re-importing an existing import just re-activates it —
 * refreshing content is the explicit reimport route. Batch stops at the
 * first failure; the audit row lists what actually changed.
 */
router.post('/api/orgs/:orgId/scripts/import', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const ids = validateIdList(res, req.body?.scripts);
  if (!ids) return;

  const imported = [];
  let failure = null;
  try {
    for (const id of ids) {
      const item = catalogRow(id);
      if (!item) throw new ScriptError('not_found', `unknown catalog script: ${id}`);
      if (!item.available) {
        throw new ScriptError('invalid', `catalog script unavailable in this deploy: ${id}`);
      }
      const existing = getOrgScriptByCatalogId(ctx.orgId, id);
      if (existing) {
        if (existing.status === 'disabled') setScriptStatus(ctx.orgId, existing.id, 'active');
        continue;
      }
      const content = await readCatalogScript(item.path);
      createOrgScript({
        orgId: ctx.orgId,
        slug: slugFromCatalogId(id),
        title: item.title,
        language: item.language,
        description: item.description,
        args: parseJsonArray(item.args_json),
        source: 'catalog-import',
        catalogScriptId: id,
        catalogScriptVersion: item.version,
        content,
        entrypoint: item.entrypoint,
        changeNote: `imported from catalog v${item.version}`,
        createdBy: req.user.id,
      });
      imported.push(id);
    }
  } catch (err) {
    if (!(err instanceof ScriptError || err instanceof ScriptCatalogError)) throw err;
    failure = err;
  }

  if (imported.length > 0) {
    recordAuthEvent({
      type: 'script.import', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { scripts: imported },
    });
  }
  if (failure) {
    const conflict = failure instanceof ScriptError && failure.code === 'slug_taken';
    res.status(conflict ? 409 : 400).json({ error: failure.message });
    return;
  }
  res.json(orgScriptsPayload(ctx.orgId));
});

/** PATCH /api/orgs/:orgId/scripts/:id — owner, { status: 'active'|'disabled' }. */
router.patch('/api/orgs/:orgId/scripts/:idOrSlug', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const status = req.body?.status;
  if (status !== 'active' && status !== 'disabled') {
    res.status(400).json({ error: 'status must be active or disabled', field: 'status' });
    return;
  }
  const script = getOrgScript(ctx.orgId, req.params.idOrSlug);
  if (!script) {
    res.status(404).json({ error: 'script not found' });
    return;
  }
  const updated = setScriptStatus(ctx.orgId, script.id, status);
  recordAuthEvent({
    type: status === 'active' ? 'script.enable' : 'script.disable',
    actorUserId: req.user.id,
    orgId: ctx.orgId,
    meta: { script: script.slug },
  });
  res.json({ script: publicOrgScript(updated) });
});

/**
 * POST /api/orgs/:orgId/scripts/reimport — owner, { scripts: [catalogId…] }.
 * Refresh imported scripts to the current catalog content: identical bytes
 * restamp the imported version; changed bytes append a new version (history
 * preserved — the old version stays reachable).
 */
router.post('/api/orgs/:orgId/scripts/reimport', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const ids = validateIdList(res, req.body?.scripts);
  if (!ids) return;

  const reimported = [];
  let failure = null;
  try {
    for (const id of ids) {
      const item = catalogRow(id);
      if (!item) throw new ScriptError('not_found', `unknown catalog script: ${id}`);
      if (!item.available) {
        throw new ScriptError('invalid', `catalog script unavailable in this deploy: ${id}`);
      }
      const existing = getOrgScriptByCatalogId(ctx.orgId, id);
      if (!existing) throw new ScriptError('not_found', `catalog script not imported: ${id}`);
      const content = await readCatalogScript(item.path);
      if (sha256Hex(content) === existing.current_sha256) {
        stampCatalogVersion(ctx.orgId, existing.id, item.version);
      } else {
        addScriptVersion(ctx.orgId, existing.id, {
          content,
          entrypoint: item.entrypoint,
          changeNote: `reimported from catalog v${item.version}`,
          createdBy: req.user.id,
          catalogScriptVersion: item.version,
        });
      }
      reimported.push(id);
    }
  } catch (err) {
    if (!(err instanceof ScriptError || err instanceof ScriptCatalogError)) throw err;
    failure = err;
  }

  if (reimported.length > 0) {
    recordAuthEvent({
      type: 'script.reimport', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { scripts: reimported },
    });
  }
  if (failure) {
    res.status(failure.code === 'not_found' ? 404 : 400).json({ error: failure.message });
    return;
  }
  res.json(orgScriptsPayload(ctx.orgId));
});

// ---- promotion review queue (owner) ------------------------------------------

/** GET /api/orgs/:orgId/script-promotions?status= — the owner queue. */
router.get('/api/orgs/:orgId/script-promotions', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const { status } = req.query;
  res.json({ requests: listScriptPromotions(ctx.orgId, { status: status || null }) });
});

/**
 * GET /api/orgs/:orgId/script-promotions/:id — one request with the LIVE
 * project-file content (plus its sha256, echoed back on approve so drift
 * between review and decision is caught) and, for update proposals, the
 * target script's current content for diffing.
 */
router.get('/api/orgs/:orgId/script-promotions/:id', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const request = getScriptPromotion(ctx.orgId, Number(req.params.id));
  if (!request) {
    res.status(404).json({ error: 'script promotion not found' });
    return;
  }
  let content = null;
  let sha256 = null;
  let contentError = null;
  try {
    const raw = await readScriptContent(request.project_id, request.path);
    content = raw;
    sha256 = sha256Hex(raw);
  } catch (err) {
    if (!(err instanceof StorageError || err instanceof ScriptError)) throw err;
    contentError = err.message;
  }
  let targetContent = null;
  if (request.target_script_id) {
    targetContent = getScriptVersion(ctx.orgId, request.target_script_id, null)?.content ?? null;
  }
  res.json({
    request, content, sha256, content_error: contentError, target_content: targetContent,
  });
});

/** Read a promotion's script from its project, enforcing the script size cap. */
async function readScriptContent(projectId, path) {
  const buffer = await readProjectFile(projectId, path);
  if (buffer.length > config.scripts.maxScriptBytes) {
    throw new ScriptError('invalid',
      `script exceeds the ${config.scripts.maxScriptBytes}-byte cap`);
  }
  return buffer.toString('utf-8');
}

/**
 * POST /api/orgs/:orgId/script-promotions/:id/approve — owner. Body
 * { expected_sha256, slug?, decision_note? }. Claim-then-copy: the pending
 * row is claimed atomically, the file is re-read, and a mismatch with the
 * sha256 the owner reviewed reverts the claim with 409 (the content changed
 * under review). New scripts take `slug` (default: the filename stem);
 * update proposals append a version to the target script.
 */
router.post('/api/orgs/:orgId/script-promotions/:id/approve', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const { expected_sha256: expectedSha, slug, decision_note: note } = req.body ?? {};
  if (typeof expectedSha !== 'string' || !expectedSha) {
    res.status(400).json({ error: 'expected_sha256 is required', field: 'expected_sha256' });
    return;
  }
  const id = Number(req.params.id);
  const claimed = claimScriptPromotionDecision({
    id, orgId: ctx.orgId, status: 'approved', decidedBy: req.user.id,
    note: typeof note === 'string' && note.trim() ? note.trim() : null,
  });
  if (!claimed) {
    res.status(404).json({ error: 'script promotion not found' });
    return;
  }

  const fail = (status, error) => {
    revertScriptPromotionToPending(id);
    res.status(status).json({ error });
  };

  let content;
  try {
    content = await readScriptContent(claimed.project_id, claimed.path);
  } catch (err) {
    if (err instanceof StorageError) {
      return fail(409, `script could not be read: ${err.message}`);
    }
    if (err instanceof ScriptError) return fail(409, err.message);
    revertScriptPromotionToPending(id);
    throw err;
  }
  if (sha256Hex(content) !== expectedSha) {
    return fail(409, 'script changed since it was reviewed — reload and review again');
  }

  const entrypoint = claimed.path.split('/').pop();
  let script;
  try {
    if (claimed.target_script_id) {
      script = addScriptVersion(ctx.orgId, claimed.target_script_id, {
        content,
        entrypoint,
        changeNote: claimed.note,
        sourceProjectId: claimed.project_id,
        sourcePath: claimed.path,
        createdBy: claimed.suggested_by,
      });
    } else {
      const scriptSlug = typeof slug === 'string' && slug.trim()
        ? slug.trim().toLowerCase()
        : entrypoint.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(scriptSlug)) {
        return fail(400, `invalid script slug: ${scriptSlug}`);
      }
      script = createOrgScript({
        orgId: ctx.orgId,
        slug: scriptSlug,
        title: claimed.title ?? entrypoint,
        language: claimed.language,
        source: 'project-promotion',
        content,
        entrypoint,
        changeNote: claimed.note,
        sourceProjectId: claimed.project_id,
        sourcePath: claimed.path,
        createdBy: claimed.suggested_by,
      });
    }
  } catch (err) {
    if (err instanceof ScriptError && err.code === 'slug_taken') {
      return fail(409, `${err.message} — pass a different slug`);
    }
    revertScriptPromotionToPending(id);
    throw err;
  }

  setScriptPromotionResult(id, script.id);
  recordAuthEvent({
    type: 'script.promotion.approved', actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { requestId: id, script: script.slug, version: script.current_version },
  });
  publishProjectEvent(claimed.project_id, {
    type: 'script_promotion', requestId: id, path: claimed.path, status: 'approved',
  });
  publishOrgEvent(ctx.orgId, {
    type: 'script_promotion', requestId: id, status: 'approved', scriptId: script.id,
  });
  res.json({ request: getScriptPromotion(ctx.orgId, id), script: publicOrgScript(script) });
});

/** POST /api/orgs/:orgId/script-promotions/:id/reject — owner, { decision_note? }. */
router.post('/api/orgs/:orgId/script-promotions/:id/reject', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const note = req.body?.decision_note;
  const id = Number(req.params.id);
  const claimed = claimScriptPromotionDecision({
    id, orgId: ctx.orgId, status: 'rejected', decidedBy: req.user.id,
    note: typeof note === 'string' && note.trim() ? note.trim() : null,
  });
  if (!claimed) {
    res.status(404).json({ error: 'script promotion not found' });
    return;
  }
  recordAuthEvent({
    type: 'script.promotion.rejected', actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { requestId: id },
  });
  publishProjectEvent(claimed.project_id, {
    type: 'script_promotion', requestId: id, path: claimed.path, status: 'rejected',
  });
  res.json({ request: getScriptPromotion(ctx.orgId, id) });
});

export default router;
