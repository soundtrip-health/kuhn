// Model profiles and per-role routing HTTP surface (issues #107, #111, #112).
// Owner-only throughout: profiles carry credential REFERENCES (org secret
// names) and endpoint identity, and routing decides where an org's content
// egresses. Deployment-managed profiles are listed read-only. Writes are
// audited (auth_events) with slugs only — never a credential.

import { Router } from 'express';

import { listAgentsWithTools } from '../db/agents.js';
import { recordAuthEvent } from '../db/auth-events.js';
import {
  PROVIDERS,
  ProfileValidationError,
  createProfile,
  lookupCapabilities,
  deleteProfile,
  deploymentDefaultProfile,
  platformDefaultRoutes,
  getProfile,
  listProfiles,
  listRoutes,
  setRoutes,
  updateProfile,
} from '../db/model-profiles.js';
import { probeProfile } from '../agents/model-probe.js';
import { requirementFailure } from '../agents/model-routing.js';
import { requireOrgRole } from './guards.js';

const router = Router();

function sendValidation(res, err) {
  if (err instanceof ProfileValidationError) {
    res.status(400).json({ error: err.message, field: err.field });
    return true;
  }
  return false;
}

/** The hostname content egresses to for a profile (for the owner's boundary warning). */
function egressHost(profile) {
  try {
    return profile?.endpoint ? new URL(profile.endpoint).host : null;
  } catch {
    return null;
  }
}

/**
 * Advisory findings for a role's route list: capabilities the role's tools
 * need that a non-Anthropic profile cannot supply (the provider-hosted web
 * search), and invalid profiles. Rejections are the store's job; these
 * are surfaced so the owner understands the degradation.
 */
function routeWarnings(orgId, agent, routes) {
  const warnings = [];
  for (const route of routes) {
    const profile = getProfile(orgId, route.profile_slug);
    if (!profile) continue;
    const failure = requirementFailure(profile);
    if (failure) warnings.push({ profile_slug: profile.slug, message: failure });
    if (agent?.tools?.includes('web_search') && profile.provider !== 'anthropic') {
      warnings.push({
        profile_slug: profile.slug,
        message: `${agent.slug} holds web_search, which only the Anthropic provider supplies; on '${profile.slug}' the agent runs without general web search (literature search still works).`,
      });
    }
  }
  return warnings;
}

/**
 * The route list a role follows when the org has configured none: the
 * platform default (issue #138) when the operator declared one, else the
 * seeded deployment profile as a single hardest-difficulty entry.
 */
function defaultRoutesFor(agent) {
  const platform = platformDefaultRoutes(agent.slug);
  return platform.length ? platform : [{ profile_slug: deploymentDefaultProfile(agent).slug, difficulty: 1 }];
}

/** GET /api/orgs/:orgId/model-profiles — deployment-managed + org-owned (owner). */
router.get('/api/orgs/:orgId/model-profiles', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  res.json({ profiles: listProfiles(ctx.orgId) });
});

/**
 * GET /api/orgs/:orgId/model-profiles/catalog?provider=&model_id= — what the
 * built-in provider catalog knows about a model (owner) — or, for an id the
 * pinned catalog lacks, OpenRouter's live keyless model list (source
 * 'openrouter-live'): capabilities, a display name, and a suggested cost
 * weight; { known: false } otherwise.
 */
router.get('/api/orgs/:orgId/model-profiles/catalog', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const provider = String(req.query.provider ?? '');
  const modelId = String(req.query.model_id ?? '').trim();
  if (!PROVIDERS.includes(provider)) {
    res.status(400).json({ error: `provider must be one of: ${PROVIDERS.join(', ')}`, field: 'provider' });
    return;
  }
  res.json(await lookupCapabilities(provider, modelId));
});

/** POST /api/orgs/:orgId/model-profiles — create an org profile (owner). 201 { profile }. */
router.post('/api/orgs/:orgId/model-profiles', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  try {
    const profile = createProfile(ctx.orgId, req.body ?? {}, { createdBy: req.user.id });
    recordAuthEvent({
      type: 'model_profile.saved', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { slug: profile.slug, provider: profile.provider, model: profile.model_id, endpoint: profile.endpoint },
    });
    res.status(201).json({ profile });
  } catch (err) {
    if (!sendValidation(res, err)) throw err;
  }
});

