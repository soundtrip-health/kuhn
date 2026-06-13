import { query } from '../db.js';

const LIST_COLUMNS = 'id, name, project_type, owner_id, org_id, config, created_at';

/** @returns {Promise<object|undefined>} */
export async function getProject(projectId) {
  const { rows } = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  return rows[0];
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
  return rows;
}

/** Projects in a single org, oldest first. Caller verifies membership. */
export async function listOrgProjects(orgId) {
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS} FROM projects WHERE org_id = $1 ORDER BY id`,
    [orgId],
  );
  return rows;
}

/** Create a project owned by an org (story 005). */
export async function createProject({ name, projectType, orgId }) {
  const { rows } = await query(
    `INSERT INTO projects (name, project_type, org_id)
     VALUES ($1, $2, $3)
     RETURNING ${LIST_COLUMNS}`,
    [name, projectType, orgId],
  );
  return rows[0];
}

/**
 * Remember which document was last open in a project (story 006), merged into
 * projects.config under `activeDocument`. Returns the updated config.
 */
export async function setActiveDocument(projectId, path) {
  const { rows } = await query(
    `UPDATE projects
     SET config = config || jsonb_build_object('activeDocument', $2::text),
         updated_at = now()
     WHERE id = $1
     RETURNING config`,
    [projectId, path],
  );
  return rows[0]?.config;
}

/**
 * Apply the PM interview result (story 012): rename the project, set its
 * type, and merge the structured config into projects.config.
 * @param {number|string} projectId
 * @param {object} fields
 * @param {string} [fields.name]
 * @param {string} [fields.projectType]
 * @param {object} [fields.config] - Merged over the existing config
 * @returns {Promise<object|undefined>} The updated project row
 */
export async function updateProjectConfig(projectId, { name, projectType, config: cfg } = {}) {
  const { rows } = await query(
    `UPDATE projects
     SET name = COALESCE($2, name),
         project_type = COALESCE($3, project_type),
         config = config || $4::jsonb,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [projectId, name ?? null, projectType ?? null, JSON.stringify(cfg ?? {})],
  );
  return rows[0];
}
