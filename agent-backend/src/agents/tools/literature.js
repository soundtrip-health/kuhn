/**
 * Kuhn literature-search tools (STH-1): pubmed_search, arxiv_search, and
 * search_org_knowledge. Extracted from the Claude SDK construction in
 * runtime.js — provider-neutral.
 *
 * search_org_knowledge is the one sanctioned crossing of the project-root
 * boundary (story 006-003): read-only passages from the org's knowledge
 * library, with provenance. The org is derived server-side from the task's
 * project — agents never pick their tenant, so there is deliberately no org
 * parameter.
 */

import { toolOk, toolError } from './envelope.js';
import { query as dbQuery } from '../../db.js';
import { getProject } from '../../db/projects.js';
import { searchOrgKnowledge, hasReadyOrgDocuments } from '../../db/org-documents.js';
import { pubmedSearch, arxivSearch } from '../search.js';

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createLiteratureTools(ctx) {
  const { projectId } = ctx;

  /**
   * @param {() => Promise<unknown>} fn
   * @returns {Promise<{content: Array<object>}>}
   */
  const searchToolResult = async (fn) => {
    try {
      const results = await fn();
      return toolOk(JSON.stringify(results, null, 2));
    } catch (err) {
      return toolError(`Search failed: ${err.message}`);
    }
  };

  const tools = [];

  tools.push({
    name: 'pubmed_search',
    grants: ['pubmed_search'],
    readOnly: true,
    effect: 'external-read',
    description: 'Search PubMed for peer-reviewed scientific papers. Call this whenever you need citations or evidence from the biomedical literature — never cite from memory.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keywords, MeSH terms, or author searches)' },
        max_results: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Maximum results to return' },
      },
      required: ['query'],
    },
    execute: async (_id, { query: q, max_results }) => searchToolResult(() => pubmedSearch(q, max_results)),
  });

  tools.push({
    name: 'arxiv_search',
    grants: ['arxiv_search'],
    readOnly: true,
    effect: 'external-read',
    description: 'Search arXiv for preprints. Flag any preprint citations as needing verification of peer-reviewed publication status.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Maximum results to return' },
      },
      required: ['query'],
    },
    execute: async (_id, { query: q, max_results }) => searchToolResult(() => arxivSearch(q, max_results)),
  });

  tools.push({
    name: 'search_org_knowledge',
    grants: ['search_org_knowledge'],
    readOnly: true,
    effect: 'read',
    description:
      "Search your organization's shared knowledge library (style guides, SOPs, regulatory guidance, templates, prior work) for relevant passages. "
      + "Returns ranked excerpts, each with the source document and section — cite the source document by name when you rely on one. "
      + "Read-only and org-wide; separate from this project's files.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full-text keyword query (plain domain terms work best)' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 8, description: 'Maximum passages to return' },
      },
      required: ['query'],
    },
    execute: async (_id, { query: q, limit }) => {
      try {
        const project = await getProject(projectId);
        const orgId = project?.org_id;
        // Suspension (story 011-001, fix I4): a suspended org's knowledge is
        // off limits to agents too, not just to browsers. Note the gap this
        // does NOT close: jobs already in flight when the suspension lands
        // keep running (documented in docs/data-pipeline.md; killing them is
        // 010-002's lifecycle rework).
        if (orgId != null) {
          const { rows } = await dbQuery(
            'SELECT status FROM organizations WHERE id = $1', [orgId],
          );
          if (rows[0]?.status === 'suspended') {
            return toolOk(
              'Organization suspended: the org knowledge library is unavailable. Proceed without org guidance — do not retry this search.',
            );
          }
        }
        if (orgId == null || !hasReadyOrgDocuments(orgId)) {
          return toolOk(
            'The organization has no library documents yet. Proceed without org guidance — do not retry this search.',
          );
        }
        const passages = searchOrgKnowledge(orgId, q, limit);
        if (passages.length === 0) {
          return toolOk(
            `No org library passages matched "${q}". Try once more with different keywords, or proceed without org guidance.`,
          );
        }
        const text = passages.map((p, i) => {
          const doc = p.title || p.filename;
          const section = p.headingPath ? ` — section: ${p.headingPath}` : '';
          return `${i + 1}. Source: "${doc}" (${p.filename})${section}\n${p.snippet}`;
        }).join('\n\n');
        return toolOk(text);
      } catch (err) {
        return toolError(`search_org_knowledge failed: ${err.message}`);
      }
    },
  });

  return tools;
}
