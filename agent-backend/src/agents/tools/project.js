/**
 * Kuhn project-configuration tool (STH-1): save_project_config. Extracted
 * from the Claude SDK construction in runtime.js — provider-neutral.
 */

import { effectiveDocTypes, resolveDocType } from '../../db/doc-types.js';
import { getProject } from '../../db/projects.js';
import { applyProjectConfig } from '../project-config.js';
import { formatDocTypeLines } from './doc-types.js';
import { toolOk, toolError } from './envelope.js';

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createProjectTools(ctx) {
  const { projectId } = ctx;
  const { slug: agentSlug } = ctx.agent;

  return [{
    name: 'save_project_config',
    grants: ['project_config'],
    readOnly: false,
    effect: 'write',
    description:
      'Save the structured project configuration (type, config) to the project record and write project.json to the workspace root. '
      + 'The project keeps the name the user gave it; the title here is stored as metadata. Normally handled by the setup wizard before this agent runs '
      + '— retained for edge cases where the config still needs to be saved or updated from here.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project title' },
        project_type: {
          type: 'string',
          description: 'Document type slug — one of the slugs list_doc_types returns for this organization (e.g. manuscript, grant). Pick the closest match, or ask the user; an unknown slug is refused with the valid list.',
        },
        research_question: { type: 'string', description: 'The central research question or document purpose' },
        deliverables: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Key deliverables' },
        timeline: { type: 'string', description: 'Key milestones and dates (use absolute dates)' },
        source_materials: { type: 'array', items: { type: 'string' }, default: [], description: 'Source materials the user already has (guidance docs, prior protocols, key papers, data)' },
        notes: { type: 'string', description: 'Anything else from the interview worth preserving' },
        template: { type: 'string', description: 'Default Typst page-layout template for the project\'s documents (a name from list_typst_templates, e.g. nih-grant for NIH applications, manuscript for journal drafts); documents may override it with their own `template:` front matter' },
      },
      required: ['title', 'project_type', 'research_question', 'deliverables', 'timeline'],
    },
    execute: async (_id, input) => {
      try {
        // Issue #106: the type must resolve for the project's org — the
        // catalog is extensible, so the schema no longer enumerates it.
        const project = await getProject(projectId);
        const orgId = project?.org_id ?? null;
        if (!resolveDocType(orgId, input.project_type)) {
          return toolError([
            `Unknown document type "${input.project_type}". Use one of these slugs as project_type:`,
            ...formatDocTypeLines(effectiveDocTypes(orgId)),
            'If none fits, ask the user which is closest — an organization owner can add types under Org admin → Document types.',
          ].join('\n'));
        }
        const projectConfig = {
          title: input.title,
          project_type: input.project_type,
          research_question: input.research_question,
          deliverables: input.deliverables,
          timeline: input.timeline,
          source_materials: input.source_materials ?? [],
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.template ? { template: input.template } : {}),
        };
        // Keep the user's chosen project name; the manuscript title lives in
        // config.title (and the user can rename the project explicitly).
        const { created } = await applyProjectConfig(projectId, projectConfig);
        ctx.channel.push({
          type: 'file_change',
          agent: agentSlug,
          path: 'project.json',
          kind: created ? 'create' : 'update',
        });
        return toolOk('Project configuration saved to the project record and project.json.');
      } catch (err) {
        return toolError(`Failed to save project config: ${err.message}`);
      }
    },
  }];
}
