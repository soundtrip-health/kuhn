import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';

import { config } from './config.js';
import { SandboxError, buildDockerArgs, runSandboxed } from './sandbox.js';

// Fake docker child process: script controls what the "container" emits.
function fakeSpawn(script) {
  const calls = [];
  const impl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      child.killedWith = signal;
      // a killed container closes without a normal exit code
      setImmediate(() => child.emit('close', null));
    };
    calls.push({ command, args, child });
    setImmediate(() => script(child));
    return child;
  };
  impl.calls = calls;
  return impl;
}

describe('buildDockerArgs', () => {
  it('isolates the container: no network, read-only project, resource limits', () => {
    const args = buildDockerArgs({
      image: 'typst:test',
      cmd: ['compile', '/work/main.typ', '/out/output.pdf'],
      projectDir: '/projects/1',
      outDir: '/tmp/out',
    });
    expect(args.join(' ')).toContain('--network none');
    expect(args).toContain('/projects/1:/work:ro');
    expect(args).toContain('/tmp/out:/out');
    expect(args.join(' ')).toContain(`--cpus ${config.sandbox.cpus}`);
    expect(args.join(' ')).toContain(`--memory ${config.sandbox.memory}`);
    // image comes before its command
    expect(args.indexOf('typst:test')).toBeLessThan(args.indexOf('compile'));
  });

  it('keeps --network none unconditional with the script-run extensions (issue #68b)', () => {
    const args = buildDockerArgs({
      image: 'kuhn/r-analysis:test',
      cmd: ['Rscript', '/script/fit.R', '--input', 'data.csv'],
      projectDir: '/projects/1',
      outDir: '/tmp/out',
      extraMounts: [{ hostDir: '/tmp/script', containerDir: '/script', readonly: true }],
      env: { OUT_DIR: '/out' },
      cpus: '2',
      memory: '2g',
    });
    expect(args.join(' ')).toContain('--network none');
    expect(args).toContain('/tmp/script:/script:ro');
    expect(args.join(' ')).toContain('-e OUT_DIR=/out');
    expect(args.join(' ')).toContain('--cpus 2');
    expect(args.join(' ')).toContain('--memory 2g');
    expect(args).toContain('/projects/1:/work:ro'); // project stays read-only
    // mounts and env are docker options: all before the image
    expect(args.indexOf('/tmp/script:/script:ro')).toBeLessThan(args.indexOf('kuhn/r-analysis:test'));
    expect(args.indexOf('OUT_DIR=/out')).toBeLessThan(args.indexOf('kuhn/r-analysis:test'));
  });
});

describe('runSandboxed', () => {
  const baseOpts = { image: 'img', cmd: ['true'], projectDir: '/p/1' };

  it('captures stdout/stderr and the exit code', async () => {
    const spawn = fakeSpawn((child) => {
      child.stdout.emit('data', Buffer.from('rendered ok\n'));
      child.stderr.emit('data', Buffer.from('warning: x\n'));
      child.emit('close', 0);
    });
    const result = await runSandboxed(baseOpts, spawn);
    expect(result).toEqual({ exitCode: 0, stdout: 'rendered ok\n', stderr: 'warning: x\n', truncated: false });
    expect(spawn.calls[0].command).toBe('docker');
  });

  it('returns non-zero exit codes instead of throwing', async () => {
    const spawn = fakeSpawn((child) => {
      child.stderr.emit('data', Buffer.from('compile error'));
      child.emit('close', 1);
    });
    const result = await runSandboxed(baseOpts, spawn);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('compile error');
  });

  it('caps captured output and flags truncation', async () => {
    const spawn = fakeSpawn((child) => {
      child.stdout.emit('data', Buffer.from('x'.repeat(100)));
      child.stdout.emit('data', Buffer.from('y'.repeat(100)));
      child.emit('close', 0);
    });
    const result = await runSandboxed({ ...baseOpts, maxOutputBytes: 150 }, spawn);
    expect(result.stdout).toHaveLength(150);
    expect(result.truncated).toBe(true);
  });

  it('kills the container and throws a clean error on timeout', async () => {
    const spawn = fakeSpawn(() => { /* never closes on its own */ });
    await expect(runSandboxed({ ...baseOpts, timeoutMs: 30 }, spawn)).rejects.toMatchObject({
      name: 'SandboxError',
      code: 'timeout',
    });
    expect(spawn.calls[0].child.killedWith).toBe('SIGKILL');
  });

  it('throws a clean error when docker is missing', async () => {
    const spawn = fakeSpawn((child) => child.emit('error', new Error('spawn docker ENOENT')));
    await expect(runSandboxed(baseOpts, spawn)).rejects.toBeInstanceOf(SandboxError);
  });
});
