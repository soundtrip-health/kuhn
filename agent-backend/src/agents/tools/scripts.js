/**
 * Kuhn sandboxed-script tools (STH-1): list_scripts + run_script, the two
 * runtime tools under the one `run_script` DB slug (analyst-only in
 * seed-data). Extracted from the Claude SDK construction in runtime.js —
 * provider-neutral.
 *
 * Issue #68b: the deterministic path's execution half. The org is derived
 * server-side from the project (as with search_org_knowledge); the image
 * and interpreter argv are composed inside sandbox.js — the model chooses
 * only WHICH script and its arguments.
 */

import { config } from '../../config.js';
import { getProject } from '../../db/projects.js';
import { getOrgScript, getScriptVersion, listOrgScripts } from '../../db/org-scripts.js';
import { recordScriptRun } from '../../db/script-runs.js';
import { SandboxError, RUNNABLE_LANGUAGES, runScriptSandboxed } from '../../sandbox.js';
import { Semaphore } from '../../sandbox-semaphore.js';
import { writeProjectFile } from '../../storage.js';
import { publishProjectEvent } from '../../project-events.js';
import { toolOk, toolError } from './envelope.js';

// Lazy: the capacity knob lives in config.sandbox.script, which pinned test
// configs may not define at module-load time.
let scriptSemaphore = null;
function getScriptSemaphore() {
  if (!scriptSemaphore) {
    scriptSemaphore = new Semaphore(config.sandbox?.script?.maxConcurrent ?? 2);
  }
  return scriptSemaphore;
}

const SCRIPT_LANGUAGE_BY_EXT = { r: 'r', py: 'python' };

