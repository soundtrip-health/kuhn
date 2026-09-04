/**
 * Reproducible result record (STH-5 / STH-31).
 *
 * One record per suite run — conformance scenarios or quality-baseline cases.
 * A record is self-describing enough that two runs (e.g. the pre-migration
 * Claude baseline and the post-migration Pi run) can be diffed objectively:
 * same git SHA, same fixture hash, same configuration, same suite version
 * means the only variables are the runtime and the model.
 *
 * The record never contains credentials, and it never embeds raw provider
 * message objects: only the normalized, Kuhn-owned facts (events, objective
 * check results, usage, latency).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const RESULT_FORMAT_VERSION = '1.0.0';

/** HEAD of the current checkout; null when running outside a git worktree. */
export function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function branchName() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function sha256Of(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/**
 * @param {object} p
 * @param {string} p.suite - 'conformance' | 'quality-baseline'
 * @param {string} p.runtime - provider/runtime identity under test, e.g.
 *   'claude-sdk', 'pi' (the quality runner records the concrete model ids).
 * @param {string} [p.provider]
 * @param {string|object} [p.model] - single model id or per-role map.
 * @param {{ version: string, hash: string }} p.fixtures - corpus/scenario
 *   version plus a hash over the canonical JSON of every fixture used.
 * @param {object} p.config - the configuration that shaped the run.
 * @param {Array<object>} p.entries - one row per scenario/case:
 *   { id, ok, violations: string[], objective: object|null, rubric: object|null,
 *     usage: object|null, latencyMs: number|null }
 * @param {object} [p.extra]
 */
export function createResultRecord({ suite, runtime, provider = null, model = null, fixtures, config, entries, extra = {} }) {
  const passed = entries.filter((e) => e.ok).length;
  const record = {
    format: RESULT_FORMAT_VERSION,
    suite,
    runtime,
    provider,
    model,
    git: { sha: gitSha(), branch: branchName() },
    fixtures,
    config,
    startedAt: new Date().toISOString(),
    entries,
    summary: {
      total: entries.length,
      passed,
      failed: entries.length - passed,
      violations: entries.flatMap((e) => e.violations ?? []),
    },
    ...extra,
  };
  return record;
}

/** Stable serialization for hashes and files: sorted keys, 2-space indent. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}
