/**
 * Model routing at dispatch time (issue #107).
 *
 * For a task on role R in org O with difficulty d (0..1), pick the profile
 * the org's ranked route list trusts with d: the cheapest entry whose
 * difficulty covers d, else the strongest entry. With no org route the
 * platform default route applies when the operator declared one for the
 * role (KUHN_PLATFORM_MODELS `routes`, issue #138); otherwise the role runs
 * on the deployment default (db/model-profiles.js), which is exactly the
 * pre-#107 behavior.
 *
 * Credentials are resolved here, server-side, at the moment the runtime is
 * built — the resolved value goes straight into the adapter constructor
 * and is never attached to the profile object, the job row, a log line,
 * or an event (threat model §4.3: profiles hold credential references).
 */

import { config } from '../config.js';
import {
  deploymentDefaultProfile,
  getProfile,
  getRoutes,
  platformDefaultRoutes,
} from '../db/model-profiles.js';
import { getOrgSecretValue } from '../db/org-secrets.js';

export const DEFAULT_DIFFICULTY = 1;

/** Clamp a caller-supplied difficulty to [0, 1]; anything unusable is the default (hardest). */
export function normalizeDifficulty(value) {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_DIFFICULTY;
  return Math.min(1, Math.max(0, n));
}

/**
 * The route entry for a difficulty: the first (cheapest) whose ceiling
 * covers it, else the last (strongest). `routes` must be sorted ascending.
 * @param {Array<{ profile_slug: string, difficulty: number }>} routes
 */
export function selectRoute(routes, difficulty) {
  if (!routes?.length) return null;
  return routes.find((r) => r.difficulty >= difficulty) ?? routes[routes.length - 1];
}

/**
 * Why a profile cannot run a Kuhn agent at all, or null when it can. Every
 * role drives Kuhn tools and reads text; a profile declaring otherwise is
 * rejected before a job exists (issue #112: never after partial effects).
 * @returns {string|null}
 */
export function requirementFailure(profile) {
  if (!profile) return 'no model profile resolved';
  if (profile.notAllowed) return `model '${profile.slug}' is not one of the models configured for this agent`;
  if (profile.enabled === false) return `model profile '${profile.slug}' is disabled`;
  const caps = profile.capabilities ?? {};
  if (caps.tools === false) return `model profile '${profile.slug}' declares no tool support; every Kuhn agent needs tools`;
  if (Array.isArray(caps.input) && !caps.input.includes('text')) {
    return `model profile '${profile.slug}' declares no text input`;
  }
  if (profile.credential?.kind === 'secret' && !profile.credential.secret) {
    return `model profile '${profile.slug}' names no credential`;
  }
  return null;
}

/**
 * The route list a role follows and where it came from: the org's own list,
 * else the platform default (issue #138), else the deployment default as a
 * single hardest-difficulty entry.
 * @returns {{ routes: Array<{ profile_slug, difficulty }>, source: 'org'|'platform'|'deployment' }}
 */
export function effectiveRoutes({ orgId, agent }) {
  const org = orgId != null ? getRoutes(orgId, agent.slug) : [];
  if (org.length) return { routes: org, source: 'org' };
  const platform = platformDefaultRoutes(agent.slug);
  if (platform.length) return { routes: platform, source: 'platform' };
  return { routes: [{ profile_slug: deploymentDefaultProfile(agent).slug, difficulty: 1 }], source: 'deployment' };
}

/**
 * The models a user may pick for an agent they address directly (issue
 * #134): exactly the agent's effective route list — the owner's allowlist —
 * with display fields only (never a credential), plus which entry a hardest
 * task takes when nothing is pinned.
 * @returns {{ source: string, default_slug: string, options: Array<object> }}
 */
