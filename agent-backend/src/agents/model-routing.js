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
 * Resolve the profile a task runs on.
 * @param {object} args
 * @param {number|null} args.orgId - the project's org (null → deployment default)
 * @param {{ slug: string, model?: string|null }} args.agent - the agent row
 * @param {number} [args.difficulty] - task difficulty (0..1), default 1
 * @returns {{ profile: object, source: 'org'|'platform'|'deployment', difficulty: number,
 *   routes: Array<{ profile_slug, difficulty }> }}
 */
export function resolveRoute({ orgId, agent, difficulty }) {
  const d = normalizeDifficulty(difficulty);
  let routes = orgId != null ? getRoutes(orgId, agent.slug) : [];
  let source = 'org';
  if (routes.length === 0) {
    // Operator-declared default for this role (issue #138); an org's own
    // route list, when it has one, replaces it entirely.
    routes = platformDefaultRoutes(agent.slug);
    source = 'platform';
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
