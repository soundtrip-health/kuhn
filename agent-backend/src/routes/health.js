import { Router } from 'express';
import { checkConnection } from '../db.js';
import pkg from '../../package.json' with { type: 'json' };

const router = Router();

router.get('/health', async (_req, res) => {
  const db = await checkConnection();
  const status = db.ok ? 200 : 503;
  res.status(status).json({
    status: db.ok ? 'ok' : 'degraded',
    version: pkg.version,
    db,
    uptime: process.uptime(),
  });
});

export default router;