export function routeOptions({ orgId, agent }) {
  const { routes, source } = effectiveRoutes({ orgId, agent });
  const options = routes.map((r) => {
    const p = getProfile(orgId, r.profile_slug);
    return {
      profile_slug: r.profile_slug,
      difficulty: r.difficulty,
      name: p?.name ?? r.profile_slug,
      provider: p?.provider ?? null,
      model_id: p?.model_id ?? null,
      cost_weight: p?.cost_weight ?? null,
      enabled: p?.enabled ?? false,
      platform: p?.platform === true,
    };
  });
  return { source, default_slug: selectRoute(routes, DEFAULT_DIFFICULTY)?.profile_slug ?? null, options };
}

/**
 * Resolve the profile a task runs on.
 * @param {object} args
 * @param {number|null} args.orgId - the project's org (null → deployment default)
 * @param {{ slug: string, model?: string|null }} args.agent - the agent row
 * @param {number} [args.difficulty] - task difficulty (0..1), default 1
 * @param {string} [args.profile] - a profile slug the user pinned for this
 *   conversation (issue #134). Honoured only when it is on the agent's
 *   effective route list — the owner's allowlist — else the task is refused
 *   (`requirementFailure`), never rerouted silently.
 * @returns {{ profile: object, source: 'org'|'platform'|'deployment'|'user', difficulty: number,
 *   routes: Array<{ profile_slug, difficulty }> }}
 */
export function resolveRoute({ orgId, agent, difficulty, profile: requested = null }) {
  const d = normalizeDifficulty(difficulty);
  let routes = orgId != null ? getRoutes(orgId, agent.slug) : [];
  let source = 'org';
  if (routes.length === 0) {
    // Operator-declared default for this role (issue #138); an org's own
    // route list, when it has one, replaces it entirely.
    routes = platformDefaultRoutes(agent.slug);
    source = 'platform';
  }
  if (typeof requested === 'string' && requested) {
    const allowed = routes.length ? routes : [{ profile_slug: deploymentDefaultProfile(agent).slug, difficulty: 1 }];
    if (!allowed.some((r) => r.profile_slug === requested)) {
      return {
        profile: {
          slug: requested, provider: null, model_id: null, enabled: false, notAllowed: true,
          capabilities: {}, credential: { kind: 'none', secret: null }, endpoint: null,
          cost_weight: config.agent?.modelWeights?.default ?? 5, managed: false,
        },
        source: 'user', difficulty: d, routes,
      };
    }
    const pinned = getProfile(orgId, requested);
    if (pinned) return { profile: pinned, source: 'user', difficulty: d, routes };
    // Allowed by the list but gone from config (a deployment profile that
    // vanished): the same loud failure as a stale route below.
    source = 'user';
    routes = [{ profile_slug: requested, difficulty: 1 }];
  }
  const chosen = selectRoute(routes, d);
  if (chosen) {
    const profile = getProfile(orgId, chosen.profile_slug);
    // A route whose profile vanished (deployment config changed under it)
    // is a configuration error, not a reason to run elsewhere silently.
    if (profile) return { profile, source, difficulty: d, routes };
    return {
      profile: {
        slug: chosen.profile_slug, provider: null, model_id: null, enabled: false,
        capabilities: {}, credential: { kind: 'none', secret: null }, endpoint: null,
        cost_weight: config.agent?.modelWeights?.default ?? 5, managed: false, missing: true,
      },
      source, difficulty: d, routes,
    };
  }
  return { profile: deploymentDefaultProfile(agent), source: 'deployment', difficulty: d, routes };
}

/**
 * The credential the adapter needs for a profile — resolved server-side,
 * returned as an opaque object the factory hands to the adapter and drops.
 * @returns {{ apiKey?: string, apiKeyEnv?: string }}
 * @throws {Error} when an org profile names a secret that no longer exists
 */
export function resolveCredential(orgId, profile) {
  const cred = profile?.credential ?? { kind: 'none' };
  if (cred.kind === 'secret') {
    const value = orgId != null ? getOrgSecretValue(orgId, cred.secret) : null;
    if (!value) {
      throw new Error(`model profile '${profile.slug}': the credential secret '${cred.secret}' is missing — save it again in the organization's secrets`);
    }
    return { apiKey: value };
  }
  if (cred.kind === 'deployment') {
    return cred.env ? { apiKeyEnv: cred.env } : {};
  }
  return {};
}
