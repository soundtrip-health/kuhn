import { Router } from 'express';
import { runAgentTask } from '../agents/runtime.js';
import { getJob, listJobs } from '../db/jobs.js';

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
  await streamTask(res, req, { role, projectId, input, context, sessionId });
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
  await streamTask(res, req, {
    role: job.role,
    projectId: job.project_id,
    input: job.input,
    context: job.context,
    sessionId: job.session_id ?? undefined,
  });
});

async function streamTask(res, req, task) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const events = runAgentTask(task);
  // Stop the agent when the browser disconnects
  req.on('close', () => events.return());

  try {
    for await (const event of events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  } finally {
    res.end();
  }
}

export default router;