/** PATCH /api/orgs/:orgId/model-profiles/:slug — update an org profile (owner). 404 for deployment/unknown. */
router.patch('/api/orgs/:orgId/model-profiles/:slug', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  try {
    const profile = updateProfile(ctx.orgId, req.params.slug, req.body ?? {});
    if (!profile) {
      res.status(404).json({ error: 'profile not found or not editable' });
      return;
    }
    recordAuthEvent({
      type: 'model_profile.saved', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { slug: profile.slug, provider: profile.provider, model: profile.model_id, endpoint: profile.endpoint },
    });
    res.json({ profile });
  } catch (err) {
    if (!sendValidation(res, err)) throw err;
  }
});

/** DELETE /api/orgs/:orgId/model-profiles/:slug — remove an org profile and its routes (owner). */
router.delete('/api/orgs/:orgId/model-profiles/:slug', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  if (!deleteProfile(ctx.orgId, req.params.slug)) {
    res.status(404).json({ error: 'profile not found or not editable' });
    return;
  }
  recordAuthEvent({
    type: 'model_profile.deleted', actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { slug: req.params.slug },
  });
  res.status(204).end();
});

/**
 * POST /api/orgs/:orgId/model-profiles/:slug/test — one synthetic turn through
 * the profile (owner). Sends no project content; returns identity, latency,
 * usage, and a scrubbed error — never the credential.
 */
router.post('/api/orgs/:orgId/model-profiles/:slug/test', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const profile = getProfile(ctx.orgId, req.params.slug);
  if (!profile) {
    res.status(404).json({ error: 'profile not found' });
    return;
  }
  const result = await probeProfile(ctx.orgId, profile);
  recordAuthEvent({
    type: 'model_profile.tested', actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { slug: profile.slug, ok: result.ok, error: result.error?.code ?? null },
  });
  res.json({ result });
});

/**
 * GET /api/orgs/:orgId/model-routes — every agent with its deployment
 * default, current route list, and advisory warnings (owner).
 */
router.get('/api/orgs/:orgId/model-routes', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const agents = await listAgentsWithTools();
  const routes = listRoutes(ctx.orgId);
  res.json({
    agents: agents.map((agent) => {
      const list = routes[agent.slug] ?? [];
      const defaults = defaultRoutesFor(agent);
      return {
        slug: agent.slug,
        name: agent.name,
        tools: agent.tools,
        // What a hardest task runs on with no org route: the strongest
        // platform default (issue #138) or the seeded deployment model.
        default_profile: defaults[defaults.length - 1].profile_slug,
        // The full default list — several platform models by difficulty, or
        // the single deployment profile — so the UI can show it.
        default_routes: defaults,
        routes: list,
        warnings: routeWarnings(ctx.orgId, agent, list),
      };
    }),
  });
});

/**
 * PUT /api/orgs/:orgId/model-routes/:agentSlug — body { routes: [{ profile_slug,
 * difficulty }] } replaces the role's ranked list; [] reverts to the
 * deployment default (owner). Returns the stored list, warnings, and the
 * egress hosts before/after so the UI can flag a changed data boundary.
 */
router.put('/api/orgs/:orgId/model-routes/:agentSlug', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const { agentSlug } = req.params;
  const agents = await listAgentsWithTools();
  const agent = agents.find((a) => a.slug === agentSlug);
  if (!agent) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  const hostsOf = (list) => [...new Set(
    (list.length ? list : defaultRoutesFor(agent)).map((r) => getProfile(ctx.orgId, r.profile_slug))
      .map(egressHost).filter(Boolean),
  )];
  const before = hostsOf(listRoutes(ctx.orgId)[agentSlug] ?? []);
  try {
    const routes = setRoutes(ctx.orgId, agentSlug, req.body?.routes, { updatedBy: req.user.id });
    if (!routes) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    const after = hostsOf(routes);
    recordAuthEvent({
      type: 'model_route.saved', actorUserId: req.user.id, orgId: ctx.orgId,
      meta: { agent: agentSlug, routes: routes.map((r) => `${r.profile_slug}@${r.difficulty}`), egress: after },
    });
    res.json({
      routes,
      warnings: routeWarnings(ctx.orgId, agent, routes),
      egress: { before, after, added: after.filter((h) => !before.includes(h)) },
    });
  } catch (err) {
    if (!sendValidation(res, err)) throw err;
  }
});

export default router;
