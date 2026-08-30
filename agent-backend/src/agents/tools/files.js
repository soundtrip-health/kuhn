/**
 * Kuhn file tools (STH-1): read_file, search_files, list_files, move_file,
 * write_file, edit_file. Extracted from the Claude SDK construction in
 * runtime.js — provider-neutral: the executors use only Kuhn's storage
 * service (which enforces the project root) and the pending-edit gate.
 *
 * Grants (DB slugs): file_read → read_file + search_files; file_list →
 * list_files; file_move → move_file; file_write → write_file + edit_file.
 */

import {
  readProjectFile,
  writeProjectFile,
  listProjectTree,
  searchProjectFiles,
  moveProjectEntry,
} from '../../storage.js';
import { findPendingEditConflicts } from '../../db/move-paths.js';
import { isProposable, proposeEdit, effectiveContent, pendingProposalContent } from '../../pending-edits.js';
import { isDerivedBibPath } from '../../citations.js';
import { publishProjectEvent } from '../../project-events.js';
import { toolOk, toolError } from './envelope.js';

/**
 * Live + persisted signal for a write_file/edit_file outcome (STH-44). Direct
 * publish + channel mirror — the move_file / run_script pattern: the hub's
 * WeakSet dedupe keeps the feed to one envelope, and sub-agent runs (depth
 * > 0, untee'd) persist activity too. 'proposed' is SSE-only by design
 * (no file_events row, no eviction — nothing on disk changed); the hub
 * already treats it that way.
 */
function emitFileChange(ctx, { path, kind }) {
  const event = { type: 'file_change', agent: ctx.agent.slug, path, kind };
  try {
    publishProjectEvent(ctx.projectId, event, { jobId: ctx.parentJob.id, userId: ctx.userId });
  } catch { /* activity loss must not fail the write */ }
  ctx.channel.push(event);
}

// Refuse direct writes to a materialized bibliography (issue #42): the file is
// derived from the reference store, so a hand edit is clobbered on the next
// regeneration — and under suggestion mode it would sit as an invisible
// pending edit. Steer to the deterministic reference tools instead.
async function rejectDerivedBibWrite(projectId, path) {
  if (await isDerivedBibPath(projectId, path)) {
    throw new Error(
      `${path} is generated from the project reference store; direct edits are overwritten the next time the bibliography is regenerated. `
      + 'Use add_citation (PubMed works) or add_reference (everything else) to add entries, and '
      + 'update_reference / remove_reference to correct or delete existing ones. If you lack those '
      + 'tools, dispatch the ra agent or tell the user exactly what needs to change.',
    );
  }
}

