import { Router } from 'express';
import { deliverReply } from '../agents/questions.js';
import { runAgentTask } from '../agents/runtime.js';
import { getJob, listJobs } from '../db/jobs.js';
import { streamEvents } from './sse.js';

const router = Router();

/**
 * POST /api/agent/task
 * Body: { role, projectId, input, context?, sessionId? }
 * Streams AgentEvents to the browser as Server-Sent Events.
 */
router.post('/api/agent/task', async (req, res) => {
  const { role, projectId, input, context, sessionId } = req.body ?? {};
  if (!role || projectId == null || !input) {
    res.status(400).json({ error: 'role, projectId, and input are required' });
    return;
  }
  await streamEvents(res, runAgentTask({ role, projectId, input, context, sessionId }));
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

export default router;
