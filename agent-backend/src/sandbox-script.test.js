// Issue #68b: runScriptSandboxed — script materialization, mounts, output
// collection, and error mapping. Real in-memory SQLite (resolveProjectDir
// reads the projects table) with a fake docker whose "container" writes into
// the real host outDir the args name.

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config;
let sandbox;
let projectsRoot;
let savedRoot;

/** Fake docker: `handler(child, args)` runs after spawn; args are the docker argv. */
function fakeSpawn(handler) {
  const calls = [];
  const impl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit('close', null));
    calls.push({ command, args, child });
    setImmediate(() => { void handler(child, args); });
    return child;
  };
  impl.calls = calls;
  return impl;
}

beforeAll(async () => {
  ({ config } = await import('./config.js'));
  savedRoot = config.agent.projectsRoot;
  projectsRoot = await mkdtemp(join(tmpdir(), 'kuhn-sandbox-script-'));
  config.agent.projectsRoot = projectsRoot;

  const { exec, querySync } = await import('./db.js');
  exec(readFileSync(resolve(__dirname, 'db/schema.sql'), 'utf-8'));
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Lab', 'lab')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (1, 1, 'P', 'manuscript')");
  await mkdir(join(projectsRoot, '1', 'analyst'), { recursive: true });
  await writeFile(join(projectsRoot, '1', 'analyst', 'local.R'), 'x <- 1\n');

  sandbox = await import('./sandbox.js');
});

afterAll(async () => {
  config.agent.projectsRoot = savedRoot;
  await rm(projectsRoot, { recursive: true, force: true });
});

describe('runScriptSandboxed', () => {
  it('materializes org-script content into a read-only /script mount and collects outputs', async () => {
    const spawn = fakeSpawn(async (child, args) => {
      // The "script" reads its own mounted source and writes two outputs.
      const scriptHost = args.find((a) => a.endsWith(':/script:ro')).split(':')[0];
      expect((await readFile(join(scriptHost, 'fit.R'), 'utf-8'))).toBe('library(mgcv)\n');
      const outHost = args.find((a) => a.endsWith(':/out')).split(':')[0];
      await mkdir(join(outHost, 'figures'), { recursive: true });
      await writeFile(join(outHost, 'summary.csv'), 'a,b\n1,2\n');
      await writeFile(join(outHost, 'figures', 'plot.png'), Buffer.from([1, 2, 3]));
      child.stdout.emit('data', Buffer.from('fitted\n'));
      child.emit('close', 0);
    });

    const result = await sandbox.runScriptSandboxed(1, {
      language: 'r',
      entrypoint: 'fit.R',
      scriptContent: 'library(mgcv)\n',
      args: ['--input', 'data.csv'],
    }, spawn);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('fitted\n');
    expect(result.outputs.map((o) => o.path).sort()).toEqual(['figures/plot.png', 'summary.csv']);
    expect(result.outputs.find((o) => o.path === 'summary.csv').buffer.toString()).toBe('a,b\n1,2\n');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const { args } = spawn.calls[0];
    expect(args.join(' ')).toContain('--network none');
    expect(args.join(' ')).toContain('-e OUT_DIR=/out');
    expect(args.join(' ')).toContain(`--cpus ${config.sandbox.script.cpus}`);
    // interpreter argv is server-built; caller args ride after the entrypoint
    const rscript = args.indexOf('Rscript');
    expect(args[rscript + 1]).toBe('/script/fit.R');
    expect(args.slice(rscript + 2)).toEqual(['--input', 'data.csv']);
  });

  it('runs a project-local script from /work without a /script mount', async () => {
    const spawn = fakeSpawn((child) => child.emit('close', 0));
    const result = await sandbox.runScriptSandboxed(1, {
      language: 'r',
      scriptRelPath: 'analyst/local.R',
    }, spawn);
    expect(result.exitCode).toBe(0);
    const { args } = spawn.calls[0];
    expect(args.some((a) => typeof a === 'string' && a.endsWith(':/script:ro'))).toBe(false);
    const rscript = args.indexOf('Rscript');
    expect(args[rscript + 1]).toBe('/work/analyst/local.R');
  });

  it('returns nonzero exits (with stderr) instead of throwing', async () => {
    const spawn = fakeSpawn((child) => {
      child.stderr.emit('data', Buffer.from('Error in read.csv: no such file'));
      child.emit('close', 1);
    });
    const result = await sandbox.runScriptSandboxed(1, {
      language: 'r', scriptRelPath: 'analyst/local.R',
    }, spawn);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no such file');
    expect(result.outputs).toEqual([]);
  });

  it('refuses unknown languages and missing project scripts', async () => {
    await expect(sandbox.runScriptSandboxed(1, { language: 'cobol', scriptRelPath: 'analyst/local.R' }))
      .rejects.toMatchObject({ name: 'SandboxError' });
    await expect(sandbox.runScriptSandboxed(1, { language: 'r', scriptRelPath: 'analyst/nope.R' }, fakeSpawn(() => {})))
      .rejects.toMatchObject({ name: 'SandboxError', code: 'failed' });
  });

  it('caps collected outputs at maxOutputFiles and reports the skipped count', async () => {
    const savedCap = config.sandbox.script.maxOutputFiles;
    config.sandbox.script.maxOutputFiles = 2;
    try {
      const spawn = fakeSpawn(async (child, args) => {
        const outHost = args.find((a) => a.endsWith(':/out')).split(':')[0];
        for (const name of ['a.csv', 'b.csv', 'c.csv', 'd.csv']) {
          await writeFile(join(outHost, name), name);
        }
        child.emit('close', 0);
      });
      const result = await sandbox.runScriptSandboxed(1, {
        language: 'r', scriptRelPath: 'analyst/local.R',
      }, spawn);
      expect(result.outputs).toHaveLength(2);
      expect(result.skippedOutputs).toBe(2);
    } finally {
      config.sandbox.script.maxOutputFiles = savedCap;
    }
  });
});
