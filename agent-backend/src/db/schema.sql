-- Kuhn agent backend database schema (SQLite).
-- Applied on every server start via db/init.js; CREATE ... IF NOT EXISTS makes
-- it idempotent. Timestamps are ISO-8601 UTC text (sorts chronologically).
-- The default-tenant rows and agent/tool seed live in db/seed-data.js.

-- ============================================================
-- Agents
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  system_prompt TEXT NOT NULL,
  -- Per-agent model id (story 021); NULL falls back to AGENT_MODEL / SDK default
  model         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- Tools
-- ============================================================
CREATE TABLE IF NOT EXISTS tools (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT,
  parameter_schema  TEXT,  -- JSON
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- Agent ↔ Tool assignments (many-to-many)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_tools (
  agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_id   INTEGER NOT NULL REFERENCES tools(id)  ON DELETE CASCADE,
  PRIMARY KEY (agent_id, tool_id)
);

-- ============================================================
-- Organizations / Users / Memberships (story 005)
--
-- A real tenant model: projects are owned by an organization; a user reaches
-- an org through a membership. Identity here is deliberately minimal — enough
-- to resolve a current user → org memberships — not a full auth provider. The
-- session middleware (src/session.js) maps a request to a users row; swapping
-- in SSO later means changing that resolver, not this schema.
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org  ON memberships(org_id);

-- ============================================================
-- Projects
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Legacy tenant column (story 018): a stable string handle. org_id is the
  -- live tenant scope every query filters on.
  owner_id      TEXT NOT NULL DEFAULT 'default',
  org_id        INTEGER REFERENCES organizations(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  project_type  TEXT NOT NULL CHECK (project_type IN (
                  'rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'
                )),
  config        TEXT NOT NULL DEFAULT '{}',  -- JSON
  root_path     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_org   ON projects(org_id);

-- ============================================================
-- Conversations
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  agent_slug  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_project
  ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent
  ON conversations(agent_slug);

-- ============================================================
-- Jobs (durable agent task records — story 011)
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id  INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  parent_job_id    INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  role             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending', 'running', 'done', 'error', 'interrupted', 'cancelled'
                   )),
  input            TEXT NOT NULL,
  context          TEXT,  -- JSON
  session_id       TEXT,
  error            TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_project
  ON jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status
  ON jobs(status);

-- ============================================================
-- Messages (append-only — no updated_at)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content           TEXT,
  tool_calls        TEXT,  -- JSON
  tool_call_id      TEXT,
  token_count       INTEGER,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);

-- ============================================================
-- References (story: references in SQLite). Per-project bibliography store —
-- canonical source for citations; draft/references.bib is derived from this.
-- ============================================================
CREATE TABLE IF NOT EXISTS bib_references (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cite_key         TEXT NOT NULL,
  entry_type       TEXT NOT NULL DEFAULT 'article',
  title            TEXT NOT NULL,
  authors_json     TEXT NOT NULL DEFAULT '[]',  -- JSON array of {family, given}
  year             INTEGER,
  journal          TEXT,
  volume           TEXT,
  issue            TEXT,
  pages            TEXT,
  publisher        TEXT,
  doi              TEXT,
  pmid             TEXT,
  pmcid            TEXT,
  url              TEXT,
  abstract         TEXT,
  source_type      TEXT,  -- 'pubmed' | 'arxiv' | 'web' | 'manual'
  identity_status  TEXT NOT NULL DEFAULT 'weak' CHECK (identity_status IN ('strong', 'weak')),
  weak_id_hash     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_project_key  ON bib_references(project_id, cite_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_project_doi  ON bib_references(project_id, doi)  WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_project_pmid ON bib_references(project_id, pmid) WHERE pmid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refs_project_weak ON bib_references(project_id, weak_id_hash);
