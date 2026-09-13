/**
 * Kuhn document-type discovery tool (issue #106): list_doc_types. Project
 * types used to be a fixed enum baked into save_project_config; they are an
 * org-extensible catalog now, so the PM (and the writer/advisor, who tune
 * their work to the type) ask instead of guessing. Provider-neutral; the org
 * is derived server-side from the task's project — the same stance as
 * list_slide_themes.
 */

import { effectiveDocTypes } from '../../db/doc-types.js';
import { getProject } from '../../db/projects.js';
import { toolOk, toolError } from './envelope.js';

/** One line per type: `slug — Title: description`. Shared with the save_project_config error. */
export function formatDocTypeLines(types) {
  return types.map((t) => `- ${t.slug} — ${t.title}${t.description ? `: ${t.description}` : ''}${t.source === 'org' ? ' (organization type)' : ''}`);
}

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createDocTypeTools(ctx) {
  const { projectId } = ctx;

  return [{
    name: 'list_doc_types',
    grants: ['list_doc_types'],
    readOnly: true,
    effect: 'read',
    description:
      "List the document types a project in this organization can be (Kuhn catalog types plus this organization's own), "
      + 'with a one-line description of each. Use the slug as project_type in save_project_config. '
      + 'Organization owners can add types under Org admin → Document types.',
    parameters: { type: 'object' },
    execute: async () => {
      try {
        const project = await getProject(projectId);
        const types = effectiveDocTypes(project?.org_id ?? null);
        if (types.length === 0) return toolOk('No document types are configured for this organization.');
        return toolOk([
          'Available document types (use the slug as project_type):',
          ...formatDocTypeLines(types),
        ].join('\n'));
      } catch (err) {
        return toolError(`Could not list document types: ${err.message}`);
      }
    },
  }];
}
