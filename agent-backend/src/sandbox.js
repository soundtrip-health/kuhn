// Story 018: sandboxed execution for anything that runs document-derived
// code. Typst/Pandoc rendering goes through here today; future analyst
// Python execution must use the same wrapper. Invariants: no network,
// project mounted read-only, separate write-only output dir, CPU/memory/
// time limits, size-capped output. The backend treats everything that comes
// out of the sandbox as untrusted.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { config } from './config.js';
import { resolveSafe } from './storage.js';

export class SandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxError';
    this.code = code; // 'timeout' | 'failed' | 'output_too_large'
  }
}

// Every value here is composed server-side (ADR 002 §6: no caller-selected
// images, mounts, or argv reach docker); `--network none` is unconditional.
export function buildDockerArgs({
  image, cmd, projectDir, outDir,
  extraMounts = [], env = {},
  cpus = config.sandbox.cpus, memory = config.sandbox.memory,
}) {
  return [
    'run', '--rm',
    '--network', 'none',
    '--cpus', cpus,
    '--memory', memory,
    '--pids-limit', '256',
    '-v', `${projectDir}:/work:ro`,
    ...(outDir ? ['-v', `${outDir}:/out`] : []),
    ...extraMounts.flatMap(({ hostDir, containerDir, readonly = true }) => [
      '-v', `${hostDir}:${containerDir}${readonly ? ':ro' : ''}`,
    ]),
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
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
    extraMounts, env, cpus, memory,
    timeoutMs = config.sandbox.timeoutMs,
    maxOutputBytes = config.sandbox.maxOutputBytes,
  } = opts;

  const args = buildDockerArgs({ image, cmd, projectDir, outDir, extraMounts, env, cpus, memory });

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
async function renderViaSandbox(projectId, sourcePath, { image, makeCmd, outputName, env, memory, timeoutMs, extraMounts }, spawnImpl) {
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
      env,
      memory,
      timeoutMs,
      extraMounts,
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

// STH-57: slide decks. The official Marp CLI image bundles Chromium; it gets
// more memory/time than the typst/pandoc defaults but the same isolation (no
// network, project read-only, write-only /out). MARP_USER maps the container
// user to the backend's uid so Chromium's output lands writable in /out.
// --allow-local-files lets Chromium read project images during conversion —
// with /work the only (read-only) mount and no network, that stays contained.
const MARP_FORMATS = {
  pdf: { flag: '--pdf', outputName: 'output.pdf' },
  pptx: { flag: '--pptx', outputName: 'export.pptx' },
  html: { flag: '--html', outputName: 'export.html' },
};

/**
 * Convert a project markdown file with Marp. Returns { output, stdout, stderr }.
 * STH-58: a resolved custom theme ({ themeName, themeCss }) is materialized
 * into its own read-only /themes mount (the org-library /script pattern) and
 * registered with --theme-set; the deck's `theme:` front matter picks it by
 * the CSS's `@theme` name.
 */
export async function renderMarp(projectId, sourcePath, format, { themeName = null, themeCss = null } = {}, spawnImpl) {
  const spec = MARP_FORMATS[format];
  if (!spec) {
    throw new SandboxError('failed', `No marp output format: ${format}`);
  }
  const extraMounts = [];
  const extraArgs = [];
  let themeDir = null;
  if (themeCss != null) {
    // Same placement rationale as .render-tmp (macOS bind-mount shared paths).
    const themeTmpRoot = join(config.agent.projectsRoot, '.theme-tmp');
    await mkdir(themeTmpRoot, { recursive: true });
    themeDir = await mkdtemp(join(themeTmpRoot, 'theme-'));
    await writeFile(join(themeDir, `${themeName}.css`), themeCss);
    extraMounts.push({ hostDir: themeDir, containerDir: '/themes', readonly: true });
    extraArgs.push('--theme-set', '/themes');
  }
  try {
    return await renderViaSandbox(projectId, sourcePath, {
      image: config.sandbox.marpImage,
      makeCmd: (src, out) => [spec.flag, '--allow-local-files', ...extraArgs, '-o', out, src],
      outputName: spec.outputName,
      env: { MARP_USER: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}` },
      memory: config.sandbox.marp.memory,
      timeoutMs: config.sandbox.marp.timeoutMs,
      extraMounts,
    }, spawnImpl);
  } finally {
    if (themeDir) await rm(themeDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Issue #68b: analyst script execution. Same wrapper, same invariants — no
// network, project read-only, /out the only writable mount — plus a second
// read-only mount, /script, when the code comes from the org script library
// (materialized to a temp dir) rather than from the project itself. The
// interpreter argv is keyed on the script's language server-side; the caller
// never chooses the image or the command.
// ---------------------------------------------------------------------------

const INTERPRETERS = {
  r: { image: () => config.sandbox.rscriptImage, argv: (entry) => ['Rscript', entry] },
};

/** Languages runScriptSandboxed can execute in this deploy. */
export const RUNNABLE_LANGUAGES = Object.keys(INTERPRETERS);

async function collectOutputs(outDir) {
  const { maxOutputFiles, maxOutputBytes } = config.sandbox.script;
  const outputs = [];
  let skipped = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const info = await stat(abs);
        if (outputs.length >= maxOutputFiles || info.size > maxOutputBytes) {
          skipped += 1;
          continue;
        }
        outputs.push({ path: relative(outDir, abs), buffer: await readFile(abs) });
      }
    }
  };
  await walk(outDir);
  return { outputs, skipped };
}

/**
 * Run one analyst script in the sandbox. Exactly one of `scriptContent`
 * (org-library code, materialized into a read-only /script mount) or
 * `scriptRelPath` (a project file, run in place from /work) is given.
 *
 * Unlike the render helpers, a nonzero exit does NOT throw — the caller wants
 * the stderr to hand back to the agent. Timeouts and docker failures still
 * throw SandboxError.
 *
 * @returns {Promise<{exitCode, stdout, stderr, truncated,
 *   outputs: Array<{path, buffer}>, skippedOutputs: number, durationMs: number}>}
 */
export async function runScriptSandboxed(projectId, {
  language, entrypoint, args = [], scriptContent = null, scriptRelPath = null,
}, spawnImpl) {
  const interpreter = INTERPRETERS[language];
  if (!interpreter) {
    throw new SandboxError('failed', `No sandbox runtime for language: ${language}`);
  }

  let root;
  let sourceRel = null;
  if (scriptRelPath != null) {
    const resolved = await resolveSafe(projectId, scriptRelPath);
    root = resolved.root;
    await stat(resolved.abs).catch(() => {
      throw new SandboxError('failed', `No such script file: ${scriptRelPath}`);
    });
    sourceRel = resolved.abs === root ? '.' : resolved.abs.slice(root.length + 1);
  } else {
    ({ root } = await resolveSafe(projectId, '.'));
  }

  // Same placement rationale as .render-tmp (macOS bind-mount shared paths).
  const scriptTmpRoot = join(config.agent.projectsRoot, '.script-tmp');
  await mkdir(scriptTmpRoot, { recursive: true });
  const workDir = await mkdtemp(join(scriptTmpRoot, 'run-'));
  const outDir = join(workDir, 'out');
  await mkdir(outDir);
  try {
    const extraMounts = [];
    let entryPath;
    if (scriptContent != null) {
      const scriptDir = join(workDir, 'script');
      await mkdir(scriptDir);
      await writeFile(join(scriptDir, entrypoint), scriptContent);
      extraMounts.push({ hostDir: scriptDir, containerDir: '/script', readonly: true });
      entryPath = `/script/${entrypoint}`;
    } else {
      entryPath = `/work/${sourceRel}`;
    }

    const limits = config.sandbox.script;
    const started = Date.now();
    const result = await runSandboxed({
      image: interpreter.image(),
      cmd: [...interpreter.argv(entryPath), ...args],
      projectDir: root,
      outDir,
      extraMounts,
      env: { OUT_DIR: '/out' },
      cpus: limits.cpus,
      memory: limits.memory,
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
    }, spawnImpl);
    const durationMs = Date.now() - started;

    const { outputs, skipped } = await collectOutputs(outDir);
    return { ...result, outputs, skippedOutputs: skipped, durationMs };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
