/**
 * Kuhn reference-store tools (STH-1): add_citation, add_reference,
 * verify_references, and the generated variants of the broad
 * `manage_references` grant (update_reference, remove_reference).
 * Extracted from the Claude SDK construction in runtime.js —
 * provider-neutral; all bibliography mutation goes through the
 * deterministic reference store in citations.js (the derived .bib
 * refuses direct file writes — issue #42).
 *
 * add_reference is identifier-driven (STH-49 / bianchi2026): any work
 * with an identifier (arXiv id, DOI) is fetched from its authoritative
 * registry and the full record is stored by code; the model only picks
 * an identifier out of search results. The manual path (identifier-less
 * web/government sources) takes an organization as corporate author —
 * person-name author fields no longer exist on this tool.
 */

import {
  DEFAULT_BIB_PATH,
  upsertCitation,
  addArxivReference,
  addDoiReference,
  addManualReference,
  verifyProjectReferences,
  updateReference,
  removeReference,
} from '../../citations.js';
import { toolOk, toolError } from './envelope.js';

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createReferenceTools(ctx) {
  const { projectId } = ctx;
  const { slug: agentSlug } = ctx.agent;

  /**
   * Live citation event (deferred from story 011) so the editor can refresh
   * chips/bibliography without polling.
   */
  const emitCitation = ({ key, bibtex, path, created }) => {
    ctx.channel.push({ type: 'citation', agent: agentSlug, key, bibtex, path });
    if (created) {
      ctx.channel.push({ type: 'file_change', agent: agentSlug, path, kind: 'update' });
    }
  };

  const tools = [];

  tools.push({
    name: 'add_citation',
    grants: ['add_citation'],
    readOnly: false,
    effect: 'write',
    description:
      'Add a citation to the project bibliography by PubMed ID. Verifies the metadata against PubMed, dedupes against existing entries, '
      + 'appends to the .bib file, and returns the BibTeX key to cite as [@key]. Find the PMID with pubmed_search first — never invent identifiers.',
    parameters: {
      type: 'object',
      properties: {
        pmid: { type: 'string', description: 'PubMed ID of the work to cite' },
        path: { type: 'string', default: DEFAULT_BIB_PATH, description: 'Workspace-relative .bib file path' },
      },
      required: ['pmid'],
    },
    execute: async (_id, { pmid, path }) => {
      try {
        const { key, created, bibtex } = await upsertCitation(projectId, pmid, path);
        emitCitation({ key, bibtex, path, created });
        return toolOk(
          created
            ? `Added to ${path} with key "${key}". Cite it as [@${key}].`
            : `Already in ${path} as "${key}". Cite it as [@${key}].`,
        );
      } catch (err) {
        return toolError(`add_citation failed: ${err.message}`);
      }
    },
  });

  tools.push({
    name: 'add_reference',
    grants: ['add_reference'],
    readOnly: false,
    effect: 'write',
    description:
      'Add a non-PubMed reference to the project bibliography and return the BibTeX key to cite as [@key]. '
      + 'Pass the identifier your search returned — arxiv_id (from arxiv_search results) or doi — and the full citation record (title, authors, year, venue) is fetched from the authoritative registry and stored deterministically; never type metadata for a work that has an identifier. '
      + 'Only an identifier-less source (web page, government guidance) may be described manually, and then with an organization as author, never person names. Use add_citation for anything indexed in PubMed.',
    parameters: {
      type: 'object',
      properties: {
        arxiv_id: { type: 'string', description: 'arXiv id exactly as returned by arxiv_search (e.g. "2401.01234v1"); the record is fetched from arXiv' },
        doi: { type: 'string', description: 'DOI of the work; the record is fetched from Crossref' },
        title: { type: 'string', description: 'Manual path only: title of the identifier-less work' },
        organization: { type: 'string', description: 'Manual path only: issuing organization as corporate author (e.g. "U.S. Food and Drug Administration")' },
        year: { type: 'integer', description: 'Manual path only: publication year' },
        publisher: { type: 'string', description: 'Manual path only: publisher or issuing body' },
        url: { type: 'string', description: 'Manual path only (required there): URL of the source' },
        entry_type: { type: 'string', description: 'Manual path only: BibTeX entry type (default misc)' },
        source_type: { type: 'string', enum: ['web', 'government', 'manual'], description: 'Manual path only: source authority class (default web)' },
        path: { type: 'string', default: DEFAULT_BIB_PATH, description: 'Workspace-relative .bib file path' },
      },
    },
    execute: async (_id, { arxiv_id, doi, path, ...manual }) => {
      try {
        let result;
        if (arxiv_id) {
          result = await addArxivReference(projectId, arxiv_id, path);
        } else if (doi) {
          result = await addDoiReference(projectId, doi, path);
        } else if (manual.title && manual.url) {
          result = await addManualReference(projectId, manual, path);
        } else {
          return toolError(
            'add_reference failed: pass arxiv_id or doi for any indexed work (the record is then fetched from the registry). A manual entry is only for identifier-less sources and requires title and url.',
          );
        }
        const { key, created, bibtex } = result;
        emitCitation({ key, bibtex, path, created });
        return toolOk(
          created
            ? `Added to ${path} with key "${key}". Cite it as [@${key}].`
            : `Already in ${path} as "${key}". Cite it as [@${key}].`,
        );
      } catch (err) {
        return toolError(`add_reference failed: ${err.message}`);
      }
    },
  });

  // STH-49: field-level verification — every fact about a citation, not
  // just its existence, checked against the authoritative registry by code.
  // A "verified" claim means this ran clean, nothing less.
  tools.push({
    name: 'verify_references',
    grants: ['verify_references'],
    readOnly: true,
    effect: 'none',
    description:
      'Verify stored bibliography entries field-by-field (authors, title, year, DOI, volume/issue/pages, venue) against their authoritative registries: PubMed by PMID, Crossref by DOI, arXiv by id. Reports verified / mismatch (with the registry value for each differing field) / unverifiable (no identifier — needs human review). Run this before stating that references are verified, and fix mismatches with update_reference using the reported registry values.',
    parameters: {
      type: 'object',
      properties: {
        cite_keys: { type: 'array', items: { type: 'string' }, description: 'Limit the check to these cite keys (default: every reference in the project store)' },
      },
    },
    execute: async (_id, { cite_keys }) => {
      try {
        const report = await verifyProjectReferences(projectId, cite_keys);
        return toolOk(JSON.stringify(report, null, 2));
      } catch (err) {
        return toolError(`verify_references failed: ${err.message}`);
      }
    },
  });

  // Deterministic corrections to the reference store (issue #41): the RA's
  // alternative to hand-editing the derived .bib, which the file tools
  // refuse. Both regenerate the bibliography file after changing the store.
  tools.push({
    name: 'update_reference',
    grants: ['manage_references'],
    readOnly: false,
    effect: 'write',
    description:
      'Correct fields of an existing bibliography entry by its cite key (metadata fixes: title, authors, year, journal, DOI, pages, ...). '
      + 'Only the fields you pass change; the cite key never changes, so in-text [@key] citations keep working. The bibliography file is regenerated automatically. '
      + 'Never fabricate metadata — only apply corrections you verified against the source.',
    parameters: {
      type: 'object',
      properties: {
        cite_key: { type: 'string', description: 'Cite key of the entry to correct (as returned by add_citation/add_reference)' },
        title: { type: 'string', description: 'Corrected title' },
        authors: { type: 'array', items: { type: 'string' }, description: 'Corrected author list, e.g. "Smith, Jane"' },
        year: { type: 'integer', description: 'Corrected publication year' },
        journal: { type: 'string', description: 'Corrected journal or venue' },
        volume: { type: 'string', description: 'Corrected volume' },
        issue: { type: 'string', description: 'Corrected issue' },
        pages: { type: 'string', description: 'Corrected page range' },
        publisher: { type: 'string', description: 'Corrected publisher' },
        doi: { type: 'string', description: 'Corrected DOI' },
        pmid: { type: 'string', description: 'Corrected PubMed ID' },
        url: { type: 'string', description: 'Corrected URL' },
        entry_type: { type: 'string', description: 'Corrected BibTeX entry type (article, misc, techreport, ...)' },
        source_type: {
          type: 'string',
          enum: ['pubmed', 'preprint', 'crossref', 'web', 'manual', 'government'],
          description: 'Corrected source authority class',
        },
        abstract: { type: 'string', description: 'Corrected abstract' },
        path: { type: 'string', default: DEFAULT_BIB_PATH, description: 'Workspace-relative .bib file path' },
      },
      required: ['cite_key'],
    },
    execute: async (_id, { cite_key, path, entry_type, source_type, ...rest }) => {
      try {
        const changes = { ...rest };
        if (entry_type !== undefined) changes.entryType = entry_type;
        if (source_type !== undefined) changes.sourceType = source_type;
        const { key, bibtex } = await updateReference(projectId, cite_key, changes, path);
        ctx.channel.push({ type: 'citation', agent: agentSlug, key, bibtex, path });
        ctx.channel.push({ type: 'file_change', agent: agentSlug, path, kind: 'update' });
        return toolOk(`Updated reference "${key}" and regenerated ${path}. Corrected entry:\n${bibtex}`);
      } catch (err) {
        return toolError(`update_reference failed: ${err.message}`);
      }
    },
  });

  tools.push({
    name: 'remove_reference',
    grants: ['manage_references'],
    readOnly: false,
    effect: 'write',
    description:
      'Delete a bibliography entry by its cite key (e.g. a duplicate or a reference that could not be verified). '
      + 'The bibliography file is regenerated automatically. Check that the draft no longer cites [@key] before removing.',
    parameters: {
      type: 'object',
      properties: {
        cite_key: { type: 'string', description: 'Cite key of the entry to delete' },
        path: { type: 'string', default: DEFAULT_BIB_PATH, description: 'Workspace-relative .bib file path' },
      },
      required: ['cite_key'],
    },
    execute: async (_id, { cite_key, path }) => {
      try {
        const { key } = await removeReference(projectId, cite_key, path);
        ctx.channel.push({ type: 'file_change', agent: agentSlug, path, kind: 'update' });
        return toolOk(`Removed reference "${key}" and regenerated ${path}.`);
      } catch (err) {
        return toolError(`remove_reference failed: ${err.message}`);
      }
    },
  });

  return tools;
}
