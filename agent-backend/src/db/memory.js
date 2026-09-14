/**
 * Shared project memory store (issue #150, docs/specs/150-project-memory.md).
 *
 * The distilled, addressable layer every agent on a project reads and
 * writes directly — so what one run learned or did reaches the next run of
 * any agent without the PM relaying it. Entries are short markdown bodies
 * with a kind (fact / decision / task_state / issue / note), optional stable
 * key, tags and provenance (agent, user, job).
 *
 * Invariants this module owns:
 *   - rows are immutable: a keyed write inserts a new row and retires the
 *     previous live row for that key (retired_by 'supersede', supersedes_id
 *     back-link); retiring is the only mutation, so an audit reads as a chain;
 *   - a live entry written by a human (source_agent NULL — an ask_user answer
 *     recorded by the runtime, a UI write) cannot be superseded or retired by
 *     an agent write: the tool tells the agent to raise it with the user;
 *   - bounds: 2 KB bodies, 8 tags, a per-project live cap above which the
 *     oldest runtime-written (`auto`) entries are retired first, then the
 *     oldest keyless note / task_state entries; decisions, issues and keyed
 *     model-written entries survive;
 *   - recall never crosses projects: every query is project-scoped by the
 *     caller's server-derived project id (no tenant parameter anywhere).
 *
 * Every write logs `memory_write`; every ranked recall logs `memory_recall`
 * (query terms, hit count, hit ids) so the embeddings decision (spec §6) has
 * data from day one.
 */

import { querySync, transaction } from '../db.js';
import { log } from '../logger.js';
import { STOPWORDS, sanitizeFtsTerms, stemTerm } from './fts-terms.js';

export const MEMORY_KINDS = ['fact', 'decision', 'task_state', 'issue', 'note'];

export const MEMORY_LIMITS = {
  body: 2048,
  tags: 8,
  tag: 40,
  key: 120,
  /** live entries per project before the cap retires the oldest disposable ones */
  cap: Math.max(50, parseInt(process.env.KUHN_MEMORY_CAP || '2000') || 2000),
  /** terms taken from a free-text query */
  queryTerms: 12,
};

