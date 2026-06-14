import { query, querySync, transaction } from '../db.js';

const LIST_COLUMNS = 'id, name, project_type, owner_id, org_id, config, created_at';

/** Parse a project row's JSON config column (TEXT in SQLite) to an object. */
function parseProject(row) {
  if (row && typeof row.config === 'string') {
    row.config = JSON.parse(row.config || '{}');
  }
  return row;
}

/** @returns {Promise<object|undefined>} */
export async function getProject(projectId) {
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
     ORDER BY id`,
    [userId],
  );
  return rows.map(parseProject);
}

/** Projects in a single org, oldest first. Caller verifies membership. */
export async function listOrgProjects(orgId) {
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS} FROM projects WHERE org_id = $1 ORDER BY id`,
    [orgId],
  );
  return rows.map(parseProject);
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
