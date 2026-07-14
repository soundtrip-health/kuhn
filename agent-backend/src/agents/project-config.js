// Shared project-config write path (used by the save_project_config agent tool
// and the wizard's PUT /api/projects/:id/config endpoint). Merges the canonical
// config into projects.config, keeps project_type in sync, and writes
// project.json — from the canonical fields only. `extraConfig` (e.g. the wizard
// `setup` draft state) is stored in the DB blob but never written to project.json.

import { updateProjectConfig } from '../db/projects.js';
import { writeProjectFile } from '../storage.js';

/**
 * @param {number|string} projectId
 * @param {object} canonicalConfig - { title, project_type, research_question,
 *   deliverables, timeline, source_materials, notes? }
 * @param {object} [opts]
 * @param {object} [opts.extraConfig] - merged into projects.config, excluded from project.json
 * @returns {Promise<{ project: object|undefined, created: boolean }>}
 */
export async function applyProjectConfig(projectId, canonicalConfig, { extraConfig = {} } = {}) {
  const project = await updateProjectConfig(projectId, {
    projectType: canonicalConfig.project_type,
    config: { ...canonicalConfig, ...extraConfig },
  });
  const { created } = await writeProjectFile(
    projectId,
    'project.json',
    JSON.stringify(canonicalConfig, null, 2) + '\n',
  );
  return { project, created };
}
