/**
 * Kuhn feature-guide search (issue #170): search_kuhn_guide. The help agent's
 * only tool — it answers "how do I…" questions about Kuhn from the indexed
 * docs/features/ pages rather than from model memory, and cites the page and
 * section it used. Platform-scoped (no project or org data is read).
 */

import { guidePageCount, searchGuide } from '../../db/guide.js';
import { toolOk, toolError } from './envelope.js';

const MAX_SECTION_CHARS = 2400;

/**
 * @param {import('./registry.js').ToolContext} _ctx
 */
export function createGuideTools(_ctx) {
  return [{
    name: 'search_kuhn_guide',
    grants: ['search_kuhn_guide'],
    readOnly: true,
    effect: 'read',
    description:
      'Search the Kuhn feature guide — the maintained documentation of what Kuhn does and how to use it '
      + '(editor, page breaks and limits, preview and export, citations, comments, agents and chat, files, '
      + 'organization admin, interchange, accounts). Returns the best-matching guide sections in full, each '
      + 'with its page and section heading. Cite the page and section you rely on. Query with TWO TO FOUR plain '
      + 'words the user would say (e.g. "page lines", "export word", "invite member") — not a list of synonyms; '
      + 'if nothing relevant comes back, search once more with different words. Read-only; reads no project or organization data.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords describing the feature or question' },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 4, description: 'Maximum sections to return' },
      },
      required: ['query'],
    },
    execute: async (_id, { query: q, limit }) => {
      try {
        if (guidePageCount() === 0) {
          return toolOk('The feature guide is not available in this deployment (docs/features/ was not indexed). Say so — do not guess.');
        }
        const hits = searchGuide(q, limit);
        if (hits.length === 0) {
          return toolOk(`No guide section matched "${q}". Try once more with different or fewer keywords; if nothing matches, say the guide does not cover it.`);
        }
        const text = hits.map((h, i) => {
          const section = h.headingPath ? ` — section: ${h.headingPath}` : '';
          const body = h.text.length > MAX_SECTION_CHARS ? `${h.text.slice(0, MAX_SECTION_CHARS)} …` : h.text;
          return `${i + 1}. Page: "${h.title}" (${h.file})${section}\n${body}`;
        }).join('\n\n');
        return toolOk(text);
      } catch (err) {
        return toolError(`search_kuhn_guide failed: ${err.message}`);
      }
    },
  }];
}
