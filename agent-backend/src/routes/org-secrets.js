// Org secrets HTTP surface (secrets store). Values are write-only: PUT stores,
// GET lists metadata, DELETE removes — nothing here (or anywhere) returns a
// stored value. Editors and up manage secrets (creating a DB credential is
// ordinary working-scientist setup, not org administration); any member may
// list names so they can reference them in agent chat. Writes are audited
// (auth_events), with the secret NAME only in the meta — never the value.

import { Router } from 'express';

import { recordAuthEvent } from '../db/auth-events.js';
import {
  SecretError,
  deleteOrgSecret,
  listOrgSecrets,
  setOrgSecret,
} from '../db/org-secrets.js';
import { requireOrgRole } from './guards.js';

const router = Router();

/** GET /api/orgs/:orgId/secrets — metadata only (member+). */
router.get('/api/orgs/:orgId/secrets', async (req, res) => {
  const access = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!access) return;
  res.json({ secrets: listOrgSecrets(access.orgId) });
});

/**
 * PUT /api/orgs/:orgId/secrets/:name — body { value, description? }.
 * Create or replace (editor+). 400 on a bad name/value; 200 { secret } (metadata).
 */
router.put('/api/orgs/:orgId/secrets/:name', async (req, res) => {
  const access = await requireOrgRole(req, res, req.params.orgId, 'editor');
  if (!access) return;
  const { value, description } = req.body ?? {};
  try {
    const secret = setOrgSecret(access.orgId, req.params.name, value, {
      description: typeof description === 'string' && description.trim() ? description.trim() : null,
      createdBy: req.user.id,
    });
    recordAuthEvent({
      type: 'secret.saved', actorUserId: req.user.id, orgId: access.orgId,
      meta: { name: secret.name },
    });
    res.json({ secret });
  } catch (err) {
    if (err instanceof SecretError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/** DELETE /api/orgs/:orgId/secrets/:name — editor+. 204, or 404 if absent. */
router.delete('/api/orgs/:orgId/secrets/:name', async (req, res) => {
  const access = await requireOrgRole(req, res, req.params.orgId, 'editor');
  if (!access) return;
  if (!deleteOrgSecret(access.orgId, req.params.name)) {
    res.status(404).json({ error: 'secret not found' });
    return;
  }
  recordAuthEvent({
    type: 'secret.deleted', actorUserId: req.user.id, orgId: access.orgId,
    meta: { name: req.params.name },
  });
  res.status(204).end();
});

export default router;
