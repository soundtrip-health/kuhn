// Agent task/job HTTP surface. Tenancy (story 010-003): there is no
// :projectId in these paths, so every route resolves its project itself —
// from the request body (task), the query string (jobs/pending), or the
// stored job row (trace/dispatch/reply/reconnect) — and passes it through
// requireProjectRole. Dispatching work and answering an agent are writes
// (editor); inspecting jobs and traces is a read (viewer).

import { Router } from 'express';
import { deliverReply, getPendingQuestion, hasPendingQuestion } from '../agents/questions.js';
import { runAgentTask, reattach } from '../agents/runtime.js';
import { getRun, listLiveRuns } from '../agents/runs.js';
import { getJob, getJobTrace, listJobs } from '../db/jobs.js';
import { requireProjectRole } from './guards.js';
import { streamEvents } from './sse.js';

const router = Router();

/**
 * Resolve the job named by :id and require minRole in its project's org.
 * Unknown job → 404; the guard sends its own refusals (non-leaking 404 for
 * non-members, 403 for role/suspension).
 * @returns {Promise<object|null>} the job row, or null after responding
 */
async function requireJobRole(req, res, minRole) {
  const job = await getJob(parseInt(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return null;
  }
  if (!(await requireProjectRole(req, res, job.project_id, minRole))) return null;
  return job;
}

/**
 * POST /api/agent/task
 * Body: { role, projectId, input, context?, sessionId?, compose? }
 * `compose: true` runs the task in compose mode — file-mutating tools are
 * withheld so the agent returns text only (the /write contract, story 017).
 * Streams AgentEvents to the browser as Server-Sent Events.
 */
router.post('/api/agent/task', async (req, res) => {
  const { role, projectId, input, context, sessionId, compose } = req.body ?? {};
  if (!role || projectId == null || !input) {
    res.status(400).json({ error: 'role, projectId, and input are required' });
    return;
  }
  const project = await requireProjectRole(req, res, projectId, 'editor');
  if (!project) return;
  // detachable: survive a browser disconnect while parked on an ask_user
  // question, so the user can reload and reconnect to the question (story 027).
  // The abort signal lets runAgentTask end its consume loop promptly on
  // disconnect even while parked (no events arrive to unblock channel.next()).
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  await streamEvents(res, runAgentTask({ role, projectId: project.id, input, context, sessionId, compose, userId: req.user.id, detachable: true, signal: ac.signal }));
});

/**
 * GET /api/agent/jobs?projectId=&status=&limit=
 * List a project's jobs, newest first. projectId is required since 010-003:
 * an unscoped listing would cross tenant lines.
 */
router.get('/api/agent/jobs', async (req, res) => {
  const { projectId, status, limit } = req.query;
  if (projectId == null) {
    res.status(400).json({ error: 'projectId query parameter is required' });
    return;
  }
  const project = await requireProjectRole(req, res, projectId, 'viewer');
  if (!project) return;
  const jobs = await listJobs({
    projectId: project.id,
    status: status ?? null,
    limit: limit != null ? parseInt(limit) : 50,
  });
  res.json({ jobs });
});

/**
 * GET /api/agent/jobs/:id/trace
 * Full audit trace of a job (issue #42): the job row, its conversation
 * messages (tool calls and tool results, with is_error flags), and recursively
 * every sub-agent job it dispatched. Built for reviewing agent runs — both
 * debugging a user-reported failure and proactively sampling logs.
 */
router.get('/api/agent/jobs/:id/trace', async (req, res) => {
  const job = await requireJobRole(req, res, 'viewer');
  if (!job) return;
  const trace = await getJobTrace(job.id);
  if (!trace) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json(trace);
});

/**
 * POST /api/agent/jobs/:id/dispatch
 * Re-dispatch a stored job (e.g. one marked 'interrupted' after a restart)
 * as a fresh task with the same role/project/input, resuming the SDK session
 * when one was recorded. Streams events like POST /api/agent/task.
 */
router.post('/api/agent/jobs/:id/dispatch', async (req, res) => {
  const job = await requireJobRole(req, res, 'editor');
  if (!job) return;
  await streamEvents(res, runAgentTask({
    role: job.role,
    projectId: job.project_id,
    input: job.input,
    context: job.context,
    sessionId: job.session_id ?? undefined,
    userId: req.user.id, // the re-dispatcher, not the original job's user
  }));
});

/**
 * POST /api/agent/jobs/:id/reply
 * Body: { reply } — answer the pending ask_user question of a running job
 * (story 012). The reply unblocks the agent's tool call; events keep flowing
 * on the job's original SSE stream.
 */
router.post('/api/agent/jobs/:id/reply', async (req, res) => {
  const { reply } = req.body ?? {};
  if (!reply || typeof reply !== 'string') {
    res.status(400).json({ error: 'reply is required' });
    return;
  }
  const job = await requireJobRole(req, res, 'editor');
  if (!job) return;
  if (!deliverReply(job.id, reply)) {
    res.status(409).json({ error: 'no pending question for this job' });
    return;
  }
  res.json({ ok: true });
});

/**
 * GET /api/agent/pending?projectId=
 * Runs that are alive, parked on an ask_user question, and have no attached
 * consumer — i.e. ones the browser can reconnect to after a reload (story 027).
 * This is in-memory runtime state (it returns nothing after a server restart),
 * so it is a dedicated endpoint rather than a field on the DB-backed jobs list.
 */
router.get('/api/agent/pending', async (req, res) => {
  if (req.query.projectId == null) {
    res.status(400).json({ error: 'projectId query parameter is required' });
    return;
  }
  const project = await requireProjectRole(req, res, req.query.projectId, 'viewer');
  if (!project) return;
  const pending = listLiveRuns(project.id)
    .filter((r) => !r.consumerAttached && hasPendingQuestion(r.jobId))
    .map((r) => {
      const q = getPendingQuestion(r.jobId);
      return { jobId: r.jobId, role: r.role, agent: q?.agent ?? r.role, question: q?.question ?? '' };
    });
  res.json({ pending });
});

/**
 * POST /api/agent/jobs/:id/reconnect
 * Re-attach an SSE stream to a still-alive run whose consumer dropped while it
 * was parked on a question (story 027). Re-emits the pending question, then
 * streams subsequent live events. 404 if no live run; 409 if one is already
 * attached (the EventChannel is single-consumer).
 */
router.post('/api/agent/jobs/:id/reconnect', async (req, res) => {
  const job = await requireJobRole(req, res, 'editor');
  if (!job) return;
  const run = getRun(job.id);
  if (!run) {
    res.status(404).json({ error: 'no live run for this job' });
    return;
  }
  if (run.consumerAttached) {
    res.status(409).json({ error: 'run already has a consumer' });
    return;
  }
  run.consumerAttached = true;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  await streamEvents(res, reattach(run, ac.signal));
});

export default router;
