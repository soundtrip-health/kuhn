/**
 * Kuhn project-configuration tool (STH-1): save_project_config. Extracted
 * from the Claude SDK construction in runtime.js — provider-neutral.
 */

import { applyProjectConfig } from '../project-config.js';
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
          enum: ['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'],
          description: 'Document type; pick the closest match for "other" projects',
        },
        research_question: { type: 'string', description: 'The central research question or document purpose' },
        deliverables: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Key deliverables' },
        timeline: { type: 'string', description: 'Key milestones and dates (use absolute dates)' },
        source_materials: { type: 'array', items: { type: 'string' }, default: [], description: 'Source materials the user already has (guidance docs, prior protocols, key papers, data)' },
        notes: { type: 'string', description: 'Anything else from the interview worth preserving' },
      },
      required: ['title', 'project_type', 'research_question', 'deliverables', 'timeline'],
    },
    execute: async (_id, input) => {
      try {
        const projectConfig = {
          title: input.title,
          project_type: input.project_type,
          research_question: input.research_question,
          deliverables: input.deliverables,
          timeline: input.timeline,
          source_materials: input.source_materials ?? [],
          ...(input.notes ? { notes: input.notes } : {}),
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