/** Task text is prose: a larger stopword set than a search box needs. */
const MEMORY_STOPWORDS = new Set([
  ...STOPWORDS,
  ...('please then also into about after before have has had was were will would should could their '
    + 'there these those them they we our us me any all some each more most than so if no yes now just '
    + 'make sure use using used need needs one two first next last new old up out over under').split(' '),
]);

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,119}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export class MemoryError extends Error {
  /**
   * @param {'invalid_kind'|'body_required'|'body_too_long'|'invalid_tags'|'invalid_key'|'protected'|'not_found'} code
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseRow(row) {
  if (!row) return null;
  let tags = [];
  try {
    tags = JSON.parse(row.tags ?? '[]');
  } catch {
    tags = [];
  }
  return { ...row, tags: Array.isArray(tags) ? tags : [], auto: row.auto === 1 };
}

function normalizeTags(tags) {
  if (tags == null) return [];
  if (!Array.isArray(tags)) throw new MemoryError('invalid_tags', 'tags must be an array of short strings');
  const out = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') throw new MemoryError('invalid_tags', 'tags must be an array of short strings');
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > MEMORY_LIMITS.tag) {
      throw new MemoryError('invalid_tags', `a tag is longer than ${MEMORY_LIMITS.tag} characters`);
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MEMORY_LIMITS.tags) {
    throw new MemoryError('invalid_tags', `at most ${MEMORY_LIMITS.tags} tags per entry`);
  }
  return out;
}

/** Cut a body at the limit on a line boundary where one is near, marking the cut. */
export function clipBody(body, max = MEMORY_LIMITS.body) {
  const text = String(body ?? '');
  if (text.length <= max) return text;
  const marker = '\n[… truncated]';
  const room = max - marker.length;
  const nl = text.lastIndexOf('\n', room);
  return text.slice(0, nl > room * 0.6 ? nl : room) + marker;
}

/** The live row under a key, or null. */
export function getLiveByKey(projectId, key) {
  const { rows } = querySync(
    'SELECT * FROM project_memory WHERE project_id = $1 AND key = $2 AND retired_at IS NULL',
    [projectId, key],
  );
  return parseRow(rows[0]);
}

/** One entry by id (any state), project-scoped, or null. */
export function getMemory(projectId, id) {
  const { rows } = querySync('SELECT * FROM project_memory WHERE project_id = $1 AND id = $2', [projectId, id]);
  return parseRow(rows[0]);
}

export function countLive(projectId) {
  return querySync(
    'SELECT COUNT(*) AS n FROM project_memory WHERE project_id = $1 AND retired_at IS NULL',
    [projectId],
  ).rows[0].n;
}

/**
 * Write an entry. A keyed write supersedes the live entry under that key.
 *
 * @param {number|string} projectId
 * @param {object} entry
 * @param {string} entry.kind - one of MEMORY_KINDS
 * @param {string} entry.body - markdown, <= MEMORY_LIMITS.body unless `truncate`
 * @param {string|null} [entry.key] - stable slug ([A-Za-z0-9:_./-], <= 120 chars)
 * @param {string[]} [entry.tags]
 * @param {string|null} [entry.sourceAgent] - agent slug; NULL marks a human write (protected)
 * @param {number|null} [entry.userId] - the acting user (attribution)
 * @param {number|null} [entry.jobId] - provenance
 * @param {boolean} [entry.auto] - written by the runtime (retired first at the cap)
 * @param {boolean} [entry.truncate] - clip an over-long body instead of refusing it
 * @returns {{ entry: object, superseded: number|null, capRetired: number }}
 * @throws {MemoryError}
 */
export function remember(projectId, {
  kind, body, key = null, tags = [], sourceAgent = null, userId = null, jobId = null, auto = false, truncate = false,
}) {
  if (!MEMORY_KINDS.includes(kind)) {
    throw new MemoryError('invalid_kind', `kind must be one of ${MEMORY_KINDS.join(', ')}`);
  }
  let text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw new MemoryError('body_required', 'body is required');
  if (text.length > MEMORY_LIMITS.body) {
    if (!truncate) {
      throw new MemoryError('body_too_long',
        `body is ${text.length} characters; the limit is ${MEMORY_LIMITS.body}. Keep memory short and point at a file for the detail.`);
    }
    text = clipBody(text);
  }
  const cleanTags = normalizeTags(tags);
  let cleanKey = null;
  if (key != null && key !== '') {
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      throw new MemoryError('invalid_key', 'key must be a short slug: letters, digits, and : _ . / - (max 120 characters)');
    }
    cleanKey = key;
  }

  const result = transaction(() => {
    const live = cleanKey ? getLiveByKey(projectId, cleanKey) : null;
    if (live && live.source_agent == null && sourceAgent != null) {
      throw new MemoryError('protected',
        `Memory #${live.id} (key ${cleanKey}) was written by the user and cannot be overwritten by an agent. `
        + 'If you believe it is wrong or outdated, say so: ask the user (ask_user) where you have it, or record '
        + 'an `issue` entry that names #' + live.id + ' and explains the disagreement.');
    }
    if (live) {
      // Retire first: the partial unique index allows one live row per key.
      // The reason names the successor once it exists (below).
      querySync(
        `UPDATE project_memory SET retired_at = ${NOW}, retired_by = 'supersede' WHERE id = $1 AND retired_at IS NULL`,
        [live.id],
      );
    }
    const { rows } = querySync(
      `INSERT INTO project_memory (project_id, kind, key, body, tags, source_agent, user_id, job_id, auto, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [projectId, kind, cleanKey, text, JSON.stringify(cleanTags), sourceAgent, userId, jobId, auto ? 1 : 0, live?.id ?? null],
    );
    const inserted = parseRow(rows[0]);
    if (live) {
      querySync('UPDATE project_memory SET retire_reason = $1 WHERE id = $2', [`superseded by #${inserted.id}`, live.id]);
    }
    const capRetired = enforceCap(projectId);
    return { entry: inserted, superseded: live?.id ?? null, capRetired };
  });
  log.info('memory_write', {
    projectId: Number(projectId), id: result.entry.id, kind, key: cleanKey, agent: sourceAgent, userId, jobId,
    auto, chars: text.length, superseded: result.superseded, capRetired: result.capRetired,
  });
  return result;
}

