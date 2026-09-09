/**
 * Kuhn Typst-template discovery tool: list_typst_templates. The page layout
 * a document renders with (margins, font, spacing — what a grant or journal
 * mandates) is picked by `template: <name>` in its front matter; this lists
 * the names that resolve. Provider-neutral; the org is derived server-side
 * from the task's project — the same stance as list_slide_themes.
 */

import { getProject } from '../../db/projects.js';
import { listCatalogTemplates, listOrgTemplates } from '../../db/typst-templates.js';
import { toolOk, toolError } from './envelope.js';

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createTemplateTools(ctx) {
  const { projectId } = ctx;

  return [{
    name: 'list_typst_templates',
    grants: ['list_typst_templates'],
    readOnly: true,
    effect: 'read',
    description:
      "List the Typst page-layout templates available to this project: Kuhn catalog templates and this organization's uploaded templates. "
      + 'A document selects one with `template: <name>` in its leading YAML front matter; without one it renders with Pandoc\'s default layout.',
    parameters: { type: 'object' },
    execute: async () => {
      try {
        const project = await getProject(projectId);
        const orgId = project?.org_id ?? null;
        const org = orgId == null ? [] : listOrgTemplates(orgId).filter((t) => t.status === 'active');
        const orgNames = new Set(org.map((t) => t.name));
        const catalog = listCatalogTemplates().filter((t) => t.available && !orgNames.has(t.name));
        const lines = [
          "Available Typst templates (use as `template: <name>` in the document's front matter):",
          ...catalog.map((t) => `- ${t.name} — ${t.title}${t.description ? `: ${t.description}` : ''}${t.docx_path ? ' [Word reference for docx export]' : ''}`),
          ...org.map((t) => `- ${t.name} — ${t.title} (organization template)${t.docx_bytes ? ' [Word reference for docx export]' : ''}`),
        ];
        return toolOk(lines.join('\n'));
      } catch (err) {
        return toolError(`Could not list Typst templates: ${err.message}`);
      }
    },
  }];
}
