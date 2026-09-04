// Canonical seed data for the default tenant, agents, tools, and agent↔tool
// assignments. Applied at startup by db/init.js (after schema.sql) and via
// `npm run db:seed`. Agent system prompts live as plain markdown under
// db/prompts/<slug>.md (loaded by seed.js) so they need no escaping.
//
// Per-agent model tiers (story 021): premium for planning/writing (pm, writer),
// mid-tier for analysis/review/domain (sonnet), cheap for high-volume
// literature search (ra).

export const DEFAULT_ORG = { name: 'Default Organization', slug: 'default' };
export const DEFAULT_USER = { email: 'dev@kuhn.local', displayName: 'Dev User' };

// promptFile is resolved relative to db/prompts/ by seed.js.
export const AGENTS = [
  { slug: 'pm', name: 'Project Manager', description: 'Project Manager', model: 'claude-opus-4-8' },
  { slug: 'writer', name: 'Writer', description: 'Writer', model: 'claude-opus-4-8' },
  { slug: 'ra', name: 'Research Assistant', description: 'Research Assistant (Librarian)', model: 'claude-haiku-4-5' },
  { slug: 'advisor', name: 'Domain Expert (Advisor)', description: 'Domain Expert (Advisor)', model: 'claude-sonnet-4-6' },
  { slug: 'reviewer', name: 'Critical Reviewer', description: 'Critical Scientific Reviewer', model: 'claude-sonnet-4-6' },
  { slug: 'analyst', name: 'Analyst', description: 'Analyst', model: 'claude-sonnet-4-6' },
];