/**
 * Retire an entry (soft delete; provenance kept). An agent cannot retire a
 * human-written entry.
 * @param {number|string} projectId
 * @param {number} id
 * @param {{ reason?: string, agent?: string|null, userId?: number|null }} by
 * @returns {object} the retired entry
 * @throws {MemoryError}
 */
export function forget(projectId, id, { reason = null, agent = null, userId = null } = {}) {
  const row = getMemory(projectId, id);
  if (!row || row.retired_at) throw new MemoryError('not_found', `No live memory entry #${id} in this project.`);
  if (row.source_agent == null && agent != null) {
    throw new MemoryError('protected',
      `Memory #${row.id} was written by the user and cannot be retired by an agent. If you believe it is wrong or `
      + 'outdated, say so: ask the user (ask_user) where you have it, or record an `issue` entry that names #'
      + row.id + ' and explains why.');
  }
  const retiredBy = agent ?? (userId != null ? `user:${userId}` : 'user');
  const { rows } = querySync(
    `UPDATE project_memory SET retired_at = ${NOW}, retired_by = $1, retire_reason = $2
     WHERE id = $3 AND project_id = $4 AND retired_at IS NULL
     RETURNING *`,
    [retiredBy, reason ? String(reason).slice(0, 500) : null, id, projectId],
  );
  log.info('memory_write', {
    projectId: Number(projectId), id, kind: row.kind, key: row.key, agent, userId, retired: true, reason,
  });
  return parseRow(rows[0]);
}

/**
 * Above the cap, retire the oldest disposable live entries: runtime-written
 * (`auto`) rows first, then keyless note / task_state rows. Decisions,
 * issues and keyed model-written entries are never retired by the cap.
 * @returns {number} rows retired
 */
export function enforceCap(projectId, cap = MEMORY_LIMITS.cap) {
  let excess = countLive(projectId) - cap;
  if (excess <= 0) return 0;
  let retired = 0;
  const tiers = [
    'auto = 1',
    "auto = 0 AND key IS NULL AND kind IN ('note', 'task_state')",
  ];
  for (const tier of tiers) {
    if (excess <= 0) break;
    const { rowCount } = querySync(
      `UPDATE project_memory SET retired_at = ${NOW}, retired_by = 'cap', retire_reason = 'project memory cap'
       WHERE id IN (
         SELECT id FROM project_memory
         WHERE project_id = $1 AND retired_at IS NULL AND ${tier}
         ORDER BY created_at ASC, id ASC LIMIT $2
       )`,
      [projectId, excess],
    );
    retired += rowCount;
    excess -= rowCount;
  }
  if (retired > 0) log.info('memory_cap', { projectId: Number(projectId), cap, retired });
  return retired;
}

/**
 * Ranked or most-recent entries of a project.
 *
 * With `query`: BM25 over body / tags / key (every term first, then any term
 * re-ranked by how many terms an entry covers — the guide search's lesson
 * about stray rare words), ties by recency. Without: newest first.
 *
 * @param {number|string} projectId
 * @param {object} [opts]
 * @param {string|null} [opts.query]
 * @param {string|string[]|null} [opts.kind]
 * @param {string[]|null} [opts.tags] - every listed tag must be present
 * @param {number} [opts.limit] - 1..50 (default 10)
 * @param {string|null} [opts.since] - only entries created after this ISO timestamp
 * @param {boolean|'all'} [opts.retired] - false: live only (default); true: retired only; 'all'
 * @param {number[]} [opts.exclude] - ids to leave out
 * @param {{ source?: string, agent?: string|null, jobId?: number|null }} [meta]
 *   - who is asking, for the `memory_recall` log (logged only for ranked queries)
 * @returns {object[]} entries (each with `tags` parsed and, for ranked hits, `rank`)
 */
