import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3002'),
  db: {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'kuhn',
    user: process.env.PGUSER || 'kuhn',
    password: process.env.PGPASSWORD || 'kuhn_dev',
  },
  cors: {
    // Comma-separated allowlist; the webapp dev server is pinned to 5174
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5174')
      .split(',').map((s) => s.trim()),
  },
  agent: {
    // Root directory under which per-project workspaces live; agent file
    // access is confined to <projectsRoot>/<projectId> (or projects.root_path)
    projectsRoot: process.env.PROJECTS_ROOT || new URL('../projects', import.meta.url).pathname,
    // Per-task token budget (input + output across all turns)
    tokenBudget: parseInt(process.env.AGENT_TOKEN_BUDGET || '250000'),
    // Max nested dispatch depth (writer -> research is depth 1)
    maxDispatchDepth: parseInt(process.env.AGENT_MAX_DISPATCH_DEPTH || '2'),
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