// Plain values and workspace-relative paths only: no whitespace, no shell
// metacharacters. Args ride AFTER the server-built interpreter argv, so they
// can never become docker flags; the regex keeps them boring anyway.
const SCRIPT_ARG_PATTERN = '^([\\w./=@,:-]+)$';

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createScriptTools(ctx) {
  const { projectId } = ctx;
  const { slug: agentSlug } = ctx.agent;
  const { id: jobId } = ctx.parentJob;
  let runSeq = 0;

  const resolveOrgId = async () => (await getProject(projectId))?.org_id ?? null;

  const tools = [];

  tools.push({
    name: 'list_scripts',
    grants: ['run_script'],
    readOnly: true,
    effect: 'read',
    description:
      "List the shared scripts in your organization's script library — known-good, versioned tools (the deterministic path). "
      + 'Prefer running one of these over rewriting the same analysis; check here before writing a new script.',
    parameters: { type: 'object' },
    execute: async () => {
      try {
        const orgId = await resolveOrgId();
        const scripts = orgId == null ? [] : listOrgScripts(orgId, { status: 'active' });
        if (scripts.length === 0) {
          return toolOk('The organization script library is empty. Write what you need in analyst/, and suggest promoting anything reusable.');
        }
        const text = scripts.map((s) => {
          const args = JSON.parse(s.args_json || '[]')
            .map((a) => `${a.name}${a.required ? ' (required)' : ''}${a.description ? ` — ${a.description}` : ''}`)
            .join('; ');
          const runnable = RUNNABLE_LANGUAGES.includes(s.language)
            ? '' : ` [${s.language}: not runnable in this deploy]`;
          return `- ${s.slug} (v${s.current_version}, ${s.language})${runnable}: ${s.title}`
            + (s.description ? ` — ${s.description}` : '')
            + (args ? `\n  args: ${args}` : '');
        }).join('\n');
        return toolOk(text);
      } catch (err) {
        return toolError(`list_scripts failed: ${err.message}`);
      }
    },
  });

  tools.push({
    name: 'run_script',
    grants: ['run_script'],
    readOnly: false,
    effect: 'external',
    description:
      'Run a script in the sandbox: a shared org script by slug (see list_scripts), or a project file by path while iterating before promotion. '
      + 'The sandbox has NO network and a read-only project mount; scripts read inputs via workspace-relative paths and write every output under $OUT_DIR. '
      + 'Outputs are copied into analyst/output/run-<id>/ and listed in the result.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Org script slug to run (current version)' },
        path: { type: 'string', description: 'Project-relative script file to run instead (e.g. analyst/fit.R)' },
        args: {
          type: 'array',
          items: {
            type: 'string',
            pattern: SCRIPT_ARG_PATTERN,
            patternMessage: 'plain values and workspace-relative paths only',
          },
          maxItems: 16,
          default: [],
          description: 'Arguments passed to the script',
        },
      },
    },
    execute: async (_id, { script, path, args }) => {
      const errorResult = (text) => toolError(text);
      if ((script == null) === (path == null)) {
        return errorResult('Pass exactly one of `script` (org slug) or `path` (project file).');
      }

      // Resolve what to run — language, content/location, provenance refs.
      let language;
      let run;
      let provenance;
      try {
        if (script != null) {
          const orgId = await resolveOrgId();
          const orgScript = orgId == null ? null : getOrgScript(orgId, script);
          if (!orgScript || orgScript.status !== 'active') {
            return errorResult(`No active org script "${script}". Use list_scripts to see the library.`);
          }
          language = orgScript.language;
          if (!RUNNABLE_LANGUAGES.includes(language)) {
            return errorResult(`"${script}" is ${language}, which this deploy cannot run yet (R only).`);
          }
          const version = getScriptVersion(orgId, orgScript.id, null);
          run = { language, entrypoint: version.entrypoint, scriptContent: version.content, args };
          provenance = { orgScriptId: orgScript.id, scriptVersion: version.version };
        } else {
          const ext = (path.split('.').pop() ?? '').toLowerCase();
          language = SCRIPT_LANGUAGE_BY_EXT[ext];
          if (!language) {
            return errorResult(`${path} is not a runnable script (expected .R or .py).`);
          }
          if (!RUNNABLE_LANGUAGES.includes(language)) {
            return errorResult(`${path} is ${language}, which this deploy cannot run yet (R only). Write the analysis in R, or ask the user to request a ${language} runtime.`);
          }
          run = { language, entrypoint: null, scriptRelPath: path, args };
          provenance = { scriptPath: path };
        }
      } catch (err) {
        return errorResult(`run_script failed: ${err.message}`);
      }

      runSeq += 1;
      const outputDir = `analyst/output/run-${jobId}-${runSeq}`;
      const record = (fields) => recordScriptRun({
        projectId: Number(projectId), jobId, args, ...provenance, ...fields,
      });

      let result;
      try {
        result = await getScriptSemaphore().run(() => runScriptSandboxed(projectId, run));
      } catch (err) {
        if (err instanceof SandboxError) {
          const status = err.code === 'timeout' ? 'timeout' : 'failed';
          record({ status, stderr: err.message });
          return errorResult(`run_script ${status}: ${err.message}`);
        }
        record({ status: 'failed', stderr: err.message });
        throw err;
      }

      // Copy outputs into the project through the storage chokepoint; each
      // copied file gets a real file_change so badges/activity/history all
      // see it (analyst/output/** is outside draft/**, so no suggestion gate).
      const copied = [];
      const copyFailures = [];
      for (const output of result.outputs) {
        const dest = `${outputDir}/${output.path}`;
        try {
          await writeProjectFile(projectId, dest, output.buffer);
          copied.push(dest);
          const event = { type: 'file_change', agent: agentSlug, path: dest, kind: 'create' };
          // Direct publish + channel mirror (the move_file pattern): the hub
          // dedupes the object, and sub-agent runs persist activity too.
          try {
            publishProjectEvent(projectId, event, { jobId });
          } catch { /* activity loss must not fail the run */ }
          ctx.channel.push(event);
        } catch (err) {
          copyFailures.push(`${dest}: ${err.message}`);
        }
      }

      const status = result.exitCode === 0 ? 'ok' : 'error';
      record({
        status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputDir: copied.length > 0 ? outputDir : null,
        stdout: result.stdout,
        stderr: result.stderr,
      });

      const tail = (text) => (text && text.length > 16384 ? `…${text.slice(-16384)}` : text);
      const lines = [
        `exit code ${result.exitCode} (${Math.round(result.durationMs / 1000)}s)`,
        copied.length > 0 ? `outputs (${copied.length}):\n${copied.map((p) => `  ${p}`).join('\n')}` : 'no output files',
      ];
      if (result.skippedOutputs > 0) lines.push(`${result.skippedOutputs} output file(s) skipped (count/size cap)`);
      if (copyFailures.length > 0) lines.push(`copy failures:\n${copyFailures.map((f) => `  ${f}`).join('\n')}`);
      if (result.stdout) lines.push(`stdout:\n${tail(result.stdout)}`);
      if (result.stderr) lines.push(`stderr:\n${tail(result.stderr)}`);
      if (result.truncated) lines.push('(stdout/stderr truncated at the sandbox output cap)');
      return status === 'ok'
        ? toolOk(lines.join('\n\n'))
        : toolError(lines.join('\n\n'));
    },
  });

  return tools;
}
