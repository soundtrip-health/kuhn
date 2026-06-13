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
  -- Per-agent model id (story 021); NULL falls back to AGENT_MODEL / SDK default
  model         VARCHAR(64),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Story 021: column addition for databases created before per-agent models
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model VARCHAR(64);

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
-- Organizations / Users / Memberships (story 005)
--
-- A real tenant model: projects are owned by an organization; a user reaches
-- an org through a membership. Identity here is deliberately minimal — enough
-- to resolve a current user → org memberships — not a full auth provider. The
-- session middleware (src/session.js) maps a request to a users row; swapping
-- in SSO later means changing that resolver, not this schema.
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(256) NOT NULL,
  slug        VARCHAR(128) NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(256) NOT NULL UNIQUE,
  display_name  VARCHAR(256),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org  ON memberships(org_id);

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

-- Story 005: org ownership. Added idempotently; the FK is created only once.
-- `owner_id` is retained as the legacy tenant column (a stable string handle);
-- `org_id` is the live tenant scope every query now filters on.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'projects_org_id_fkey' AND table_name = 'projects'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

-- ============================================================
-- Seed the default tenant + backfill (story 005)
--
-- Guarantees a non-orphaned baseline on both a fresh DB and an Epic-002-era DB:
-- a default organization, a dev user that owns it, and every pre-existing
-- project adopted into that org. All statements are idempotent.
-- ============================================================
INSERT INTO organizations (name, slug)
  VALUES ('Default Organization', 'default')
  ON CONFLICT (slug) DO NOTHING;

INSERT INTO users (email, display_name)
  VALUES ('dev@kuhn.local', 'Dev User')
  ON CONFLICT (email) DO NOTHING;

INSERT INTO memberships (user_id, org_id, role)
  SELECT u.id, o.id, 'owner'
  FROM users u, organizations o
  WHERE u.email = 'dev@kuhn.local' AND o.slug = 'default'
  ON CONFLICT (user_id, org_id) DO NOTHING;

UPDATE projects
  SET org_id = (SELECT id FROM organizations WHERE slug = 'default')
  WHERE org_id IS NULL;

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
