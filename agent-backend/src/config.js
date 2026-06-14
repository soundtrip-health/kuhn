import 'dotenv/config';
import { join } from 'node:path';

// Single data root: SQLite DB + uploaded project files both live under here,
// kept out of the source tree. Defaults to the repo-root ./data (gitignored).
const dataDir = process.env.KUHN_DATA_DIR
  || new URL('../../data', import.meta.url).pathname;

function parseModelWeights(env) {
  const weights = { haiku: 1, sonnet: 3, opus: 5, default: 5 };
  for (const pair of (env ?? '').split(',')) {
    const [key, value] = pair.split(':').map((s) => s.trim());
    if (key && Number.isFinite(parseFloat(value))) weights[key.toLowerCase()] = parseFloat(value);
  }
  return weights;
}

export const config = {
  port: parseInt(process.env.PORT || '3002'),
  // SQLite database file. In-process, no service to run; lives under the data dir.
  db: {
    path: process.env.KUHN_SQLITE_PATH || join(dataDir, 'db', 'kuhn.sqlite'),
  },
  cors: {
    // Comma-separated allowlist; the webapp dev server is pinned to 5174
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5174')
      .split(',').map((s) => s.trim()),
  },
  agent: {
    // Root directory under which per-project workspaces live; agent file
    // access is confined to <projectsRoot>/<projectId> (or projects.root_path)
    projectsRoot: process.env.PROJECTS_ROOT || join(dataDir, 'files'),
    // Per-task token budget (input + output across all turns, shared by the
    // whole dispatch tree). Denominated in root-agent-tier tokens: sub-agent
    // usage is weighted by relative model cost (story 020) — see modelWeights.
    // 500k default so the PM seeding tree (interview + RA + Advisor) fits.
    tokenBudget: parseInt(process.env.AGENT_TOKEN_BUDGET || '500000'),
    // Approximate model price ratios for budget weighting, matched by
    // substring of the model id. Override with AGENT_MODEL_WEIGHTS, e.g.
    // "haiku:1,sonnet:3,opus:5,default:5". Rough is fine (story 020).
    modelWeights: parseModelWeights(process.env.AGENT_MODEL_WEIGHTS),
    // Max nested dispatch depth (writer -> research is depth 1)
    maxDispatchDepth: parseInt(process.env.AGENT_MAX_DISPATCH_DEPTH || '2'),
    // How long ask_user waits for a reply before telling the agent to proceed
    // with defaults (story 012)
    questionTimeoutMs: parseInt(process.env.AGENT_QUESTION_TIMEOUT_MS || String(15 * 60 * 1000)),
    // Global fallback model, used only when an agent's model is NULL. Per-agent
    // models (agents.model, story 021) win and are set in db/seed.sql.
    model: process.env.AGENT_MODEL || undefined,
  },
  storage: {
    // Per-file size cap for reads, writes, and uploads
    maxFileBytes: parseInt(process.env.STORAGE_MAX_FILE_BYTES || String(20 * 1024 * 1024)),
  },
  sandbox: {
    // Container images for document-derived code execution (Typst/Pandoc now,
    // analyst Python later). All sandbox runs: no network, project mounted
    // read-only, CPU/memory/time limits.
    typstImage: process.env.SANDBOX_TYPST_IMAGE || 'ghcr.io/typst/typst:latest',
    pandocImage: process.env.SANDBOX_PANDOC_IMAGE || 'pandoc/core:latest',
    timeoutMs: parseInt(process.env.SANDBOX_TIMEOUT_MS || '60000'),
    cpus: process.env.SANDBOX_CPUS || '1',
    memory: process.env.SANDBOX_MEMORY || '512m',
    // Cap on captured stdout/stderr and on produced output files
    maxOutputBytes: parseInt(process.env.SANDBOX_MAX_OUTPUT_BYTES || String(32 * 1024 * 1024)),
  },
};
