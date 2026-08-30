/**
 * Assertion context for conformance scenarios (STH-5).
 *
 * Scenarios assert against Kuhn-owned, provider-neutral observables only:
 * domain events, the project feed, database rows, workspace files, and the
 * driver's observation record (the app-owned prompt/systemPrompt/cwd/model it
 * sent to the provider, plus resume and interrupt diagnostics). A scenario may
 * never inspect provider-native message shapes — the drivers own those.
 */
import { querySync } from '../../db.js';
import { readProjectFile } from '../../storage.js';

export function makeCtx({ scenario, fixture, events, feed, driver, runs, violations }) {
  const ctx = {
    scenario,
    fixture,
    events,                       // all domain events, in order, all tasks
    feed,                         // project feed envelopes { event, jobId, userId }
    driver,                       // { name, kind, observations, transcripts }
    runs,                         // per task: { index, role, jobId, terminal, latencyMs }
    violations,

    /** Record one check. name + ok + optional detail; a failing check lands
     * in the result record's violations list. */
    check(name, ok, detail = null) {
      if (ok) return;
      violations.push(`${name}${detail ? `: ${detail}` : ''}`);
    },

    // ---- Database views (real SQLite, Kuhn's own tables) -----------------
    rows(sql, params = []) {
      return querySync(sql, params).rows;
    },
    jobs() { return ctx.rows('SELECT * FROM jobs ORDER BY id'); },
    job(jobId) { return ctx.jobs().find((j) => j.id === jobId) ?? null; },
    conversations() { return ctx.rows('SELECT * FROM conversations ORDER BY id'); },
    messages(conversationId = null) {
      if (conversationId == null) {
        return ctx.rows('SELECT * FROM messages ORDER BY conversation_id, id');
      }
      return ctx.rows('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id', [conversationId]);
    },
    toolMessages(conversationId) {
      return ctx.messages(conversationId).filter((m) => m.role === 'tool');
    },
    pendingEdits(projectId) { return ctx.rows('SELECT * FROM pending_edits WHERE project_id = $1 ORDER BY id', [projectId]); },
    references(projectId) { return ctx.rows('SELECT * FROM bib_references WHERE project_id = $1 ORDER BY id', [projectId]); },
    comments(projectId) { return ctx.rows('SELECT * FROM comments WHERE project_id = $1 ORDER BY id', [projectId]); },
    project(projectId) { return ctx.rows('SELECT * FROM projects WHERE id = $1', [projectId])[0] ?? null; },
    organizations() { return ctx.rows('SELECT * FROM organizations ORDER BY id'); },

    // ---- Workspace files (real storage service) ---------------------------
    async read(rel) {
      try {
        return (await readProjectFile(ctx.fixture.projectId, rel)).toString('utf-8');
      } catch {
        return null;
      }
    },
    async exists(rel) {
      return (await ctx.read(rel)) != null;
    },

    // ---- Event helpers ----------------------------------------------------
    eventsOf(type) { return ctx.events.filter((e) => e.type === type); },
    lastEventOf(type) {
      for (let i = ctx.events.length - 1; i >= 0; i--) {
        if (ctx.events[i].type === type) return ctx.events[i];
      }
      return null;
    },
    eventsForJob(jobId) { return ctx.events.filter((e) => e.jobId === jobId); },
  };
  return ctx;
}
