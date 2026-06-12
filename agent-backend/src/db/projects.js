import { query } from '../db.js';

/** @returns {Promise<object|undefined>} */
export async function getProject(projectId) {
  const { rows } = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  return rows[0];
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