export function recall(projectId, {
  query = null, kind = null, tags = null, limit = 10, since = null, retired = false, exclude = [],
} = {}, meta = {}) {
  const cap = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
  const where = ['m.project_id = $1'];
  const params = [projectId];
  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (retired === false) where.push('m.retired_at IS NULL');
  else if (retired === true) where.push('m.retired_at IS NOT NULL');
  const kinds = kind == null ? [] : (Array.isArray(kind) ? kind : [kind]).filter((k) => MEMORY_KINDS.includes(k));
  if (kinds.length) {
    const slots = kinds.map((k) => { params.push(k); return `$${params.length}`; });
    where.push(`m.kind IN (${slots.join(', ')})`);
  }
  if (since) add('m.created_at > ?', since);
  for (const tag of normalizeTags(tags)) {
    add('EXISTS (SELECT 1 FROM json_each(m.tags) WHERE json_each.value = ?)', tag);
  }
  for (const id of exclude ?? []) add('m.id <> ?', id);
  const filter = where.join(' AND ');

  // Task text and questions are prose: a query of nothing but stopwords is
  // no query at all (recency), not a search for "the".
  const terms = query
    ? sanitizeFtsTerms(query, { max: MEMORY_LIMITS.queryTerms, stopwords: MEMORY_STOPWORDS, keepStopwords: false })
    : [];
  if (terms.length === 0) {
    const { rows } = querySync(
      `SELECT m.* FROM project_memory m WHERE ${filter} ORDER BY m.created_at DESC, m.id DESC LIMIT ${cap}`,
      params,
    );
    return rows.map(parseRow);
  }

  const ranked = (match, n) => {
    const { rows } = querySync(
      `SELECT m.*, bm25(project_memory_fts, 1.0, 2.0, 3.0) AS rank
       FROM project_memory_fts
       JOIN project_memory m ON m.id = project_memory_fts.rowid
       WHERE project_memory_fts MATCH $${params.length + 1} AND ${filter}
       ORDER BY rank, m.created_at DESC
       LIMIT ${n}`,
      [...params, match],
    );
    return rows.map(parseRow);
  };
  let hits = ranked(terms.join(' '), cap);
  if (hits.length < cap && terms.length > 1) {
    const seen = new Set(hits.map((h) => h.id));
    const any = rerank(ranked(terms.join(' OR '), cap * 4), terms).filter((h) => !seen.has(h.id));
    hits = [...hits, ...any].slice(0, cap);
  }
  if (meta.source) {
    log.info('memory_recall', {
      projectId: Number(projectId), source: meta.source, agent: meta.agent ?? null, jobId: meta.jobId ?? null,
      terms: terms.map((t) => t.replace(/"/g, '')), kinds: kinds.length ? kinds : undefined,
      hits: hits.length, ids: hits.map((h) => h.id),
    });
  }
  return hits;
}

/** Sort by covered query terms, then BM25 (lower is better), then recency. */
function rerank(rows, terms) {
  const stems = terms.map(stemTerm);
  const scored = rows.map((r) => {
    const text = `${r.key ?? ''} ${r.tags.join(' ')} ${r.body}`.toLowerCase();
    let score = 0;
    for (const st of stems) if (text.includes(st)) score += 1;
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score || a.r.rank - b.r.rank || (a.r.created_at < b.r.created_at ? 1 : -1));
  return scored.map((x) => x.r);
}
