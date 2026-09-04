import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logged = [];
vi.mock('./logger.js', () => ({
  log: {
    debug: (event, fields) => logged.push({ level: 'debug', event, ...fields }),
    info: (event, fields) => logged.push({ level: 'info', event, ...fields }),
    warn: (event, fields) => logged.push({ level: 'warn', event, ...fields }),
    error: (event, fields) => logged.push({ level: 'error', event, ...fields }),
  },
}));
vi.mock('./config.js', () => ({ config: { log: { requests: 'all' } } }));

const { clientIp, isLoggedPath, redactUrl, requestLog } = await import('./request-log.js');

function fakeReq(overrides = {}) {
  return {
    method: 'GET',
    path: '/api/projects/1/render',
    originalUrl: '/api/projects/1/render',
    headers: { 'user-agent': 'TestBrowser/1.0' },
    ip: '10.0.0.1',
    ...overrides,
  };
}

function fakeRes(status = 200) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.writableFinished = false;
  res.json = vi.fn((body) => {
    res.body = body;
    return res;
  });
  res.finish = () => {
    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
  };
  return res;
}

beforeEach(() => {
  logged.length = 0;
});

describe('redactUrl', () => {
  it('masks credential-bearing query params and leaves the rest', () => {
    expect(redactUrl('/api/auth/verify?token=abc123&next=%2F')).toBe('/api/auth/verify?token=%5Bredacted%5D&next=%2F');
    expect(redactUrl('/api/auth/verify?invite=xyz')).toContain('invite=%5Bredacted%5D');
    expect(redactUrl('/api/projects/1/export?path=a.md&format=pdf')).toBe('/api/projects/1/export?path=a.md&format=pdf');
    expect(redactUrl('/api/me')).toBe('/api/me');
  });
});

describe('clientIp', () => {
  it('prefers the first forwarded hop, then req.ip', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' }, ip: '10.0.0.1' })).toBe('203.0.113.9');
    expect(clientIp({ headers: {}, ip: '10.0.0.1' })).toBe('10.0.0.1');
  });
});

describe('isLoggedPath', () => {
  it('covers the API only', () => {
    expect(isLoggedPath('/api/projects')).toBe(true);
    expect(isLoggedPath('/health')).toBe(false);
    expect(isLoggedPath('/assets/index-abc.js')).toBe(false);
    expect(isLoggedPath('/')).toBe(false);
  });
});

describe('requestLog middleware', () => {
  it('logs one info record per finished API response with user, ip and ua', () => {
    const mw = requestLog();
    const req = fakeReq({ user: { id: 7 } });
    const res = fakeRes(200);
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(logged).toHaveLength(0);
    res.finish();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: 'info', event: 'http_request', method: 'GET', url: '/api/projects/1/render',
      status: 200, userId: 7, ip: '10.0.0.1', ua: 'TestBrowser/1.0',
    });
    expect(typeof logged[0].ms).toBe('number');
    expect(logged[0]).not.toHaveProperty('aborted');
  });

  it('captures the JSON error body and warns on 4xx, errors on 5xx', () => {
    const mw = requestLog();
    const res4 = fakeRes(403);
    mw(fakeReq(), res4, () => {});
    res4.json({ error: 'requires editor role' });
    res4.finish();
    expect(logged[0]).toMatchObject({ level: 'warn', status: 403, error: 'requires editor role', userId: null });

    const res5 = fakeRes(500);
    mw(fakeReq(), res5, () => {});
    res5.json({ error: 'Internal error' });
    res5.finish();
    expect(logged[1]).toMatchObject({ level: 'error', status: 500, error: 'Internal error' });
  });

  it('marks a response the client abandoned before it finished', () => {
    const mw = requestLog();
    const res = fakeRes(200);
    mw(fakeReq({ originalUrl: '/api/projects/1/events' }), res, () => {});
    res.emit('close'); // no 'finish'
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ aborted: true, url: '/api/projects/1/events' });
    res.emit('close');
    expect(logged).toHaveLength(1); // idempotent
  });

  it('skips non-API paths, honors errors-only and off modes', () => {
    const res = fakeRes(200);
    requestLog()(fakeReq({ path: '/assets/app.js', originalUrl: '/assets/app.js' }), res, () => {});
    res.finish();
    expect(logged).toHaveLength(0);

    const ok = fakeRes(200);
    requestLog({ mode: 'errors' })(fakeReq(), ok, () => {});
    ok.finish();
    expect(logged).toHaveLength(0);
    const bad = fakeRes(404);
    requestLog({ mode: 'errors' })(fakeReq(), bad, () => {});
    bad.finish();
    expect(logged).toHaveLength(1);

    const off = fakeRes(500);
    const next = vi.fn();
    requestLog({ mode: 'off' })(fakeReq(), off, next);
    off.finish();
    expect(next).toHaveBeenCalledOnce();
    expect(logged).toHaveLength(1);
  });

  it('redacts a magic-link token in the logged URL', () => {
    const res = fakeRes(302);
    requestLog()(fakeReq({ path: '/api/auth/verify', originalUrl: '/api/auth/verify?token=SECRET' }), res, () => {});
    res.finish();
    expect(logged[0].url).not.toContain('SECRET');
  });
});
