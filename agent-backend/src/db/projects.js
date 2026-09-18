import { query, querySync, transaction } from '../db.js';

const LIST_COLUMNS = 'id, name, project_type, owner_id, org_id, config, created_at';

/** Parse a project row's JSON config column (TEXT in SQLite) to an object. */
function parseProject(row) {
  if (row && typeof row.config === 'string') {
    row.config = JSON.parse(row.config || '{}');
  }
  return row;
}

/**
 * A LIVE project by id — soft-deleted rows (issue #190) are invisible here,
 * which is what makes a deleted project vanish from every member route
 * (routes/guards.js), the collab upgrade (collab-auth.js), render
 * (render.js) and the agent run gate (agents/runtime.js) without each of
 * them checking. Owner restore/purge use getProjectAny.
 * @returns {Promise<object|undefined>}
 */
export async function getProject(projectId) {
  const { rows } = await query(
    'SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL', [projectId],
  );
  return parseProject(rows[0]);
}

/** Any project by id, deleted or not (owner restore/purge paths only). */
export async function getProjectAny(projectId) {
  const { rows } = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  return parseProject(rows[0]);
}

/**
 * Projects across every org the user belongs to (story 005). This is the
 * org-scoped replacement for an unscoped `SELECT * FROM projects`.
 * @returns {Promise<object[]>}
 */
export async function listProjectsForUser(userId) {
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS}
     FROM projects
     WHERE org_id IN (SELECT org_id FROM memberships WHERE user_id = $1)
       AND deleted_at IS NULL
     ORDER BY id`,
    [userId],
  );
  return rows.map(parseProject);
}

/** Projects in a single org, oldest first. Caller verifies membership. */
export async function listOrgProjects(orgId) {
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS} FROM projects WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id`,
    [orgId],
  );
  return rows.map(parseProject);
}

/**
 * An org's soft-deleted projects, newest deletion first, each with who
 * deleted it (issue #190; the Org admin "Deleted projects" tab).
 * @returns {Promise<object[]>} rows carry deleted_at and
 *   deleted_by: { id, display_name, email } | null
 */
export async function listDeletedOrgProjects(orgId) {
  const { rows } = await query(
    `SELECT p.${LIST_COLUMNS.split(', ').join(', p.')}, p.deleted_at,
            u.id AS deleter_id, u.display_name AS deleter_name, u.email AS deleter_email
     FROM projects p
     LEFT JOIN users u ON u.id = p.deleted_by
     WHERE p.org_id = $1 AND p.deleted_at IS NOT NULL
     ORDER BY p.deleted_at DESC, p.id DESC`,
    [orgId],
  );
  return rows.map(({ deleter_id, deleter_name, deleter_email, ...row }) => ({
    ...parseProject(row),
    deleted_by: deleter_id == null
      ? null
      : { id: deleter_id, display_name: deleter_name, email: deleter_email },
  }));
}

/**
 * Soft-delete a live project (issue #190). Stamps deleted_at/deleted_by;
 * files, history, comments and jobs stay in place for restore.
 * @returns {Promise<object|undefined>} the row, or undefined if no LIVE
 *   project has that id (already deleted counts as missing)
 */
export async function softDeleteProject(projectId, { userId = null } = {}) {
  const { rows } = await query(
    `UPDATE projects
     SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), deleted_by = $2,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [projectId, userId],
  );
  return parseProject(rows[0]);
}

/**
 * Bring a soft-deleted project back. Review links, comments and history were
 * never touched, so they come back with it.
 * @returns {Promise<object|undefined>} the row, or undefined if no DELETED
 *   project has that id
 */
export async function restoreProject(projectId) {
  const { rows } = await query(
    `UPDATE projects
     SET deleted_at = NULL, deleted_by = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = $1 AND deleted_at IS NOT NULL
     RETURNING *`,
    [projectId],
  );
  return parseProject(rows[0]);
}

/**
 * Permanently delete the project row. Child rows (conversations, jobs,
 * comments, review links, file events, references, memory, …) cascade per
 * schema.sql. The workspace directory is the caller's job
 * (storage.js deleteProjectDir) — it must go BEFORE this, while the row
 * still resolves the directory.
 * @returns {Promise<boolean>} whether a row was deleted
 */
export async function purgeProject(projectId) {
  const { rows } = await query('DELETE FROM projects WHERE id = $1 RETURNING id', [projectId]);
  return rows.length > 0;
}

/** Create a project owned by an org (story 005). */
export async function createProject({ name, projectType, orgId }) {
  const { rows } = await query(
    `INSERT INTO projects (name, project_type, org_id)
     VALUES ($1, $2, $3)
     RETURNING ${LIST_COLUMNS}`,
    [name, projectType, orgId],
  );
  return parseProject(rows[0]);
}

/**
 * Remember which document was last open in a project (story 006), merged into
 * projects.config under `activeDocument`. Returns the updated config.
 *
 * SQLite has no JSONB merge operator, so we read-modify-write inside a
 * transaction to avoid a lost update.
 */
export async function setActiveDocument(projectId, path) {
  return transaction(() => {
    const { rows: cur } = querySync('SELECT config FROM projects WHERE id = $1', [projectId]);
    if (!cur[0]) return undefined;
    const merged = { ...JSON.parse(cur[0].config || '{}'), activeDocument: path };
    querySync(
      `UPDATE projects SET config = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = $1`,
      [projectId, JSON.stringify(merged)],
    );
    return merged;
  });
}

/**
 * Set (or clear, with null) the project's default Typst template —
 * projects.config.template — the layout documents without their own
 * `template:` front matter render with. Same read-modify-write as
 * setActiveDocument. Returns the updated project, or undefined if none.
 */
export async function setProjectTemplate(projectId, template) {
  return transaction(() => {
    const { rows: cur } = querySync('SELECT config FROM projects WHERE id = $1', [projectId]);
    if (!cur[0]) return undefined;
    const merged = { ...JSON.parse(cur[0].config || '{}') };
    if (template) merged.template = template; else delete merged.template;
    const { rows } = querySync(
      `UPDATE projects SET config = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = $1 RETURNING *`,
      [projectId, JSON.stringify(merged)],
    );
    return parseProject(rows[0]);
  });
}

/**
 * Apply the PM interview result (story 012): optionally set the project type
 * and merge the structured config into projects.config. `name` is set only
 * when explicitly provided — the seeding interview leaves the user's chosen
 * name intact (the manuscript title lives in config.title).
 * @param {number|string} projectId
 * @param {object} fields
 * @param {string} [fields.name]
 * @param {string} [fields.projectType]
 * @param {object} [fields.config] - Merged (shallow) over the existing config
 * @returns {Promise<object|undefined>} The updated project row
 */
export async function updateProjectConfig(projectId, { name, projectType, config: cfg } = {}) {
  return transaction(() => {
    const { rows: cur } = querySync('SELECT config FROM projects WHERE id = $1', [projectId]);
    if (!cur[0]) return undefined;
    const merged = { ...JSON.parse(cur[0].config || '{}'), ...(cfg ?? {}) };
    const { rows } = querySync(
      `UPDATE projects
       SET name = COALESCE($2, name),
           project_type = COALESCE($3, project_type),
           config = $4,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = $1
       RETURNING *`,
      [projectId, name ?? null, projectType ?? null, JSON.stringify(merged)],
    );
    return parseProject(rows[0]);
  });
}
