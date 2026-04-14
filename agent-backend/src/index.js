import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import healthRouter from './routes/health.js';
import { handleSignalingConnection } from './yjs-signaling.js';
import { handleYjsConnection } from './yjs-websocket.js';

const app = express();
app.use(cors({ origin: config.cors.origin }));
app.use(express.json());
app.use(healthRouter);

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

server.listen(config.port, () => {
  console.log(`[kuhn] Agent backend listening on http://localhost:${config.port}`);
  console.log(`[kuhn] Yjs signaling:  ws://localhost:${config.port}/yjs-signaling`);
  console.log(`[kuhn] Yjs websocket:  ws://localhost:${config.port}/yjs-websocket/<room>`);
  console.log(`[kuhn] Health check:   http://localhost:${config.port}/health`);
});
