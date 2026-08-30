/**
 * Kuhn margin-comment tools (STH-1): add_comment, and the generated variants
 * of the broad `manage_comments` grant (list_comments, reply_comment,
 * resolve_comment). Extracted from the Claude SDK construction in
 * runtime.js — provider-neutral; threads live in the project-scoped comment
 * store (db/comments.js).
 *
 * Issue #58: the read-and-act half of the comment loop. add_comment can
 * file feedback, but agents could not see existing threads (from users,
 * external reviewers, or other agents), answer them, or close them out.
 * Resolution stamps the task's user (agents act on the user's behalf);
 * in-thread attribution comes from the agent-authored reply.
 */

import { readProjectFile } from '../../storage.js';
import { addReply, createThread, listThreads, resolveQuote, setResolved } from '../../db/comments.js';
import { toolOk, toolError } from './envelope.js';

const author = (c) => {
  if (c.agent) return `${c.agent} (agent)`;
  if (c.userName) return c.userName;
  if (c.reviewerName) return `${c.reviewerName} (external reviewer)`;
  return 'unknown';
};

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createCommentTools(ctx) {
  const { projectId, userId } = ctx;
  const { slug: agentSlug } = ctx.agent;
  const { id: jobId } = ctx.parentJob;

  const tools = [];

  tools.push({
    name: 'add_comment',
    grants: ['add_comment'],
    readOnly: false,
    effect: 'write',
    description:
      'File a margin comment on a passage of a project document. Quote the exact target text and the comment appears anchored to that passage in the editor, '
      + 'where the user and collaborators read, reply to, and resolve it. Use this for feedback on specific text instead of writing critique into chat or separate report files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path of the document' },
        quote: {
          type: 'string',
          minLength: 1,
          description: 'The target text, copied VERBATIM from the current file content — a short excerpt (one clause to a few sentences) that pins down the passage',
        },
        body: { type: 'string', minLength: 1, description: 'The comment: the issue, why it matters, and what needs to change' },
      },
      required: ['path', 'quote', 'body'],
    },
    execute: async (_id, { path, quote, body }) => {
      try {
        // Anchor against the stored bytes — what the user's editor shows.
        // A quote that no longer matches is the agent's error to fix.
        const content = (await readProjectFile(projectId, path)).toString('utf-8');
        const range = resolveQuote(content, quote);
        if (!range) {
          return toolError(
            `add_comment failed: the quote was not found in ${path}. Re-read the file and copy the target text exactly as it appears now.`,
          );
        }
        const thread = createThread(projectId, {
          path,
          body,
          quote: content.slice(range.start, range.end),
          start: range.start,
          end: range.end,
          userId,
          agentSlug,
          jobId,
        });
        ctx.channel.push({
          type: 'comment', action: 'create', agent: agentSlug,
          path, id: thread.id, rootId: thread.id,
        });
        return toolOk(`Comment filed on ${path} (comment ${thread.id}).`);
      } catch (err) {
        return toolError(`add_comment failed: ${err.message}`);
      }
    },
  });

  tools.push({
    name: 'list_comments',
    grants: ['manage_comments'],
    readOnly: true,
    effect: 'read',
    description:
      'List margin-comment threads on a document (or the whole project): who wrote each comment, the anchored quote, the full thread of replies, and its open/resolved state. '
      + 'Use this before filing comments (avoid duplicates), when asked to address feedback, and to find threads to resolve.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative document path; omit to list threads across the whole project' },
        include_resolved: { type: 'boolean', default: false, description: 'Include threads that are already resolved (default: open threads only)' },
      },
    },
    execute: async (_id, { path, include_resolved }) => {
      try {
        let threads = listThreads(projectId, { path: path ?? null });
        if (!include_resolved) threads = threads.filter((t) => t.resolvedAt == null);
        if (threads.length === 0) {
          const scope = path ? `on ${path}` : 'in this project';
          return toolOk(`No ${include_resolved ? '' : 'open '}comment threads ${scope}.`);
        }
        const text = threads.map((t) => {
          const status = t.resolvedAt ? 'resolved' : 'open';
          const anchor = t.anchor?.quote
            ? `\n  anchored to: "${t.anchor.quote}"${t.orphaned ? ' (orphaned — the quoted text no longer exists)' : ''}`
            : '';
          const replies = t.replies.map((r) => `\n  ↳ ${author(r)}: ${r.body}`).join('');
          return `Comment ${t.id} on ${t.path} [${status}] by ${author(t)}:${anchor}\n  ${t.body}${replies}`;
        }).join('\n\n');
        return toolOk(text);
      } catch (err) {
        return toolError(`list_comments failed: ${err.message}`);
      }
    },
  });

  tools.push({
    name: 'reply_comment',
    grants: ['manage_comments'],
    readOnly: false,
    effect: 'write',
    description:
      'Reply in an existing comment thread. Use it to answer a question asked in a comment, or to explain what you changed in response. '
      + 'The reply appears in the thread in the editor, attributed to you.',
    parameters: {
      type: 'object',
      properties: {
        comment_id: { type: 'integer', description: 'Thread id (the root comment id from list_comments)' },
        body: { type: 'string', minLength: 1, description: 'The reply text' },
      },
      required: ['comment_id', 'body'],
    },
    execute: async (_id, { comment_id, body }) => {
      try {
        const reply = addReply(projectId, comment_id, {
          body, userId, agentSlug, jobId,
        });
        ctx.channel.push({
          type: 'comment', action: 'reply', agent: agentSlug,
          path: reply.path, id: reply.id, rootId: comment_id,
        });
        return toolOk(`Reply added to comment ${comment_id} on ${reply.path}.`);
      } catch (err) {
        return toolError(`reply_comment failed: ${err.message}`);
      }
    },
  });

  tools.push({
    name: 'resolve_comment',
    grants: ['manage_comments'],
    readOnly: false,
    effect: 'write',
    description:
      'Resolve a comment thread after its concern has been fully addressed. Pass a note saying what was done — it is filed as your reply in the thread before resolving, '
      + 'so the resolution is traceable. Only resolve threads you (or the change you just made) actually addressed; leave open questions for the user.',
    parameters: {
      type: 'object',
      properties: {
        comment_id: { type: 'integer', description: 'Thread id (the root comment id from list_comments)' },
        note: { type: 'string', description: 'What was changed or why the comment is settled — filed as a closing reply in the thread' },
      },
      required: ['comment_id'],
    },
    execute: async (_id, { comment_id, note }) => {
      try {
        if (note && note.trim().length > 0) {
          const reply = addReply(projectId, comment_id, {
            body: note.trim(), userId, agentSlug, jobId,
          });
          ctx.channel.push({
            type: 'comment', action: 'reply', agent: agentSlug,
            path: reply.path, id: reply.id, rootId: comment_id,
          });
        }
        const thread = setResolved(projectId, comment_id, true, { userId });
        ctx.channel.push({
          type: 'comment', action: 'resolve', agent: agentSlug,
          path: thread.path, id: comment_id, rootId: comment_id,
        });
        return toolOk(`Resolved comment ${comment_id} on ${thread.path}.`);
      } catch (err) {
        return toolError(`resolve_comment failed: ${err.message}`);
      }
    },
  });

  return tools;
}
