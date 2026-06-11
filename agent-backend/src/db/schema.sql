-- Story 010: Agent backend database schema
-- Idempotent — safe to run on every server start

-- ============================================================
-- Agents
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
  id            SERIAL PRIMARY KEY,
  slug          VARCHAR(32)  NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  description   TEXT,
  system_prompt TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ============================================================
-- Tools
-- ============================================================
CREATE TABLE IF NOT EXISTS tools (
  id                SERIAL PRIMARY KEY,
  slug              VARCHAR(64)  NOT NULL UNIQUE,
  name              VARCHAR(128) NOT NULL,
  description       TEXT,
  parameter_schema  JSONB,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
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
-- Projects
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id            SERIAL PRIMARY KEY,
  -- Tenant column (story 018). Single default tenant until auth lands;
  -- multi-tenancy then becomes auth + quotas instead of a schema rewrite.
  owner_id      VARCHAR(64)  NOT NULL DEFAULT 'default',
  name          VARCHAR(256) NOT NULL,
  project_type  VARCHAR(32)  NOT NULL CHECK (project_type IN (
                  'rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'
                )),
  config        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  root_path     TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Idempotent migration for databases created before story 018
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  owner_id VARCHAR(64) NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);

-- ============================================================
-- Conversations
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  agent_slug  VARCHAR(32) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_project
  ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent
  ON conversations(agent_slug);

-- ============================================================
-- Jobs (durable agent task records — story 011)
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
  id               SERIAL PRIMARY KEY,
  project_id       INTEGER     REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id  INTEGER     REFERENCES conversations(id) ON DELETE SET NULL,
  parent_job_id    INTEGER     REFERENCES jobs(id) ON DELETE SET NULL,
  role             VARCHAR(32) NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending', 'running', 'done', 'error', 'interrupted', 'cancelled'
                   )),
  input            TEXT        NOT NULL,
  context          JSONB,
  session_id       VARCHAR(128),
  error            TEXT,
  input_tokens     INTEGER     NOT NULL DEFAULT 0,
  output_tokens    INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_project
  ON jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status
  ON jobs(status);

-- ============================================================
-- Messages (append-only — no updated_at)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id                SERIAL PRIMARY KEY,
  conversation_id   INTEGER     NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role              VARCHAR(16) NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content           TEXT,
  tool_calls        JSONB,
  tool_call_id      VARCHAR(128),
  token_count       INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);
