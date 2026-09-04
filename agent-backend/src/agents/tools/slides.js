/**
 * Kuhn slide-theme discovery tool (STH-61): list_slide_themes. Agents kept
 * guessing theme names; this lists what a deck's `theme:` front matter may
 * name. Provider-neutral. The org is derived server-side from the task's
 * project (no org parameter) — the same stance as search_org_knowledge.
 */

import { getProject } from '../../db/projects.js';
import { MARP_BUILTIN_THEMES, listCatalogThemes, listOrgThemes } from '../../db/slide-themes.js';
import { toolOk, toolError } from './envelope.js';

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createSlideTools(ctx) {
  const { projectId } = ctx;

  return [{
    name: 'list_slide_themes',
    grants: ['list_slide_themes'],
    readOnly: true,
    effect: 'read',
    description:
      "List the Marp slide themes available to this project: marp built-ins, Kuhn catalog themes, and this organization's uploaded themes. "
      + 'A slide deck opts in with `marp: true` and selects a theme with `theme: <name>` in its leading YAML front matter.',
    parameters: { type: 'object' },
    execute: async () => {
      try {
        const project = await getProject(projectId);
        const orgId = project?.org_id ?? null;
        const org = orgId == null ? [] : listOrgThemes(orgId).filter((t) => t.status === 'active');
        const orgNames = new Set(org.map((t) => t.name));
        const catalog = listCatalogThemes().filter((t) => t.available && !orgNames.has(t.name));
        const lines = [
          "Available slide themes (use as `theme: <name>` in the deck's front matter):",
          ...MARP_BUILTIN_THEMES.map((name) => `- ${name} (marp built-in)`),
          ...catalog.map((t) => `- ${t.name} — ${t.title}${t.description ? `: ${t.description}` : ''}`),
          ...org.map((t) => `- ${t.name} — ${t.title} (organization theme)`),
        ];
        return toolOk(lines.join('\n'));
      } catch (err) {
        return toolError(`Could not list slide themes: ${err.message}`);
      }
    },
  }];
}