export const TOOLS = [
  {
    slug: 'file_read', name: 'Read File', description: 'Read the contents of a project file',
    parameterSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path within the project' } }, required: ['path'] },
  },
  {
    slug: 'file_write', name: 'Write File', description: 'Write or update a project file',
    parameterSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path within the project' }, content: { type: 'string', description: 'File content to write' } }, required: ['path', 'content'] },
  },
  {
    slug: 'file_list', name: 'List Files', description: 'List contents of a project directory',
    parameterSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory path within the project' } }, required: ['path'] },
  },
  {
    slug: 'file_move', name: 'Move File', description: 'Move or rename a project file or folder (used to organize uploads)',
    parameterSchema: { type: 'object', properties: { from: { type: 'string', description: 'Source path' }, to: { type: 'string', description: 'Destination path including filename' } }, required: ['from', 'to'] },
  },
  {
    slug: 'pubmed_search', name: 'PubMed Search', description: 'Search PubMed for scientific papers',
    parameterSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, max_results: { type: 'integer', description: 'Maximum results to return', default: 10 } }, required: ['query'] },
  },
  {
    slug: 'arxiv_search', name: 'arXiv Search', description: 'Search arXiv and bioRxiv for preprints',
    parameterSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, max_results: { type: 'integer', description: 'Maximum results to return', default: 10 } }, required: ['query'] },
  },
  {
    slug: 'add_citation', name: 'Add Citation', description: 'Add a PubMed-verified citation to the project bibliography and return its BibTeX key',
    parameterSchema: { type: 'object', properties: { pmid: { type: 'string', description: 'PubMed ID of the work to cite' }, path: { type: 'string', description: 'Workspace-relative .bib file path', default: 'draft/references.bib' } }, required: ['pmid'] },
  },
  {
    // STH-49: identifier-driven — the full record is fetched from the
    // registry (arXiv/Crossref) by code; free-form person-author metadata is
    // gone. Manual entries are for identifier-less sources only and take an
    // organization as corporate author.
    slug: 'add_reference', name: 'Add Reference', description: 'Add a non-PubMed reference by identifier (arXiv id or DOI; the record is fetched from the registry) — or, for identifier-less web/government sources only, by manual description with an organization as author — and return its BibTeX key',
    parameterSchema: { type: 'object', properties: { arxiv_id: { type: 'string', description: 'arXiv id from arxiv_search results' }, doi: { type: 'string', description: 'DOI of the work' }, title: { type: 'string', description: 'Manual path: title of the identifier-less work' }, organization: { type: 'string', description: 'Manual path: issuing organization (corporate author)' }, year: { type: 'integer', description: 'Manual path: publication year' }, publisher: { type: 'string', description: 'Manual path: publisher or issuing body' }, url: { type: 'string', description: 'Manual path: source URL (required there)' }, entry_type: { type: 'string', description: 'Manual path: BibTeX entry type', default: 'misc' }, source_type: { type: 'string', enum: ['web', 'government', 'manual'], description: 'Manual path: source authority class', default: 'web' }, path: { type: 'string', description: 'Workspace-relative .bib file path', default: 'draft/references.bib' } } },
  },
  {
    // Issue #41: deterministic corrections to the reference store — grants the
    // update_reference and remove_reference runtime tools. The derived .bib
    // refuses direct file writes, so this is the only way to fix an entry.
    slug: 'manage_references', name: 'Manage References', description: 'Correct or delete existing bibliography entries by cite key (the derived .bib file is regenerated automatically)',
    parameterSchema: { type: 'object', properties: { cite_key: { type: 'string', description: 'Cite key of the entry' } }, required: ['cite_key'] },
  },
  {
    // STH-49: field-level verification — every fact about a citation, not
    // just its existence — against PubMed/Crossref/arXiv.
    slug: 'verify_references', name: 'Verify References', description: 'Field-by-field check of stored bibliography entries against their authoritative registries (PubMed/Crossref/arXiv); reports per-field mismatches',
    parameterSchema: { type: 'object', properties: { cite_keys: { type: 'array', items: { type: 'string' }, description: 'Cite keys to check (default: all)' } } },
  },
  {
    slug: 'add_comment', name: 'Add Comment', description: 'File a margin comment anchored to quoted text in a project document',
    parameterSchema: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path of the document' }, quote: { type: 'string', description: 'Exact target text copied verbatim from the current file' }, body: { type: 'string', description: 'The comment body' } }, required: ['path', 'quote', 'body'] },
  },
  {
    // Issue #58: the read-and-act half of the comment loop — grants the
    // list_comments, reply_comment and resolve_comment runtime tools.
    slug: 'manage_comments', name: 'Manage Comments', description: 'List margin-comment threads (all authors), reply in-thread, and resolve addressed threads',
    parameterSchema: { type: 'object', properties: { comment_id: { type: 'integer', description: 'Thread id (root comment)' } }, required: [] },
  },
  {
    slug: 'web_search', name: 'Web Search', description: 'General web search for documents, guidelines, and references',
    parameterSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, max_results: { type: 'integer', description: 'Maximum results to return', default: 10 } }, required: ['query'] },
  },
  {
    slug: 'search_org_knowledge', name: 'Search Org Knowledge', description: 'Search the organization\'s shared knowledge library for ranked passages with source-document provenance (read-only)',
    parameterSchema: { type: 'object', properties: { query: { type: 'string', description: 'Full-text keyword query' }, limit: { type: 'integer', description: 'Maximum passages to return', default: 8 } }, required: ['query'] },
  },
  {
    slug: 'ask_user', name: 'Ask User', description: 'Ask the user a question mid-task and wait for their reply',
    parameterSchema: { type: 'object', properties: { question: { type: 'string', description: 'The question to show the user' } }, required: ['question'] },
  },
  {
    slug: 'project_config', name: 'Save Project Config', description: 'Persist the structured project configuration gathered in the intake interview',
    parameterSchema: { type: 'object', properties: { title: { type: 'string', description: 'Project title' }, project_type: { type: 'string', enum: ['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'], description: 'Document type' }, research_question: { type: 'string', description: 'Central research question or document purpose' }, deliverables: { type: 'array', items: { type: 'string' }, description: 'Key deliverables' }, timeline: { type: 'string', description: 'Key milestones and dates' }, source_materials: { type: 'array', items: { type: 'string' }, description: 'Existing source materials' }, notes: { type: 'string', description: 'Other interview findings worth preserving' } }, required: ['title', 'project_type', 'research_question', 'deliverables', 'timeline'] },
  },
  {
    slug: 'spawn_agent', name: 'Spawn Agent', description: 'Dispatch a sub-agent to perform a focused task',
    parameterSchema: { type: 'object', properties: { agent_slug: { type: 'string', description: 'Slug of the agent to spawn' }, task: { type: 'string', description: 'Task description for the sub-agent' }, context: { type: 'string', description: 'Additional context for the sub-agent' } }, required: ['agent_slug', 'task'] },
  },
  {
    slug: 'run_script', name: 'Run Script', description: 'List and run shared org scripts (or a project script) in the no-internet sandbox (issue #68); org secrets can be injected for data-service access (secrets store)',
    parameterSchema: { type: 'object', properties: { script: { type: 'string', description: 'Org script slug' }, path: { type: 'string', description: 'Project-relative script path' }, args: { type: 'array', items: { type: 'string' }, description: 'Script arguments' }, secrets: { type: 'array', items: { type: 'string' }, description: 'Org secret names to inject as env vars' } } },
  },
  {
    // STH-61: slide-theme discovery — agents kept guessing theme names.
    slug: 'list_slide_themes', name: 'List Slide Themes', description: 'List the Marp slide themes available to this project (marp built-ins, Kuhn catalog, organization uploads)',
    parameterSchema: { type: 'object', properties: {} },
  },
];

