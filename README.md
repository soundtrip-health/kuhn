# Kuhn

A web-based scientific and technical writing tool with integrated AI assistance.

Kuhn is a browser-based WYSIWYG markdown editor where AI agents deliver real-time help as you
write manuscripts, protocols, and grant applications. You author in friendly markdown with
BibTeX; the toolchain renders to PDF via Typst and exports to Word/LaTeX via Pandoc — so LaTeX
is an export target, never a prerequisite.

Current capabilities:

- **Agent-integrated editing** — six specialized agents (PM, Writer, Research Assistant,
  Advisor, Reviewer, Analyst) embedded in the editor, with token-streaming chat, mid-task
  questions, and transcript restore on reload.
- **Milkdown editor** — WYSIWYG markdown with Yjs real-time collaboration and a `/cite` slash
  command that inserts grounded references.
- **One-click project seeding** — a deterministic pipeline runs a PM interview → parallel
  research (Research Assistant + Advisor) → Writer skeleton draft.
- **Live preview & export** — PDF preview pane (markdown → Typst → PDF with citeproc citations)
  plus one-click docx/LaTeX export, all sandboxed.
- **Tenant-safe by design** — project-scoped storage, sandboxed execution, and per-tenant
  knowledge bases over a shared curated guidance corpus.

## Quick start

### Prerequisites

- Node.js 18+ — **use an LTS release** (e.g. 24). Node 26 currently fails to build the native
  `better-sqlite3` dependency.
- Docker (for sandboxed rendering/export only — the database is in-process SQLite).
- An `ANTHROPIC_API_KEY` (or Claude Code login credentials on a dev machine).

### Run it

From the repository root:

```bash
# Install everything (root orchestrator + both packages) — first time
npm install

# Configure backend credentials (first time)
cp agent-backend/.env.example agent-backend/.env   # then set ANTHROPIC_API_KEY

# Start backend (:3002) and webapp (:5174) together — Ctrl-C stops both
npm run dev
```

The root `package.json` is a dev-only orchestrator: its `postinstall` installs both packages,
so a single root `npm install` bootstraps the whole repository.

Open **http://localhost:5174**. On first run with an empty database, Kuhn creates a
"Demo Manuscript" project — click **Seed project** to run the full seeding pipeline (PM
interview → research → skeleton draft). Note that agent runs use real model quota.

The backend serves at **http://localhost:3002** (health check: `/health`). On startup it
creates the SQLite database, applies the schema, and seeds agents, tools, and assignments —
there is no database service to run. The database and uploaded project files live under
`KUHN_DATA_DIR` (default: repo-root `./data`) — `data/db/kuhn.sqlite` and
`data/files/<projectId>/`.

### Signing in

Authentication is controlled by `KUHN_AUTH_MODE` in `agent-backend/.env`:

- **`dev` (default)** — no login. Requests resolve to a seeded dev user and the sign-in
  screen never appears. Intended for local development and the token-free check scripts.
- **`magic-link`** — passwordless email login (requires `KUHN_SESSION_SECRET` at startup).
  A user enters their email on the sign-in screen and receives a single-use link (15-minute
  expiry); the first login creates the user in the default organization. With no
  `KUHN_SMTP_URL` configured, links are printed to the backend console
  (`[auth] Magic link for …`) instead of emailed. See
  [docs/deployment.md](docs/deployment.md) for the full configuration.

### Running the packages individually

Each package is independently installable and runnable; the root commands wrap them.

```bash
# Backend — http://localhost:3002
cd agent-backend
cp .env.example .env      # first time; set ANTHROPIC_API_KEY
npm install               # first time
npm run dev

# Webapp — http://localhost:5174 (pinned; the backend CORS allowlist includes it)
cd webapp
npm install               # first time
npm run dev               # backend must be running
```

See [webapp/README.md](webapp/README.md) for webapp-specific notes.

## Deployment

Kuhn deploys as a single Node.js process: the backend serves the API, the collaboration
WebSockets, and the built webapp on one port, behind any TLS-terminating proxy or tunnel.

```bash
npm install
npm run build      # builds the webapp; production builds call the API on the same origin
npm start          # serves everything on :3002
```

See [docs/deployment.md](docs/deployment.md) for the full guide: required environment
variables, Cloudflare Tunnel configuration, inviting users, and running as a service.

## Development

### Additional prerequisites

- Typst + Pandoc + Poppler sandbox images for rendering/export and org-library
  PDF ingestion (one-time: `docker pull ghcr.io/typst/typst:latest &&
  docker pull pandoc/core:latest && docker pull minidocks/poppler:latest`)
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

Render/export and any future analyst code execution run inside sandboxed Docker images (no
host Python environment required). Re-seed agents/tools after editing prompts or seed data
with `npm run db:seed` (from `agent-backend/`).

See [CLAUDE.md](CLAUDE.md) for contributor guidance (repository layout, where things live,
agent prompts, conventions). The repository is also configured so Claude Code can run common
read-only and build commands without prompting.

### Architecture

```
┌──────────────────────────────────────────────────┐
│                Browser (single app)               │
│  ┌───────────┐  ┌────────────────┐  ┌─────────┐  │
│  │ Agent     │  │ Milkdown       │  │ File    │  │
│  │ Chat      │  │ Editor (md)    │  │ Manager │  │
│  └─────┬─────┘  └───────┬────────┘  └────┬────┘  │
└────────┼────────────────┼────────────────┼───────┘
         │        WebSocket / REST         │
┌────────▼────────────────▼────────────────▼───────┐
│              Agent Backend (Node.js)              │
│  ┌─────────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Agent       │ │ Storage  │ │ Render/Export │  │
│  │ Runtime     │ │ API      │ │ (Typst,       │  │
│  │ (Claude     │ │ (project │ │  Pandoc,      │  │
│  │  Agent SDK) │ │  scoped) │ │  sandboxed)   │  │
│  └─────────────┘ └──────────┘ └───────────────┘  │
│           SQLite (file) · Yjs servers             │
└───────────────────────────────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for details and decision history.

Evaluating Kuhn for your organization? [docs/data-pipeline.md](docs/data-pipeline.md) lays
out where all data is stored and processed, what is ephemeral, what leaves the machine
(LLM provider, PubMed/arXiv, SMTP), and a production checklist.

### Agents

The six agents' system prompts live in
[`agent-backend/src/db/prompts/`](agent-backend/src/db/prompts/) and their models/tools in
`agent-backend/src/db/seed-data.js`; both are seeded into the database at startup, and the
runtime loads prompts from there.

### Project management

Public work is tracked through [GitHub issues](https://github.com/soundtrip-health/kuhn/issues)
and pull requests. The maintainers' epic/story planning record lives in a private companion
repository. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs, propose features,
and submit changes.

## License

[MIT](LICENSE).
