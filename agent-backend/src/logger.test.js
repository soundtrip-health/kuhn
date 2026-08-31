import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
let spies;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kuhn-logger-'));
  vi.resetModules();
  spies = ['log', 'warn', 'error'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  for (const spy of spies) spy.mockRestore();
});

async function load(env = {}) {
  vi.stubEnv('KUHN_LOG_DIR', dir);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import('./logger.js')).log;
}

function todayFile() {
  return join(dir, `kuhn-${new Date().toISOString().slice(0, 10)}.ndjson`);
}

function records() {
  return readFileSync(todayFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('logger', () => {
  it('appends NDJSON records with ts/level/event and fields', async () => {
    const log = await load();
    log.info('unit_test', { a: 1, s: 'x' });
    const [rec] = records();
    expect(rec).toMatchObject({ level: 'info', event: 'unit_test', a: 1, s: 'x' });
    expect(new Date(rec.ts).getTime()).toBeGreaterThan(0);
  });

  it('drops debug below the default info threshold, keeps it under LOG_LEVEL=debug', async () => {
    let log = await load();
    log.debug('quiet');
    expect(() => records()).toThrow(); // nothing written, file never created
    vi.resetModules();
    log = await load({ LOG_LEVEL: 'debug' });
    log.debug('loud');
    expect(records()[0].event).toBe('loud');
  });

  it('flattens Error values and omits undefined fields', async () => {
    const log = await load();
    const err = new Error('boom');
    err.code = 'EBOOM';
    log.error('failed', { err, missing: undefined });
    const [rec] = records();
    expect(rec.err).toMatchObject({ message: 'boom', code: 'EBOOM' });
    expect(rec.err.stack).toContain('boom');
    expect('missing' in rec).toBe(false);
  });

  it('survives an unwritable log dir and keeps working console-only', async () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a dir');
    vi.stubEnv('KUHN_LOG_DIR', join(blocker, 'logs'));
    const log = (await import('./logger.js')).log;
    expect(() => log.info('first')).not.toThrow();
    expect(() => log.info('second')).not.toThrow();
  });

  it("KUHN_LOG_DIR='' disables the file sink without throwing", async () => {
    vi.stubEnv('KUHN_LOG_DIR', '');
    const log = (await import('./logger.js')).log;
    expect(() => log.info('console_only')).not.toThrow();
  });
});
