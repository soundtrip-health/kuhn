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
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
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
};