// The suggestion-mode success message (issue #42): agents treated the old
// "awaiting user review" phrasing as a failed/blocked write and thrashed —
// retrying, rewriting whole files, or declaring the tool broken. Say outright
// that the write succeeded and is complete.
function proposedResult(path) {
  return `Successfully proposed update to ${path}. The write is COMPLETE — do not retry or rewrite. `
    + 'It is recorded as a pending suggestion the user reviews in the editor; the file on disk changes only when they accept. '
    + 'Reading the file back will show your proposed version.';
}

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createFileTools(ctx) {
  const { projectId, seeding } = ctx;

  const tools = [];

  // File tools (story 018): all project file access goes through the storage
  // service, which enforces the project root. Paths are workspace-relative.
  tools.push({
    name: 'read_file',
    grants: ['file_read'],
    readOnly: true,
    effect: 'read',
    description: 'Read a file from the project workspace. Path is relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path' } },
      required: ['path'],
    },
    execute: async (_id, { path }) => {
      try {
        // Suggestion-mode coherence (issue #42): if this path has a pending
        // proposal, show the proposed content — otherwise an agent that wrote
        // and reads back to verify sees stale disk bytes and concludes its
        // write was lost.
        if (!seeding) {
          const proposal = pendingProposalContent(projectId, path);
          if (proposal != null) {
            return toolOk(
              `[${path} has a pending proposed update awaiting user review. The content below is the PROPOSED version; the file on disk keeps its previous content until the user accepts.]\n\n${proposal}`,
            );
          }
        }
        const buf = await readProjectFile(projectId, path);
        return toolOk(buf.toString('utf-8'));
      } catch (err) {
        return toolError(err.message);
      }
    },
  });

  tools.push({
    name: 'search_files',
    grants: ['file_read'],
    readOnly: true,
    effect: 'read',
    description: 'Search project files for a regular expression. Returns matching lines as path:line: text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression to search for' },
        path: { type: 'string', default: '.', description: 'Workspace-relative directory to search in' },
      },
      required: ['pattern'],
    },
    execute: async (_id, { pattern, path }) => {
      try {
        const matches = await searchProjectFiles(projectId, pattern, path);
        if (matches.length === 0) return toolOk('No matches.');
        return toolOk(matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n'));
      } catch (err) {
        return toolError(err.message);
      }
    },
  });

  tools.push({
    name: 'list_files',
    grants: ['file_list'],
    readOnly: true,
    effect: 'read',
    description: 'List the project workspace file tree.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', default: '.', description: 'Workspace-relative directory to list' } },
    },
    execute: async (_id, { path }) => {
      try {
        const tree = await listProjectTree(projectId, path);
        return toolOk(JSON.stringify(tree, null, 2));
      } catch (err) {
        return toolError(err.message);
      }
    },
  });

  tools.push({
    name: 'move_file',
    grants: ['file_move'],
    readOnly: false,
    effect: 'write',
    description:
      'Move or rename a file or folder within the project workspace. Parent directories of the destination are created as needed. '
      + 'Use this to organize loose uploads — e.g. move "protocol.pdf" to "seed_docs/protocol.pdf".',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Workspace-relative source path' },
        to: { type: 'string', description: 'Workspace-relative destination path (including the new filename)' },
      },
      required: ['from', 'to'],
    },
    execute: async (_id, { from, to }) => {
      try {
        // Story 012-002: a move is an identity change, not a delete plus a
        // create. One 'moved' event carries the file's identity to the new
        // path and the hub re-keys every path-keyed consumer (seen state,
        // comments, pending edits, activeDocument) in the same transaction
        // that appends the activity row — so nothing is left orphaned at a
        // path that no longer exists.
        //
        // Pre-check the one collision the rewrite refuses, while the file is
        // still in place: a pending proposal at the destination exists only in
        // the DB (no bytes on disk), so storage cannot 409 on it and the
        // rewrite must not silently replace it.
        const clashes = findPendingEditConflicts(projectId, from, to);
        if (clashes.length > 0) {
          throw new Error(
            `Cannot move ${from} → ${to}: a pending proposed edit is already waiting at `
            + `${clashes.join(', ')}. Ask the user to accept or reject it first.`,
          );
        }
        // moveProjectEntry reports the CANONICAL paths it actually renamed;
        // publishing those (not the model's raw arguments) is what keeps the
        // prefix rewrite from matching zero rows on './a.md' or 'dir/'.
        const moved = await moveProjectEntry(projectId, from, to);
        const event = {
          type: 'file_change',
          agent: ctx.agent.slug,
          path: moved.to,
          kind: 'moved',
          meta: { from: moved.from },
        };
        // Published directly rather than only through the channel tee, because
        // 'moved' is the one kind whose persistence failure propagates and
        // EventChannel.push swallows tee throws (events.js:22-27) — a
        // push-only move would report success over a half-applied state. The
        // hub's WeakSet dedupe makes the tee's re-offer of this same object a
        // no-op, so the feed still sees exactly one envelope; it also means a
        // sub-agent run (depth > 0, untee'd) rewrites the DB too, where the
        // old push-only path depended on dispatch_agent forwarding.
        try {
          publishProjectEvent(ctx.projectId, event, { jobId: ctx.parentJob.id, userId: ctx.userId });
        } catch (err) {
          // The rename already committed on disk. Put the bytes back so the
          // tool never reports a move whose consumers were not carried with it.
          let restored = true;
          try {
            await moveProjectEntry(ctx.projectId, moved.to, moved.from);
          } catch {
            restored = false;
          }
          throw new Error(
            `Move failed: ${err.message}. `
            + (restored
              ? `${moved.from} was left in place.`
              : `${moved.from} could NOT be restored and is now at ${moved.to} — tell the user.`),
          );
        }
        ctx.channel.push(event); // mirror into the live client stream (deduped above)
        return toolOk(`Moved ${moved.from} → ${moved.to}`, { from: moved.from, to: moved.to });
      } catch (err) {
        return toolError(err.message);
      }
    },
  });

  tools.push({
    name: 'write_file',
    grants: ['file_write'],
    readOnly: false,
    effect: 'write',
    description: 'Create or overwrite a file in the project workspace. Parent directories are created as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    execute: async (_id, { path, content }) => {
      try {
        await rejectDerivedBibWrite(projectId, path);
        // Suggestion mode (story 008-001, widened by STH-44): writes to
        // draft/** and to any existing file outside agent-private folders
        // become pending edits the user reviews; the file's bytes do not
        // change here. The seeding pipeline bypasses the gate — its first
        // draft writes land directly (there is nothing to protect yet).
        if (!seeding && await isProposable(projectId, path)) {
          await proposeEdit(projectId, { path, proposedContent: content, agentSlug: ctx.agent.slug, jobId: ctx.parentJob.id });
          emitFileChange(ctx, { path, kind: 'proposed' });
          return toolOk(proposedResult(path));
        }
        const { created } = await writeProjectFile(projectId, path, content);
        emitFileChange(ctx, { path, kind: created ? 'create' : 'update' });
        return toolOk(`${created ? 'Created' : 'Updated'} ${path}`);
      } catch (err) {
        return toolError(err.message);
      }
    },
  });

  tools.push({
    name: 'edit_file',
    grants: ['file_write'],
    readOnly: false,
    effect: 'write',
    description: 'Replace an exact string in a file. old_string must match exactly and, unless replace_all is true, exactly once.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', default: false, description: 'Replace every occurrence' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    execute: async (_id, { path, old_string, new_string, replace_all }) => {
      try {
        await rejectDerivedBibWrite(projectId, path);
        const suggesting = !seeding && await isProposable(projectId, path);
        // In suggestion mode the "current content" is the EFFECTIVE content —
        // an existing proposal if there is one, else the disk file — so a
        // sequential write→edit on the same draft stays coherent (008-001).
        const content = suggesting
          ? await effectiveContent(projectId, path)
          : (await readProjectFile(projectId, path)).toString('utf-8');
        const occurrences = content.split(old_string).length - 1;
        if (occurrences === 0) throw new Error(`old_string not found in ${path}`);
        if (occurrences > 1 && !replace_all) {
          throw new Error(`old_string occurs ${occurrences} times in ${path}; pass replace_all or a longer unique string`);
        }
        const next = content.replaceAll(old_string, new_string);
        if (suggesting) {
          await proposeEdit(projectId, { path, proposedContent: next, agentSlug: ctx.agent.slug, jobId: ctx.parentJob.id });
          emitFileChange(ctx, { path, kind: 'proposed' });
          return toolOk(proposedResult(path));
        }
        await writeProjectFile(projectId, path, next);
        emitFileChange(ctx, { path, kind: 'update' });
        return toolOk(`Updated ${path} (${replace_all ? occurrences : 1} replacement${occurrences > 1 && replace_all ? 's' : ''})`);
      } catch (err) {
        return toolError(err.message);
      }
    },
  });

  return tools;
}
