/**
 * Project memory tools (issue #150): remember / recall / forget over the
 * shared, project-scoped memory store (db/memory.js). Granted to every
 * agent that works on a project (the `project_memory` grant); the help
 * agent, which has no project, does not get them.
 *
 * `remember` and `forget` are mutations: they go through the run gate like
 * every other tool with product-side effects. `recall` is read-only.
 * Identity (project, user, job, agent) is server-derived from the context —
 * the model names none of it.
 */

import { MEMORY_KINDS, MEMORY_LIMITS, MemoryError, forget, recall, remember } from '../../db/memory.js';
import { toolOk, toolError } from './envelope.js';

const KIND_HELP = 'fact: something true about the project or its materials. decision: a choice and its rationale '
  + '(and who made it). task_state: what a run did and left undone. issue: an open question or concern '
  + '(retire it with forget when resolved). note: anything else.';

/** Full entry as the tool renders it: header line, key, tags, body. */
export function renderEntry(e) {
  const who = e.source_agent ?? 'user';
  const date = String(e.created_at ?? '').slice(0, 16).replace('T', ' ');
  const head = [`#${e.id} [${e.kind}, ${who}, ${date}]`];
  if (e.key) head.push(`key: ${e.key}`);
  if (e.tags?.length) head.push(`tags: ${e.tags.join(', ')}`);
  if (e.retired_at) head.push(`retired ${String(e.retired_at).slice(0, 10)} by ${e.retired_by}`);
  return `${head.join(' · ')}\n${e.body}`;
}

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createMemoryTools(ctx) {
  const { projectId, userId } = ctx;
  const { slug: agentSlug } = ctx.agent;
  const { id: jobId } = ctx.parentJob;
  const fail = (err) => (err instanceof MemoryError ? toolError(err.message) : toolError(`Memory error: ${err.message}`));

  return [
    {
      name: 'remember',
      grants: ['project_memory'],
      readOnly: false,
      effect: 'write',
      description:
        'Write an entry to the shared project memory that every agent on this project reads at the start of '
        + 'every run and can search with recall. Use it for what the next run of any agent must know: a '
        + 'decision and its rationale, a fact about the data or materials, the state a task was left in, an '
        + 'open issue. Keep it short (under 2 KB; point at a file for detail). Give an entry that will be '
        + 'updated later a stable key (e.g. "target-journal", "data-cleaning-status") so the new entry '
        + 'replaces the old one instead of piling up. An entry the user wrote cannot be overwritten: if you '
        + 'disagree with it, ask the user or record an issue that names it.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: MEMORY_KINDS, description: KIND_HELP },
          body: { type: 'string', description: `The entry, in markdown (max ${MEMORY_LIMITS.body} characters)` },
          key: { type: 'string', description: 'Optional stable slug (letters, digits, : _ . / -). A later remember with the same key supersedes this entry.' },
          tags: { type: 'array', items: { type: 'string' }, description: `Optional short tags (max ${MEMORY_LIMITS.tags}), e.g. ["references", "arxiv"]` },
        },
        required: ['kind', 'body'],
      },
      execute: async (_id, { kind, body, key, tags }) => {
        try {
          const { entry, superseded } = remember(projectId, {
            kind, body, key: key ?? null, tags: tags ?? [], sourceAgent: agentSlug, userId, jobId,
          });
          const parts = [`Remembered as memory #${entry.id} (${entry.kind}${entry.key ? `, key ${entry.key}` : ''}).`];
          if (superseded != null) parts.push(`Supersedes #${superseded}.`);
          return toolOk(parts.join(' '));
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      name: 'recall',
      grants: ['project_memory'],
      readOnly: true,
      effect: 'read',
      description:
        'Search the shared project memory: decisions, facts, task outcomes and open issues recorded by any '
        + 'agent or the user on this project. With a query, returns the best keyword matches; without one, '
        + 'the newest entries. Use it before starting work that another run may already have done or decided.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to match (cite keys, file names, section names, topics)' },
          kind: { type: 'string', enum: MEMORY_KINDS, description: 'Restrict to one kind' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Only entries carrying every listed tag' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Maximum entries to return' },
        },
      },
      execute: async (_id, { query, kind, tags, limit }) => {
        try {
          const hits = recall(projectId, { query: query ?? null, kind: kind ?? null, tags: tags ?? null, limit: limit ?? 10 },
            { source: 'tool', agent: agentSlug, jobId });
          if (hits.length === 0) {
            return toolOk(query ? `No memory entries match "${query}".` : 'The project memory is empty.');
          }
          return toolOk(hits.map(renderEntry).join('\n\n'));
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      name: 'forget',
      grants: ['project_memory'],
      readOnly: false,
      effect: 'write',
      description:
        'Retire a project memory entry that is wrong, obsolete or resolved (an issue that has been settled). '
        + 'The entry stays in the audit trail but no longer reaches any agent. Entries the user wrote cannot '
        + 'be retired by an agent.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The entry id (the #number shown in memory listings)' },
          reason: { type: 'string', description: 'Why it is being retired' },
        },
        required: ['id', 'reason'],
      },
      execute: async (_id, { id, reason }) => {
        try {
          const entry = forget(projectId, id, { reason, agent: agentSlug, userId });
          return toolOk(`Retired memory #${entry.id} (${entry.kind}${entry.key ? `, key ${entry.key}` : ''}).`);
        } catch (err) {
          return fail(err);
        }
      },
    },
  ];
}
