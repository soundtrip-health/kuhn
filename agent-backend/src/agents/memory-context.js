/**
 * The "Project memory" section a run's prompt receives (issue #150, spec §6).
 *
 * Recall on demand is not enough — the RA in the #150 incident did not know
 * there was anything to ask about — so every run of an agent with the
 * memory grant starts with a bounded digest of the project's memory,
 * appended to the USER prompt after the task text (never to the system
 * prompt, which stays byte-stable and cacheable):
 *
 *   - the newest live decisions and open issues, and the newest task
 *     outcomes (what anyone did last);
 *   - the entries whose words match the task text (BM25 over the task's
 *     content words);
 *   - headlines only — the first ~200 characters of each body; the full
 *     entry is one `recall` away, and dispatch replies written for the PM
 *     would blow the budget otherwise;
 *   - at most ~3 KB.
 *
 * A run that resumes a provider session gets only the DELTA: entries
 * created since the chat's previous job started (`since`). The full section
 * on every turn of a continued chat would repeat itself into the transcript.
 */

import { recall } from '../db/memory.js';

export const MEMORY_SECTION = {
  decisions: 10,
  tasks: 10,
  matches: 5,
  headline: 200,
  maxChars: 3072,
};

const PREFACE = 'Dated summaries written by agents and the runtime on this project. They tell you what has '
  + 'already been decided and done; the reference store, the files and the transcript are the source of '
  + 'truth, so verify a state claim that matters before acting on it. `recall` returns full entries and '
  + 'more of them; `remember` what the next run of any agent should know.';

/** First ~N characters of a body as one line: headings and list marks stripped, whitespace collapsed. */
export function headline(body, max = MEMORY_SECTION.headline) {
  const text = String(body ?? '')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return `${text.slice(0, cut > max * 0.6 ? cut : max)}…`;
}

/** `- [#12 decision, user, 2026-09-10] headline` — the citable one-liner. */
export function renderEntryLine(entry, max = MEMORY_SECTION.headline) {
  const who = entry.source_agent ?? 'user';
  const date = String(entry.created_at ?? '').slice(0, 10);
  const key = entry.key ? ` ${entry.key}` : '';
  return `- [#${entry.id} ${entry.kind}${key}, ${who}, ${date}] ${headline(entry.body, max)}`;
}

/**
 * Build the section, or null when there is nothing to say.
 *
 * @param {number|string} projectId
 * @param {object} opts
 * @param {string} [opts.taskText] - the run's input; drives the ranked recall
 * @param {string|null} [opts.since] - delta mode: only entries created after this timestamp
 * @param {string} [opts.agent] - for the recall log
 * @param {number} [opts.jobId] - for the recall log
 * @param {object} [limits] - MEMORY_SECTION overrides (tests)
 * @returns {string|null}
 */
export function buildMemorySection(projectId, { taskText = '', since = null, agent = null, jobId = null } = {}, limits = {}) {
  const L = { ...MEMORY_SECTION, ...limits };
  const decisions = recall(projectId, { kind: ['decision', 'issue'], limit: L.decisions, since });
  const tasks = recall(projectId, { kind: 'task_state', limit: L.tasks, since });
  const shown = new Set([...decisions, ...tasks].map((e) => e.id));
  const matches = taskText && L.matches > 0
    ? recall(projectId, { query: taskText, limit: L.matches, since, exclude: [...shown] }, { source: 'inject', agent, jobId })
    : [];
  if (decisions.length + tasks.length + matches.length === 0) return null;

  const groups = [
    { title: 'Decisions and open issues', entries: decisions },
    { title: 'Recent task outcomes', entries: tasks },
    { title: 'Related to this task', entries: matches },
  ];
  const render = () => {
    const parts = ['## Project memory', since ? `${PREFACE}\n\nNew since your previous turn:` : PREFACE];
    for (const g of groups) {
      if (g.entries.length === 0) continue;
      parts.push(`### ${g.title}\n${g.entries.map((e) => renderEntryLine(e, L.headline)).join('\n')}`);
    }
    return parts.join('\n\n');
  };
  // Budget: drop from the least essential group first (matches, then the
  // oldest task outcomes, then the oldest decisions) until the text fits.
  let text = render();
  const order = [groups[2], groups[1], groups[0]];
  while (text.length > L.maxChars) {
    const g = order.find((grp) => grp.entries.length > 0);
    if (!g) break;
    g.entries.pop();
    text = render();
  }
  return text;
}
