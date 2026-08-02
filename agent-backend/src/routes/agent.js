import { Router } from 'express';
import { deliverReply, getPendingQuestion, hasPendingQuestion } from '../agents/questions.js';
import { runAgentTask, reattach } from '../agents/runtime.js';
import { getRun, listLiveRuns } from '../agents/runs.js';
import { getJob, getJobTrace, listJobs } from '../db/jobs.js';
import { streamEvents } from './sse.js';

const router = Router();

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
  // detachable: survive a browser disconnect while parked on an ask_user
  // question, so the user can reload and reconnect to the question (story 027).
  // The abort signal lets runAgentTask end its consume loop promptly on
  // disconnect even while parked (no events arrive to unblock channel.next()).
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  await streamEvents(res, runAgentTask({ role, projectId, input, context, sessionId, compose, userId: req.user.id, detachable: true, signal: ac.signal }));
});

/**
 * GET /api/agent/jobs?projectId=&status=&limit=
 * List jobs, newest first.
 */
router.get('/api/agent/jobs', async (req, res) => {
  const { projectId, status, limit } = req.query;
  const jobs = await listJobs({
    projectId: projectId != null ? parseInt(projectId) : null,
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
  const trace = await getJobTrace(parseInt(req.params.id));
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
  const job = await getJob(parseInt(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
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
router.post('/api/agent/jobs/:id/reply', (req, res) => {
  const { reply } = req.body ?? {};
  if (!reply || typeof reply !== 'string') {
    res.status(400).json({ error: 'reply is required' });
    return;
  }
  if (!deliverReply(parseInt(req.params.id), reply)) {
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
router.get('/api/agent/pending', (req, res) => {
  const projectId = req.query.projectId != null ? parseInt(req.query.projectId) : null;
  const pending = listLiveRuns(projectId)
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
  const run = getRun(parseInt(req.params.id));
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