// [agentSlug, toolSlug] pairs — the agent→tool matrix.
export const ASSIGNMENTS = [
  ['pm', 'file_read'], ['writer', 'file_read'], ['ra', 'file_read'], ['advisor', 'file_read'], ['reviewer', 'file_read'], ['analyst', 'file_read'],
  ['writer', 'file_write'], ['analyst', 'file_write'], ['ra', 'file_write'], ['advisor', 'file_write'],
  ['pm', 'file_list'], ['writer', 'file_list'], ['ra', 'file_list'], ['advisor', 'file_list'], ['reviewer', 'file_list'], ['analyst', 'file_list'],
  ['pm', 'file_move'],
  ['ra', 'pubmed_search'], ['ra', 'arxiv_search'],
  ['ra', 'add_citation'], ['writer', 'add_citation'], ['ra', 'add_reference'], ['ra', 'manage_references'],
  // STH-49: field-level citation verification — the RA runs it after adding
  // references and in audits; the reviewer runs it when checking claims vs.
  // evidence.
  ['ra', 'verify_references'], ['reviewer', 'verify_references'],
  ['ra', 'web_search'], ['advisor', 'web_search'],
  // Org knowledge library (story 006-003): the four roles that consume
  // guidance content. pm/analyst excluded by design — see the story's Notes.
  ['advisor', 'search_org_knowledge'], ['ra', 'search_org_knowledge'], ['reviewer', 'search_org_knowledge'], ['writer', 'search_org_knowledge'],
  // Margin comments (story 008-004): the two roles that give feedback on the
  // manuscript. Reviewer's first mutating tool — critique lands in the text.
  ['reviewer', 'add_comment'], ['pm', 'add_comment'],
  // Comment triage (issue #58): the roles that work the comment queue — the
  // reviewer follows up on its findings, the PM triages, and the writer
  // addresses feedback in the text and closes the loop.
  ['reviewer', 'manage_comments'], ['pm', 'manage_comments'], ['writer', 'manage_comments'],
  ['pm', 'spawn_agent'], ['writer', 'spawn_agent'],
  ['pm', 'ask_user'], ['pm', 'project_config'],
  // Slide themes (STH-61): the roles that author decks pick a real theme
  // name instead of guessing.
  ['pm', 'list_slide_themes'], ['writer', 'list_slide_themes'],
  // Sandboxed script execution (issue #68b): analyst only — the role that
  // produces tables/figures. Expands deliberately, not by default.
  ['analyst', 'run_script'],
];
