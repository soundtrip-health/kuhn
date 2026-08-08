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
  -- Epic 011: platform lifecycle. Suspension is enforced in the single access
  -- chokepoint (db/orgs.js checkOrgAccess), so every org-scoped route refuses
  -- at once; only the super-admin /api/admin routes ignore it.
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Story 011-003: org-level knobs, JSON merged over defaults at read time
  -- (db/org-settings.js is the schema + validator).
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  -- Story 011-001: platform flag, synced from KUHN_SUPERADMIN_EMAILS at boot
  -- (flips both ways). NEVER consulted by tenancy guards — a super-admin
  -- without a membership is a stranger to every org's content.
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Roles (story 010-003): viewer < editor < owner. Existing DBs are rebuilt by
-- db/init.js applyMembershipsRoleMigration ('member' rows become 'editor');
-- keep this DDL byte-compatible with MEMBERSHIPS_NEW_DDL there.
CREATE TABLE IF NOT EXISTS memberships (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org  ON memberships(org_id);

-- ============================================================
-- Auth (story 007-002): magic-link login tokens and DB-backed sessions.
-- Both store only a sha256 hash of the secret the user holds — a leaked DB
-- cannot mint logins. The session cookie carries the raw session token plus
-- an HMAC signature (KUHN_SESSION_SECRET); see src/db/auth.js.
-- ============================================================
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

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
  -- Who started it (story 007-001). Nullable: pre-attribution history stays
  -- NULL — no fake backfill. Existing DBs get the column via db/init.js.
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
  -- Whose request ran this job (story 007-001); sub-jobs inherit the parent's.
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
  -- Attribution (story 007-001): assistant/tool rows carry the user whose
  -- request ran the job, not an agent identity.
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  role              TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content           TEXT,
  tool_calls        TEXT,  -- JSON
  tool_call_id      TEXT,
  -- Tool-result outcome (issue #42): 1 = the tool returned isError, 0 = ok,
  -- NULL = not a tool result / pre-migration row. Lets log audits find
  -- failing tool calls without parsing result text.
  is_error          INTEGER,
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

-- ============================================================
-- File activity (story 005-002) — append-only per-project file event log
-- plus per-user seen markers. A file is "unseen" for a user when its latest
-- event is newer than their seen_at (or they have no seen row).
-- ============================================================
CREATE TABLE IF NOT EXISTS file_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  -- 'moved' is story 012-002's identity-preserving move (path = the NEW path,
  -- meta = {"from":"<old path>"}); one row per move, folder descendants implied
  -- by prefix. 'rename' is dormant — kept so no historical row is invalidated.
  kind        TEXT NOT NULL CHECK (kind IN ('create', 'update', 'delete', 'rename', 'moved')),
  meta        TEXT,   -- JSON sidecar, kind-specific; NULL for kinds that carry none
  agent_slug  TEXT,   -- NULL = user action (upload / delete / rename via the UI)
  -- Who acted (story 007-001): the uploading/deleting user, or for agent
  -- events the user whose request ran the job. Epic 005 shipped without this.
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  -- Epic 013: external-reviewer attribution (kind 'update' debounced rows).
  -- Nullable — member/agent rows stay NULL.
  review_link_id INTEGER REFERENCES review_links(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_file_events_project_path
  ON file_events(project_id, path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_events_project_time
  ON file_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS file_seen (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, project_id, path)
);

-- ============================================================
-- Org knowledge library (story 006-001) — per-organization documents whose
-- bytes live at <orgsRoot>/<orgId>/library/<docId>/<filename>. Ingestion
-- (extraction + FTS chunks) is story 006-002; until it runs, documents rest
-- at status 'pending'.
-- ============================================================
CREATE TABLE IF NOT EXISTS org_documents (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id             INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  filename           TEXT NOT NULL,
  title              TEXT,
  mime               TEXT,
  size_bytes         INTEGER NOT NULL,
  sha256             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'ingesting', 'ready', 'failed'
                     )),
  status_detail      TEXT,
  source             TEXT NOT NULL DEFAULT 'upload' CHECK (source IN (
                       'upload', 'project-promotion', 'guidance-import'
                     )),
  source_project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_docs_org_sha ON org_documents(org_id, sha256);
CREATE INDEX IF NOT EXISTS idx_org_docs_org ON org_documents(org_id, created_at DESC);

-- ============================================================
-- Org-library ingestion (story 006-002): extracted text chunks + FTS5 index.
-- The FTS table uses the external-content pattern; the triggers keep it in
-- sync for inserts and deletes (chunks are replace-only, never updated —
-- re-ingestion deletes and reinserts, and org_documents cascades fire the
-- delete trigger too).
-- ============================================================
CREATE TABLE IF NOT EXISTS org_document_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id        INTEGER NOT NULL REFERENCES org_documents(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  heading_path  TEXT,
  text          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_org_chunks_doc ON org_document_chunks(doc_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS org_chunks_fts USING fts5(
  text,
  content='org_document_chunks',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS org_chunks_ai AFTER INSERT ON org_document_chunks BEGIN
  INSERT INTO org_chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS org_chunks_ad AFTER DELETE ON org_document_chunks BEGIN
  INSERT INTO org_chunks_fts(org_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- ============================================================
-- Pending agent edits (story 008-001) — suggestion mode. One row per
-- (project, path): agent writes to draft/** land here as proposals and the
-- file's stored bytes change only on acceptance. base_content is the disk
-- content when first proposed ('' with base_missing=1 for a new file);
-- proposals to the same path coalesce by replacing proposed_content. Diff
-- hunks are derived at read time (src/pending-edits.js), never stored.
-- stale=1 marks a row whose base drifted and could not be re-anchored.
-- ============================================================
CREATE TABLE IF NOT EXISTS pending_edits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path              TEXT NOT NULL,
  base_content      TEXT NOT NULL,
  base_hash         TEXT NOT NULL,  -- sha256 hex of base_content
  base_missing      INTEGER NOT NULL DEFAULT 0,
  proposed_content  TEXT NOT NULL,
  agent_slug        TEXT,   -- NULL = human/API-proposed edit
  job_id            INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  stale             INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, path)
);

-- ============================================================
-- Margin comments (story 008-004) — anchored threads on document text.
-- Root rows carry the anchor: the exact quoted text plus character-offset
-- hints into the stored markdown. The server never computes editor positions
-- (the Yjs doc is opaque here and rooms are evicted on real writes): clients
-- re-anchor by quote in the open editor, keep positions live via decoration
-- mapping, and report drift back through the anchor endpoint; a quote that no
-- longer exists degrades to orphaned=1 — visible, never dropped. Replies
-- reference the root via parent_id and carry no anchor; resolving is a
-- root-level act. Author is user_id (human) and/or agent_slug (agent-filed;
-- user_id then attributes the requesting user, as in file_events).
-- ============================================================
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  parent_id     INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  agent_slug    TEXT,   -- NULL = human-authored
  job_id        INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  body          TEXT NOT NULL,
  anchor_quote  TEXT,     -- exact quoted target text (root rows only)
  anchor_start  INTEGER,  -- character-offset hint into the stored markdown
  anchor_end    INTEGER,
  orphaned      INTEGER NOT NULL DEFAULT 0,
  resolved_at   TEXT,
  resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Epic 013: external-reviewer attribution. Nullable — member rows stay NULL;
  -- display names join from review_links.reviewer_name at read time.
  review_link_id      INTEGER REFERENCES review_links(id) ON DELETE SET NULL,
  resolved_by_link_id INTEGER REFERENCES review_links(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_project_path ON comments (project_id, path, created_at);

-- ============================================================
-- External review (epic 013): magic links scoped to one document.
-- Both tables store only sha256 hashes of the secrets the reviewer holds
-- (same discipline as auth_tokens/sessions above). Mint/claim/revoke are
-- durably recorded by these columns; live fan-out is feed-only.
-- ============================================================
CREATE TABLE IF NOT EXISTS review_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,                 -- workspace-relative doc path; rekeyed on move (applyMove)
  mode           TEXT NOT NULL CHECK (mode IN ('view', 'comment', 'edit')),
  token_hash     TEXT NOT NULL UNIQUE,          -- sha256(raw url token)
  -- Deleting the minting user revokes their outstanding links — the safe
  -- default; SET NULL would leave live credentials with no accountable owner.
  created_by     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_name  TEXT,                          -- claimed display name (claim time)
  claimed_at     TEXT,                          -- NULL = unclaimed; single-claim discipline
  revoked_at     TEXT,
  revoked_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at     TEXT NOT NULL,
  last_active_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_review_links_project_path ON review_links(project_id, path);

CREATE TABLE IF NOT EXISTS review_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,             -- sha256(raw session token)
  link_id     INTEGER NOT NULL REFERENCES review_links(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,                    -- = the link's expires_at at claim time
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_review_sessions_link ON review_sessions(link_id);

-- ============================================================
-- Invitations (story 011-002): the door into an org. Stores only sha256 of
-- the token the invitee holds (auth_tokens discipline); redemption is a
-- single atomic UPDATE in db/invitations.js. State is issued → accepted /
-- revoked / expired (expiry is derived from expires_at, never written).
-- ============================================================
CREATE TABLE IF NOT EXISTS invitations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,                 -- normalized lower-case
  role        TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  token_hash  TEXT NOT NULL UNIQUE,          -- sha256(raw); raw shown once
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_invitations_org   ON invitations(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

-- ============================================================
-- Promotion requests (story 011-004): an editor's suggestion that a project
-- file join the org library. Holds only (project_id, path) — never bytes and
-- never an org_documents row — so nothing touches storage/FTS before an owner
-- approves (copy-on-approve). Re-suggest after rejection = a new row.
-- ============================================================
CREATE TABLE IF NOT EXISTS promotion_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  title           TEXT,
  note            TEXT,
  suggested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TEXT,
  decision_note   TEXT,
  org_document_id INTEGER REFERENCES org_documents(id) ON DELETE SET NULL,  -- set on approve
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_promotion_requests_org ON promotion_requests(org_id, status, created_at DESC);

-- ============================================================
-- Auth/audit events (stories 011-001/002 AC5): append-only stub, forward-
-- compatible with 010-005's real audit story. Types are the §4.4 enum
-- (org.created, invite.issued, member.role_changed, …).
-- ============================================================
CREATE TABLE IF NOT EXISTS auth_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  org_id        INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  email         TEXT,
  meta          TEXT,                        -- JSON sidecar
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_events_org ON auth_events(org_id, created_at DESC);
