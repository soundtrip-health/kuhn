/**
 * y-webrtc signaling relay server.
 *
 * Protocol (JSON over WebSocket):
 *   Client → Server:
 *     { type: 'subscribe',   topics: string[] }
 *     { type: 'unsubscribe', topics: string[] }
 *     { type: 'publish',     topic: string, data: any }
 *     { type: 'ping' }
 *
 *   Server → Client:
 *     { type: 'subscribe', topics: string[], clients: number }  (confirmation)
 *     { type: 'publish',   topic: string, data: any }           (relayed)
 *     { type: 'pong' }
 *
 * Authorization (story 007-003; roles in 010-003): the upgrade handler
 * (collab-auth.js) has already authenticated the connection and stamped
 * req.kuhnUser. Topics are room names, so each subscribe topic is
 * membership-checked like a doc-sync room join (canJoinRoom — viewers may
 * listen), while publish requires editor-or-better and an unsuspended org
 * (canPublishRoom) so the webrtc side channel can never out-privilege the
 * doc-sync write gate. Unauthorized topics are silently dropped. Verdicts are
 * cached per connection, per level. Dev mode: both checks always allow.
 */

import { canJoinRoom, canPublishRoom } from './collab-auth.js';

/** @type {Map<string, Set<import('ws').WebSocket>>} topic → subscribers */
const topics = new Map();

function getSubscribers(topic) {
  if (!topics.has(topic)) topics.set(topic, new Set());
  return topics.get(topic);
}

function send(ws, message) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(message));
  }
}

export function handleSignalingConnection(ws, req) {
  /** @type {Set<string>} topics this client is subscribed to */
  const subscribed = new Set();
  const user = req?.kuhnUser ?? null;
  /** @type {Map<string, boolean>} per-connection subscribe authorization cache */
  const allowed = new Map();
  /** @type {Map<string, boolean>} per-connection publish authorization cache */
  const allowedPublish = new Map();

  async function authorizeTopic(topic) {
    if (!allowed.has(topic)) allowed.set(topic, await canJoinRoom(user, topic));
    return allowed.get(topic);
  }

  async function authorizePublish(topic) {
    if (!allowedPublish.has(topic)) allowedPublish.set(topic, await canPublishRoom(user, topic));
    return allowedPublish.get(topic);
  }

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'subscribe': {
        const confirmedTopics = [];
        for (const topic of msg.topics || []) {
          if (!(await authorizeTopic(topic))) continue; // drop unauthorized topics
          const subs = getSubscribers(topic);
          subs.add(ws);
          subscribed.add(topic);
          confirmedTopics.push(topic);
        }
        send(ws, {
          type: 'subscribe',
          topics: confirmedTopics,
          clients: confirmedTopics.map((t) => getSubscribers(t).size),
        });
        break;
      }

      case 'unsubscribe': {
        for (const topic of msg.topics || []) {
          const subs = getSubscribers(topic);
          subs.delete(ws);
          subscribed.delete(topic);
          if (subs.size === 0) topics.delete(topic);
        }
        break;
      }

      case 'publish': {
        if (!(await authorizePublish(msg.topic))) break; // viewers listen, never speak (010-003)
        const subs = getSubscribers(msg.topic);
        for (const sub of subs) {
          if (sub !== ws) {
            send(sub, { type: 'publish', topic: msg.topic, data: msg.data });
          }
        }
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong' });
        break;
      }
    }
  });

  ws.on('close', () => {
    for (const topic of subscribed) {
      const subs = getSubscribers(topic);
      subs.delete(ws);
      if (subs.size === 0) topics.delete(topic);
    }
  });
}
