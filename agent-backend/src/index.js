import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { initDb } from './db/init.js';
import { markOrphanedJobsInterrupted } from './db/jobs.js';
import { session, assertAuthConfig } from './session.js';
import healthRouter from './routes/health.js';
import { authRouter, meRouter } from './routes/auth.js';
import agentRouter from './routes/agent.js';
import citationsRouter from './routes/citations.js';
import filesRouter from './routes/files.js';
import orgsRouter from './routes/orgs.js';
import orgLibraryRouter from './routes/org-library.js';
import projectsRouter from './routes/projects.js';
import renderRouter from './routes/render.js';
import { handleSignalingConnection } from './yjs-signaling.js';
import { handleYjsConnection } from './yjs-websocket.js';

const app = express();
// credentials: the session cookie rides cross-origin fetches from the webapp
// dev server (story 007-002); the allowlist above stays the gate.
app.use(cors({ origin: config.cors.origin, credentials: true }));
app.use(express.json());
app.use(healthRouter); // health needs no identity
app.use(authRouter);   // login/logout happen before identity exists (007-002)
// Story 005: resolve req.user before any tenant-scoped route runs.
app.use(session);
app.use(meRouter);
app.use(agentRouter);
app.use(citationsRouter);
app.use(filesRouter);
app.use(orgsRouter);
app.use(orgLibraryRouter);
app.use(projectsRouter);
app.use(renderRouter);

const server = createServer(app);

// Two WebSocket servers — no port binding; upgrade is routed manually
const signalingWss = new WebSocketServer({ noServer: true });
const yjsWss = new WebSocketServer({ noServer: true });

signalingWss.on('connection', handleSignalingConnection);
yjsWss.on('connection', handleYjsConnection);

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (pathname === '/yjs-signaling') {
    signalingWss.handleUpgrade(req, socket, head, (ws) => {
      signalingWss.emit('connection', ws, req);
    });
  } else if (pathname.startsWith('/yjs-websocket/')) {
    yjsWss.handleUpgrade(req, socket, head, (ws) => {
      yjsWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

async function main() {
  assertAuthConfig(); // refuse to start in non-dev auth mode without a secret
  try {
    await initDb();
    const interrupted = await markOrphanedJobsInterrupted();
    if (interrupted > 0) {
      console.log(`[kuhn] Marked ${interrupted} orphaned job(s) as interrupted.`);
    }
  } catch (err) {
    console.error('[kuhn] DB initialization failed:', err.message);
    console.error('[kuhn] Server starting without DB — some features will be unavailable.');
  }

  server.listen(config.port, () => {
    console.log(`[kuhn] Agent backend listening on http://localhost:${config.port}`);
    console.log(`[kuhn] Yjs signaling:  ws://localhost:${config.port}/yjs-signaling`);
    console.log(`[kuhn] Yjs websocket:  ws://localhost:${config.port}/yjs-websocket/<room>`);
    console.log(`[kuhn] Health check:   http://localhost:${config.port}/health`);
  });
}

main();
