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
 * Authorization (story 007-003): the upgrade handler (collab-auth.js) has
 * already authenticated the connection and stamped req.kuhnUser. Topics are
 * room names, so each subscribe/publish topic is membership-checked like a
 * doc-sync room join; unauthorized topics are silently dropped. Results are
 * cached per connection. Dev mode: canJoinRoom always allows.
 */

import { canJoinRoom } from './collab-auth.js';

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
  /** @type {Map<string, boolean>} per-connection topic authorization cache */
  const allowed = new Map();

  async function authorizeTopic(topic) {
    if (!allowed.has(topic)) allowed.set(topic, await canJoinRoom(user, topic));
    return allowed.get(topic);
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
        if (!(await authorizeTopic(msg.topic))) break; // no relay into rooms you can't join
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
