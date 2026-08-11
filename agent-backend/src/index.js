import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
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
import commentsRouter from './routes/comments.js';
import filesRouter from './routes/files.js';
import historyRouter from './routes/history.js';
import knowledgeRouter from './routes/knowledge.js';
import orgsRouter from './routes/orgs.js';
import orgAdminRouter from './routes/org-admin.js';
import orgLibraryRouter from './routes/org-library.js';
import pendingEditsRouter from './routes/pending-edits.js';
import projectsRouter from './routes/projects.js';
import promotionsRouter from './routes/promotions.js';
import renderRouter from './routes/render.js';
import reviewRouter from './routes/review.js';
import reviewLinksRouter from './routes/review-links.js';
import { createUpgradeHandler } from './collab-auth.js';
import { handleSignalingConnection } from './yjs-signaling.js';
import { handleYjsConnection } from './yjs-websocket.js';

const app = express();
// Deployed behind a TLS-terminating proxy/tunnel (cloudflared, nginx), the
// forwarded proto/host must be trusted so magic links are minted as https://
// on the public hostname (routes/auth.js builds them from req.protocol/host).
// Harmless locally: no X-Forwarded-* headers, nothing changes.
app.set('trust proxy', true);
// credentials: the session cookie rides cross-origin fetches from the webapp
// dev server (story 007-002); the allowlist above stays the gate.
app.use(cors({ origin: config.cors.origin, credentials: true }));
app.use(express.json());
app.use(healthRouter); // health needs no identity
app.use(authRouter);   // login/logout happen before identity exists (007-002)
// Epic 013: the guest (external reviewer) surface, BEFORE session() — a
// reviewer is anonymous to the member stack (their cookie is one session()
// cannot see), and every guest route lives under /api/review/*, so the rest
// of /api stays structurally closed to them.
app.use(reviewRouter);
// Single-port deployment: serve the built webapp alongside the API. Mounted
// before session() — a signed-out visitor must be able to load the app shell
// to reach the sign-in screen. The SPA fallback leaves API paths alone so
// unmatched /api requests still 404 instead of returning index.html.
const webappDist = config.webapp.dist;
const serveWebapp = webappDist && existsSync(join(webappDist, 'index.html'));
if (serveWebapp) {
  const reviewShell = join(webappDist, 'review.html');
  const serveReviewShell = existsSync(reviewShell);
  app.use(express.static(webappDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/health') {
      next();
      return;
    }
    // Epic 013: /review/<token> gets the slim reviewer shell, not the member
    // SPA (which would boot the full app and 401 its way to the sign-in
    // overlay). Falls through to the SPA only when the build predates the
    // reviewer entry.
    if (serveReviewShell && (req.path === '/review' || req.path.startsWith('/review/'))) {
      res.sendFile(reviewShell);
      return;
    }
    res.sendFile(join(webappDist, 'index.html'));
  });
}
// Story 005: resolve req.user before any tenant-scoped route runs.
app.use(session);
app.use(meRouter);
app.use(agentRouter);
app.use(citationsRouter);
app.use(commentsRouter);
app.use(filesRouter);
app.use(historyRouter);
app.use(knowledgeRouter); // Kuhn knowledge catalog + per-org selections (issue #65)
app.use(orgsRouter);
app.use(orgAdminRouter); // owner-gated members/invitations/settings (epic 011)
app.use(orgLibraryRouter);
app.use(pendingEditsRouter);
app.use(projectsRouter);
app.use(promotionsRouter); // owner-gated promotion-approval queue (story 011-004)
app.use(renderRouter);
app.use(reviewLinksRouter); // member mint/list/revoke of review links (epic 013)

const server = createServer(app);

// Two WebSocket servers — no port binding; upgrade is routed manually
const signalingWss = new WebSocketServer({ noServer: true });
const yjsWss = new WebSocketServer({ noServer: true });

signalingWss.on('connection', handleSignalingConnection);
yjsWss.on('connection', handleYjsConnection);

// Route + authenticate + authorize every WS upgrade (story 007-003): doc-sync
// rooms are membership-checked before the handshake completes; signaling is
// authenticated here and topic-checked per message.
server.on('upgrade', createUpgradeHandler({ signalingWss, yjsWss }));

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
    if (serveWebapp) {
      console.log(`[kuhn] Serving webapp: ${webappDist}`);
    }
  });
}

main();
