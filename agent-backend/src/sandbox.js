// Story 018: sandboxed execution for anything that runs document-derived
// code. Typst/Pandoc rendering goes through here today; future analyst
// Python execution must use the same wrapper. Invariants: no network,
// project mounted read-only, separate write-only output dir, CPU/memory/
// time limits, size-capped output. The backend treats everything that comes
// out of the sandbox as untrusted.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from './config.js';
import { resolveSafe } from './storage.js';

export class SandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxError';
    this.code = code; // 'timeout' | 'failed' | 'output_too_large'
  }
}

export function buildDockerArgs({ image, cmd, projectDir, outDir }) {
  return [
    'run', '--rm',
    '--network', 'none',
    '--cpus', config.sandbox.cpus,
    '--memory', config.sandbox.memory,
    '--pids-limit', '256',
    '-v', `${projectDir}:/work:ro`,
    ...(outDir ? ['-v', `${outDir}:/out`] : []),
    '-w', '/work',
    image,
    ...cmd,
  ];
}

/**
 * Run a command in the sandbox container. Resolves with
 * { exitCode, stdout, stderr, truncated }; throws SandboxError('timeout')
 * if the time limit is hit (the container is killed).
 *
 * @param {object} opts - { image, cmd, projectDir, outDir?, timeoutMs?, maxOutputBytes? }
 * @param {Function} [spawnImpl] - injectable for tests
 */
export function runSandboxed(opts, spawnImpl = spawn) {
  const {
    image, cmd, projectDir, outDir = null,
    timeoutMs = config.sandbox.timeoutMs,
    maxOutputBytes = config.sandbox.maxOutputBytes,
  } = opts;

  const args = buildDockerArgs({ image, cmd, projectDir, outDir });

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const capture = (current, chunk) => {
      const remaining = maxOutputBytes - (stdout.length + stderr.length);
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      const text = chunk.toString('utf-8');
      if (text.length > remaining) truncated = true;
      return current + text.slice(0, remaining);
    };

    child.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(new SandboxError('failed', `Failed to start sandbox: ${err.message}`));
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new SandboxError('timeout', `Sandbox timed out after ${timeoutMs}ms`));
        return;
      }
      resolvePromise({ exitCode, stdout, stderr, truncated });
    });
  });
}

/**
 * Run a renderer over a project source file and return the produced output
 * file. Validates the source path through the storage service, mounts the
 * project read-only, and collects one output file from the sandbox's
 * write-only /out dir.
 */
async function renderViaSandbox(projectId, sourcePath, { image, makeCmd, outputName }, spawnImpl) {
  const { root, abs } = await resolveSafe(projectId, sourcePath);
  await stat(abs).catch(() => {
    throw new SandboxError('failed', `No such source file: ${sourcePath}`);
  });
  const sourceRel = abs === root ? '.' : abs.slice(root.length + 1);

  // Output dirs live under the projects root, not os.tmpdir(): on macOS,
  // Docker Desktop cannot bind-mount /tmp unless it is on the shared-paths
  // list, while the projects root must already be mountable.
  const renderTmpRoot = join(config.agent.projectsRoot, '.render-tmp');
  await mkdir(renderTmpRoot, { recursive: true });
  const outDir = await mkdtemp(join(renderTmpRoot, 'render-'));
  try {
    const result = await runSandboxed({
      image,
      cmd: makeCmd(`/work/${sourceRel}`, `/out/${outputName}`),
      projectDir: root,
      outDir,
    }, spawnImpl);

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).slice(0, 4000);
      throw new SandboxError('failed', `Render failed (exit ${result.exitCode}): ${detail}`);
    }

    const outPath = join(outDir, outputName);
    const outStat = await stat(outPath).catch(() => {
      throw new SandboxError('failed', 'Renderer produced no output file');
    });
    if (outStat.size > config.sandbox.maxOutputBytes) {
      throw new SandboxError('output_too_large', `Output exceeds ${config.sandbox.maxOutputBytes} bytes`);
    }
    return { output: await readFile(outPath), stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** Compile a Typst source file in the project to PDF. Returns { output, stdout, stderr }. */
export function renderTypstPdf(projectId, sourcePath, spawnImpl) {
  return renderViaSandbox(projectId, sourcePath, {
    image: config.sandbox.typstImage,
    makeCmd: (src, out) => ['compile', src, out],
    outputName: 'output.pdf',
  }, spawnImpl);
}

/**
 * Convert a project file with Pandoc (e.g. markdown → docx/tex). Returns
 * { output, stdout, stderr }. extraArgs are long-form pandoc options composed
 * by the render service (never user input); values may only reference /work
 * paths since that is the only readable mount.
 */
export function pandocConvert(projectId, sourcePath, outputName, extraArgs = [], spawnImpl) {
  if (!/^[\w.-]+$/.test(outputName)) {
    throw new SandboxError('failed', `Invalid output name: ${outputName}`);
  }
  for (const arg of extraArgs) {
    if (!/^--[\w-]+(=[\w./ @-]+)?$/.test(arg)) {
      throw new SandboxError('failed', `Invalid pandoc argument: ${arg}`);
    }
  }
  return renderViaSandbox(projectId, sourcePath, {
    image: config.sandbox.pandocImage,
    makeCmd: (src, out) => [src, ...extraArgs, '-o', out],
    outputName,
  }, spawnImpl);
}
