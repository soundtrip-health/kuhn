// Per-request access log. One `http_request` record per completed (or
// aborted) API response: method, redacted URL, status, duration, the resolved
// user, client IP and user agent, plus the JSON error body on 4xx/5xx. Static
// assets, the SPA shell and /health are skipped — they say nothing about what
// a user did.
//
// Motivation (2026-09-04 preview/collab bug report): the backend logged
// nothing for a session in which a user's preview and collaboration socket
// both failed, so triage had to start from the browser console. The user
// agent in particular is what tells a device-specific rendering problem apart
// from a server one. Mode is config.log.requests: all | errors | off.

import { config } from './config.js';
import { log } from './logger.js';

/** Query keys that carry credentials (magic-link tokens, invitation tokens). */
const REDACTED_QUERY_KEYS = new Set(['token', 'invite']);

/** Mask credential-bearing query parameters so the log can't replay them. */
export function redactUrl(url) {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const key of [...params.keys()]) {
    if (REDACTED_QUERY_KEYS.has(key)) {
      params.set(key, '[redacted]');
      changed = true;
    }
  }
  return changed ? `${url.slice(0, q)}?${params.toString()}` : url;
}

/** Client IP: first X-Forwarded-For hop behind a proxy, else the socket peer. */
export function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/** Should this path be logged at all? API only — assets and the shell are noise. */
export function isLoggedPath(path) {
  return typeof path === 'string' && path.startsWith('/api');
}

/**
 * Express middleware. Mount before the routers so every API response is
 * covered; req.user is read at finish time, after the session middleware ran.
 * @param {{ mode?: 'all'|'errors'|'off' }} [options] overrides config (tests)
 */
export function requestLog(options = {}) {
  const mode = options.mode ?? config.log?.requests ?? 'all';
  return (req, res, next) => {
    if (mode === 'off' || !isLoggedPath(req.path)) {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    // Capture the readable error the route sent, so the log line says why,
    // not just that it was a 4xx.
    let errorBody;
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400 && body && typeof body === 'object' && typeof body.error === 'string') {
        errorBody = body.error;
      }
      return json(body);
    };
    let done = false;
    const finish = (aborted) => {
      if (done) return;
      done = true;
      const status = res.statusCode;
      if (mode === 'errors' && status < 400 && !aborted) return;
      const fields = {
        method: req.method,
        url: redactUrl(req.originalUrl ?? req.url ?? ''),
        status,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        userId: req.user?.id ?? null,
        ip: clientIp(req),
        ua: req.headers?.['user-agent'],
      };
      if (aborted) fields.aborted = true;
      if (errorBody !== undefined) fields.error = errorBody;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      log[level]('http_request', fields);
    };
    res.on('finish', () => finish(false));
    // 'close' without 'finish' is a client that went away mid-response — an
    // SSE stream ending, or an upload abandoned. Worth a line either way.
    res.on('close', () => finish(!res.writableFinished));
    next();
  };
}
