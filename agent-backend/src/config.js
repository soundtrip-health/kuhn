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
  // Agent runtime selector (STH-47 preview). 'claude' (default) keeps the
  // Claude Agent SDK path exactly as before; 'pi' routes every agent task
  // through the Pi AgentRuntime adapter with an explicit provider/model
  // configuration below. There is no silent fallback: a misconfigured 'pi'
  // selection fails the task with the Pi failure — it never quietly runs
  // Claude. Switching back is an explicit operator change of this variable.
  agentRuntime: {
    kind: (process.env.KUHN_AGENT_RUNTIME || 'claude').trim().toLowerCase(),
    // Explicit Pi preview configuration. Kuhn's per-agent Claude model ids
    // (agents.model) are deliberately NOT reinterpreted as Pi model ids;
    // this model is the one the Pi preview actually runs.
    pi: {
      // Provider path: 'openrouter' | 'openai' | 'openai-compatible'.
      provider: (process.env.KUHN_PI_PROVIDER || 'openrouter').trim().toLowerCase(),
      // The Pi model id to run (e.g. 'openai/gpt-oss-20b' on OpenRouter).
      model: process.env.KUHN_PI_MODEL || '',
      // Required for the 'openai-compatible' path (vLLM/Ollama/LiteLLM/...).
      baseUrl: process.env.KUHN_PI_BASE_URL || '',
      // Explicitly named credential environment variable. Defaults per
      // provider when unset (OPENROUTER_API_KEY / OPENAI_API_KEY /
      // OPENAI_COMPATIBLE_API_KEY); credentials are never reinterpreted.
      apiKeyEnv: process.env.KUHN_PI_API_KEY_ENV || '',
    },
  },
  cors: {
    // Comma-separated allowlist; the webapp dev server is pinned to 5174
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5174')
      .split(',').map((s) => s.trim()),
  },
  webapp: {
    // Built webapp to serve at / alongside the API (single-port deployment).
    // Served only when the directory contains an index.html; set
    // KUHN_WEBAPP_DIST to another build, or to '' to disable serving.
    dist: process.env.KUHN_WEBAPP_DIST
      ?? new URL('../../webapp/dist', import.meta.url).pathname,
  },
  auth: {
    // 'dev' (default): x-kuhn-user header / seeded dev user, no login needed —
    // local development and the token-free check scripts. Anything else
    // (canonically 'magic-link') requires a session cookie on every request
    // and a KUHN_SESSION_SECRET at startup (story 007-002).
    mode: process.env.KUHN_AUTH_MODE || 'dev',
    // HMAC key for session-cookie signatures. Required outside dev mode.
    sessionSecret: process.env.KUHN_SESSION_SECRET || '',
    // Magic-link token lifetime (single-use) and session lifetime.
    tokenTtlMs: parseInt(process.env.KUHN_AUTH_TOKEN_TTL_MS || String(15 * 60 * 1000)),
    sessionTtlMs: parseInt(process.env.KUHN_SESSION_TTL_MS || String(30 * 24 * 60 * 60 * 1000)),
    // Invitation-link lifetime (story 011-002).
    inviteTtlMs: parseInt(process.env.KUHN_INVITE_TTL_MS || String(7 * 24 * 60 * 60 * 1000)),
    // Platform super-admins (story 011-001): comma-separated emails synced to
    // users.is_superadmin at every boot (flips both ways). Dev mode defaults
    // to the dev user so the create-org flow keeps working locally; outside
    // dev there is no default — nobody is a super-admin unless listed.
    superadminEmails: (
      process.env.KUHN_SUPERADMIN_EMAILS
        ?? ((process.env.KUHN_AUTH_MODE || 'dev') === 'dev'
          ? (process.env.DEV_USER_EMAIL || 'dev@kuhn.local')
          : '')
    ).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    // Where /api/auth/verify redirects after setting the cookie (the webapp).
    appUrl: process.env.KUHN_APP_URL || 'http://localhost:5174',
    // smtp[s]://user:pass@host:port — empty logs magic links to the server
    // console instead of sending mail (the dev transport).
    smtpUrl: process.env.KUHN_SMTP_URL || '',
    mailFrom: process.env.KUHN_MAIL_FROM || 'Kuhn <login@kuhn.local>',
    // Rate limits on POST /api/auth/request-link — the one unauthenticated
    // endpoint that sends mail and writes rows (STH-35). Two keys, because
    // they stop different things:
    //   perEmail — how often ONE address can be mailed. This is the limit
    //     that matters: it is keyed on the victim, so it cannot be sidestepped
    //     and it is what stops the endpoint being used to flood someone's
    //     inbox. Three in a token lifetime is already generous.
    //   perIp — how many attempts one client may make, whatever addresses it
    //     names. Best-effort only (see docs/deployment.md): req.ip comes from
    //     X-Forwarded-For under `trust proxy`, so a determined attacker can
    //     rotate it. Set generously — a whole institution can share one NAT
    //     address — and treat it as a guard against noise, not adversaries.
    requestLink: {
      perEmailMax: parseInt(process.env.KUHN_LOGIN_MAX_PER_EMAIL || '3'),
      perEmailWindowMs: parseInt(process.env.KUHN_LOGIN_EMAIL_WINDOW_MS || String(15 * 60 * 1000)),
      perIpMax: parseInt(process.env.KUHN_LOGIN_MAX_PER_IP || '20'),
      perIpWindowMs: parseInt(process.env.KUHN_LOGIN_IP_WINDOW_MS || String(60 * 60 * 1000)),
    },
  },
  agent: {
    // Root directory under which per-project workspaces live; agent file
    // access is confined to <projectsRoot>/<projectId> (or projects.root_path)
    projectsRoot: process.env.PROJECTS_ROOT || join(dataDir, 'files'),
    // Per-task token budget (input + output across all turns, shared by the
    // whole dispatch tree). Denominated in root-agent-tier tokens: sub-agent
    // usage is weighted by relative model cost (story 020) — see modelWeights.
    // 2.5M default so a full seeding tree plus follow-on work comfortably fits.
    tokenBudget: parseInt(process.env.AGENT_TOKEN_BUDGET || '2500000'),
    // Grace margin applied to the hard cut-off: an in-flight task may run up to
    // budgetGrace× the budget before it is interrupted, so the user can finish
    // the current piece of work instead of being cut off abruptly at the limit.
    budgetGrace: parseFloat(process.env.AGENT_TOKEN_BUDGET_GRACE || '1.1'),
    // Approximate model price ratios for budget weighting, matched by
    // substring of the model id. Override with AGENT_MODEL_WEIGHTS, e.g.
    // "haiku:1,sonnet:3,opus:5,default:5". Rough is fine (story 020).
    modelWeights: parseModelWeights(process.env.AGENT_MODEL_WEIGHTS),
    // Max nested dispatch depth (writer -> research is depth 1)
    maxDispatchDepth: parseInt(process.env.AGENT_MAX_DISPATCH_DEPTH || '2'),
    // How long ask_user waits for a reply before proceeding. Default null =
    // wait indefinitely (if the PI steps away, the question just waits). Set
    // AGENT_QUESTION_TIMEOUT_MS to a number to re-enable an auto-default.
    questionTimeoutMs: process.env.AGENT_QUESTION_TIMEOUT_MS
      ? parseInt(process.env.AGENT_QUESTION_TIMEOUT_MS)
      : null,
    // Global fallback model, used only when an agent's model is NULL. Per-agent
    // models (agents.model, story 021) win and are set in db/seed.sql.
    model: process.env.AGENT_MODEL || undefined,
    // Transient model-provider error handling (story 029). A 529 Overloaded /
    // 429 / 5xx from the API is upstream and stateless, so the runtime retries
    // the SDK query (resuming the session) with exponential backoff + jitter
    // before surfacing a terminal error. The underlying SDK retries shallowly
    // (~2); this is the outer net for a sustained capacity event.
    retry: {
      maxAttempts: parseInt(process.env.AGENT_RETRY_MAX_ATTEMPTS || '5'),
      baseDelayMs: parseInt(process.env.AGENT_RETRY_BASE_MS || '1500'),
      maxDelayMs: parseInt(process.env.AGENT_RETRY_MAX_MS || '30000'),
    },
  },
  storage: {
    // Per-file size cap for reads, writes, and uploads
    maxFileBytes: parseInt(process.env.STORAGE_MAX_FILE_BYTES || String(20 * 1024 * 1024)),
    // Root for org-scoped content (story 006-001): the org knowledge library
    // lives at <orgsRoot>/<orgId>/library, behind the same containment
    // enforcement as project workspaces.
    orgsRoot: process.env.ORGS_ROOT || join(dataDir, 'orgs'),
  },
  history: {
    // Story 008-002: per-project git version history. Disabled only for
    // environments without a git binary (KUHN_HISTORY_ENABLED=false).
    enabled: (process.env.KUHN_HISTORY_ENABLED ?? 'true') !== 'false',
    // Trailing-throttle window for coalescing autosave/agent-burst commits:
    // the first change in a window schedules a commit, later changes ride
    // along — at most one autosave commit per window, bounded latency.
    autoCommitMs: parseInt(process.env.KUHN_HISTORY_AUTOCOMMIT_MS || '120000'),
  },
  projectEvents: {
    // Cap on concurrent SSE subscribers per project (story 005-001) — a
    // runaway-tab backstop, not a scaling knob.
    maxSubscribers: parseInt(process.env.PROJECT_EVENTS_MAX_SUBSCRIBERS || '20'),
  },
  knowledge: {
    // Kuhn-curated knowledge catalog (issue #65): guidance-docs/catalog.json
    // plus the package content it points at, shipped in the repo tree and
    // read-only at runtime. Deploys must ship guidance-docs/ alongside the
    // backend (or point this elsewhere).
    catalogRoot: process.env.KUHN_GUIDANCE_DOCS
      || new URL('../../guidance-docs', import.meta.url).pathname,
  },
  scripts: {
    // Kuhn-curated shared-script catalog (issue #68): shared-scripts/
    // catalog.json plus the script files it points at, shipped in the repo
    // tree and read-only at runtime — same deployment contract as the
    // knowledge catalog above.
    catalogRoot: process.env.KUHN_SHARED_SCRIPTS
      || new URL('../../shared-scripts', import.meta.url).pathname,
    // Scripts are code text: small, diffable, stored in the DB.
    maxScriptBytes: parseInt(process.env.SCRIPTS_MAX_BYTES || String(256 * 1024)),
  },
  ingest: {
    // Org-library ingestion bounds (story 006-002). Chunk sizes are in
    // characters (~4 chars/token: target ≈800 tokens, hard cap ≈1100).
    maxPdfPages: parseInt(process.env.INGEST_MAX_PDF_PAGES || '200'),
    minTextChars: parseInt(process.env.INGEST_MIN_TEXT_CHARS || '20'),
    chunkTargetChars: parseInt(process.env.INGEST_CHUNK_TARGET_CHARS || '3200'),
    chunkMaxChars: parseInt(process.env.INGEST_CHUNK_MAX_CHARS || '4400'),
  },
  fileActivity: {
    // Per-project cap on retained file_events rows (story 005-002); oldest
    // pruned on insert. Badges only need the recent tail.
    maxEventsPerProject: parseInt(process.env.FILE_ACTIVITY_MAX_EVENTS || '1000'),
  },
  sandbox: {
    // Container images for document-derived code execution (Typst/Pandoc now,
    // analyst Python later). All sandbox runs: no network, project mounted
    // read-only, CPU/memory/time limits.
    typstImage: process.env.SANDBOX_TYPST_IMAGE || 'ghcr.io/typst/typst:latest',
    pandocImage: process.env.SANDBOX_PANDOC_IMAGE || 'pandoc/core:latest',
    // PDF text extraction for org-library ingestion (story 006-002)
    popplerImage: process.env.SANDBOX_POPPLER_IMAGE || 'minidocks/poppler:latest',
    timeoutMs: parseInt(process.env.SANDBOX_TIMEOUT_MS || '60000'),
    cpus: process.env.SANDBOX_CPUS || '1',
    memory: process.env.SANDBOX_MEMORY || '512m',
    // Cap on captured stdout/stderr and on produced output files
    maxOutputBytes: parseInt(process.env.SANDBOX_MAX_OUTPUT_BYTES || String(32 * 1024 * 1024)),
    // Issue #68b: the analyst run_script runtime. A Kuhn-BUILT image
    // (docker/r-analysis/Dockerfile — rocker/r-ver + a curated package set),
    // not pulled from a registry: with --network none there are no runtime
    // package installs, so "install a package" means extending that
    // Dockerfile and rebuilding.
    rscriptImage: process.env.SANDBOX_R_IMAGE || 'kuhn/r-analysis:latest',
    // Script runs get their own limits — a GAMM fit outgrows the render
    // defaults above (60 s / 512 MB). All env-overridable.
    script: {
      timeoutMs: parseInt(process.env.SCRIPT_TIMEOUT_MS || '300000'),
      cpus: process.env.SCRIPT_CPUS || '2',
      memory: process.env.SCRIPT_MEMORY || '2g',
      maxOutputBytes: parseInt(process.env.SCRIPT_MAX_OUTPUT_BYTES || String(64 * 1024 * 1024)),
      // Concurrency cap on sandbox fan-out (threat model T-22): script runs
      // queue behind this in-process semaphore.
      maxConcurrent: parseInt(process.env.SCRIPT_MAX_CONCURRENT || '2'),
      maxOutputFiles: parseInt(process.env.SCRIPT_MAX_OUTPUT_FILES || '50'),
    },
  },
};
