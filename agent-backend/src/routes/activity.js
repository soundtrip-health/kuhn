// Org activity feed (issue #113 item 3): GET /api/orgs/:id/activity streams
// the caller's chat status transitions — and, for owners, every member's
// (status and agent only) — as SSE on the org event hub, opening with a
// snapshot so a fresh tab shows the right marks at once. Tenancy: the org
// guard (viewer), and the hub is per org, so nothing crosses tenants.

import { Router } from 'express';
import { chatActivitySnapshot, visibleActivity } from '../agents/activity.js';
import { subscribeOrgEvents } from '../project-events.js';
import { requireOrgRole } from './guards.js';

const router = Router();

router.get('/api/orgs/:id/activity', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.id, 'viewer');
  if (!ctx) return;
  const who = { userId: req.user.id, everyone: ctx.role === 'owner' };

  const unsubscribe = subscribeOrgEvents(ctx.orgId, (event) => {
    const visible = visibleActivity(event, who);
    if (visible) res.write(`data: ${JSON.stringify(visible)}\n\n`);
  });
  if (!unsubscribe) {
    res.status(503).json({ error: 'too many event subscribers for this organization' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // The snapshot goes out after the subscription is live, so a transition
  // between the two cannot be missed (a duplicate is harmless: records are
  // keyed by chat and idempotent).
  const chats = await chatActivitySnapshot(ctx.orgId, who);
  res.write(`data: ${JSON.stringify({ type: 'snapshot', chats })}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  heartbeat.unref?.();
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
