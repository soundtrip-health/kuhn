/**
 * Application-behavior conformance scenarios (STH-5) — part 1: the
 * app-owned behaviors a migrated runtime must preserve.
 *
 * Every scenario is provider-neutral: scripted model turns name Kuhn tools
 * by their exposed slugs and assert against domain events, database rows,
 * and workspace files. The same files run unchanged against the Claude and
 * Pi drivers (see index.js).
 */

/** 1 — Streaming and final text, normalized terminal event. */
export const streamingText = {
  id: 'streaming-text',
  title: 'Streamed deltas close into the final text; the run ends with a done terminal',
  tasks: [{
    role: 'writer',
    input: 'Write the abstract opening sentence.',
    model: {
      attempts: [{
        turns: [{
          deltas: ['The ', 'draft is ', 'ready.'],
          text: 'The draft is ready.',
          usage: { input: 12, output: 7 },
        }],
      }],
    },
  }],
  assert: async (ctx) => {
    const deltas = ctx.eventsOf('text_delta');
    ctx.check('streamed deltas arrived', deltas.length === 3, `got ${deltas.length}`);
    ctx.check('deltas concatenate to the final text',
      deltas.map((d) => d.content).join('') === 'The draft is ready.');
    const text = ctx.lastEventOf('text');
    ctx.check('final text event matches', text?.content === 'The draft is ready.');
    const done = ctx.lastEventOf('done');
    ctx.check('done terminal carries sessionId and usage',
      done?.sessionId != null && done?.usage?.inputTokens === 12 && done?.usage?.outputTokens === 7,
      JSON.stringify(done));
    const job = ctx.runs[0].jobId != null ? ctx.job(ctx.runs[0].jobId) : null;
    ctx.check('job row holds the tokens', job?.status === 'done' && job.input_tokens === 12 && job.output_tokens === 7);
    const conv = ctx.conversations().find((c) => c.agent_slug === 'writer');
    const assistant = ctx.messages(conv?.id).find((m) => m.role === 'assistant');
    ctx.check('assistant message persisted', assistant?.content === 'The draft is ready.');
  },
};

/** 2 — Role tool grants: each role sees exactly its matrix tools. */
export const toolGrants = {
  id: 'tool-grants',
  title: 'A role cannot call tools outside its DB grant; the driver only receives the granted set',
  fixture: {
    files: { 'draft/main.md': 'Base draft.\n' },
  },
  tasks: [
    {
      role: 'pm',
      input: 'Search the literature for me, please.',
      model: {
        attempts: [{
          turns: [
            { toolCalls: [{ tool: 'pubmed_search', args: { query: 'anything' } }] },
            { text: 'I cannot run literature searches; ask the research assistant.', usage: { input: 9, output: 4 } },
          ],
        }],
      },
    },
    {
      role: 'ra',
      input: 'Search the literature for cardioprotective effects of metformin.',
      model: {
        attempts: [{
          turns: [
            { toolCalls: [{ tool: 'pubmed_search', args: { query: 'metformin cardioprotective' } }] },
            { text: 'Found the requested records.', usage: { input: 9, output: 4 } },
          ],
        }],
      },
    },
  ],
  assert: async (ctx) => {
    const pmObs = ctx.driver.observations.find((o) => o.role === 'pm');
    const raObs = ctx.driver.observations.find((o) => o.role === 'ra');
    ctx.check('pm grant excludes pubmed_search', pmObs && !pmObs.mcpToolNames.includes('pubmed_search'),
      JSON.stringify(pmObs?.mcpToolNames));
    ctx.check('ra grant includes pubmed_search', raObs?.mcpToolNames.includes('pubmed_search'));
    // The PM's unauthorized call must come back as an error result, not a
    // crash or a silent success.
    const pmJob = ctx.jobs().find((j) => j.role === 'pm');
    const pmConv = ctx.conversations().find((c) => c.id === pmJob?.conversation_id);
    const pmToolMsgs = ctx.toolMessages(pmConv?.id);
    ctx.check('pm saw a tool error for the denied call',
      pmToolMsgs.some((m) => m.is_error === 1 && /not available|not found/i.test(m.content ?? '')),
      JSON.stringify(pmToolMsgs.map((m) => m.content)));
    ctx.check('pm run still completed', pmJob?.status === 'done');
  },
};

/** 3 — Compose mode: mutation tools are withheld from the writer. */
export const composeDenials = {
  id: 'compose-mode-denials',
  title: '/write (compose) mode strips file mutation and bibliography upserts from the writer',
  fixture: {
    files: { 'draft/main.md': 'Original.\n' },
  },
  tasks: [{
    role: 'writer',
    input: 'Return revised text only; do not touch the files.',
    compose: true,
    model: {
      attempts: [{
        turns: [
          { toolCalls: [{ tool: 'write_file', args: { path: 'draft/main.md', content: 'Should not land.' } }] },
          { toolCalls: [{ tool: 'add_citation', args: { pmid: '38450214' } }] },
          { text: 'Revised abstract returned as text only.', usage: { input: 9, output: 4 } },
        ],
      }],
    },
  }],
  assert: async (ctx) => {
    const obs = ctx.driver.observations[0];
    ctx.check('compose mode withholds write_file', !obs.mcpToolNames.includes('write_file'),
      JSON.stringify(obs.mcpToolNames));
    ctx.check('compose mode withholds add_citation', !obs.mcpToolNames.includes('add_citation'));
    ctx.check('file bytes untouched', (await ctx.read('draft/main.md')) === 'Original.\n');
    ctx.check('no pending edit created', ctx.pendingEdits(ctx.fixture.projectId).length === 0);
    ctx.check('no file_change event', ctx.eventsOf('file_change').length === 0);
    const toolMsgs = ctx.messages(ctx.conversations().find((c) => c.agent_slug === 'writer')?.id)
      .filter((m) => m.role === 'tool');
    ctx.check('both denied calls surfaced as tool errors', toolMsgs.filter((m) => m.is_error === 1).length === 2,
      JSON.stringify(toolMsgs.map((m) => m.content)));
  },
};

/** 4 — Project storage containment: escapes and symlink hops are refused. */
export const storageContainment = {
  id: 'storage-containment',
  title: 'File tools cannot read or write outside the project root, even via symlinks',
  fixture: {
    files: { 'draft/main.md': 'Base.\n' },
    outside: { 'secret.md': 'TOP SECRET\n' },
    symlinks: { 'escape-link': '../__outside__/secret.md' },
  },
  tasks: [{
    role: 'writer',
    input: 'Try to reach outside the workspace; report what happens.',
    model: {
      attempts: [{
        turns: [
          { toolCalls: [{ tool: 'read_file', args: { path: '../__outside__/secret.md' } }] },
          { toolCalls: [{ tool: 'read_file', args: { path: 'escape-link' } }] },
          { toolCalls: [{ tool: 'write_file', args: { path: '../__outside__/evil.md', content: 'pwned' } }] },
          { text: 'All three attempts were refused by the workspace.', usage: { input: 9, output: 4 } },
        ],
      }],
    },
  }],
  assert: async (ctx) => {
    const toolMsgs = ctx.messages(ctx.conversations().find((c) => c.agent_slug === 'writer')?.id)
      .filter((m) => m.role === 'tool');
    ctx.check('all three escape attempts failed', toolMsgs.filter((m) => m.is_error === 1).length === 3,
      JSON.stringify(toolMsgs.map((m) => ({ err: m.is_error, c: m.content }))));
    ctx.check('no tool error claimed success', toolMsgs.every((m) => m.is_error === 1));
    ctx.check('run completed despite tool errors', ctx.job(ctx.runs[0].jobId)?.status === 'done');
    const fs = await import('node:fs');
    ctx.check('outside file not modified',
      fs.readFileSync(ctx.fixture.outsideRoot + '/secret.md', 'utf-8') === 'TOP SECRET\n');
    ctx.check('outside write refused (no file created)', !fs.existsSync(ctx.fixture.outsideRoot + '/evil.md'));
    ctx.check('secret content never reached the model',
      !ctx.driver.transcripts.some((t) => JSON.stringify(t).includes('TOP SECRET')));
  },
};

/** 5 — Direct vs proposed edits (suggestion mode). */
export const directVsProposed = {
  id: 'direct-vs-proposed-edits',
  title: 'Draft writes and edits to existing files become proposals; new files outside draft/ write directly',
  fixture: {
    files: {
      'draft/main.md': 'Alpha line.\nBeta line.\n',
      'guidance/notes.md': 'Existing guidance.\n',
    },
  },
  tasks: [{
    role: 'writer',
    input: 'Revise the draft, add a new note, and refine the guidance.',
    model: {
      attempts: [{
        turns: [
          // draft/** → always a proposal.
          { toolCalls: [{ tool: 'write_file', args: { path: 'draft/main.md', content: 'Alpha line.\nBeta line v2.\n' } }] },
          // sequential edit against the EFFECTIVE (proposed) content → coalesces.
          { toolCalls: [{ tool: 'edit_file', args: { path: 'draft/main.md', old_string: 'Beta line v2.', new_string: 'Beta line v3.' } }] },
          // new file outside draft/ → direct write.
          { toolCalls: [{ tool: 'write_file', args: { path: 'notes/new-note.md', content: 'Fresh note.\n' } }] },
          // existing file outside draft/ → proposal.
          { toolCalls: [{ tool: 'edit_file', args: { path: 'guidance/notes.md', old_string: 'Existing guidance.', new_string: 'Updated guidance.' } }] },
          { text: 'Edits recorded for review.', usage: { input: 9, output: 4 } },
        ],
      }],
    },
  }],
  assert: async (ctx) => {
    const pid = ctx.fixture.projectId;
    ctx.check('draft/main.md still on its original bytes', (await ctx.read('draft/main.md')) === 'Alpha line.\nBeta line.\n');
    ctx.check('draft proposal coalesced into one row',
      ctx.pendingEdits(pid).filter((e) => e.path === 'draft/main.md').length === 1);
    const draftProposal = ctx.pendingEdits(pid).find((e) => e.path === 'draft/main.md');
    ctx.check('proposal content is the effective v3 text',
      draftProposal?.proposed_content === 'Alpha line.\nBeta line v3.\n',
      draftProposal?.proposed_content);
    ctx.check('new file outside draft/ written directly', (await ctx.read('notes/new-note.md')) === 'Fresh note.\n');
    ctx.check('guidance edit is a proposal, not on disk',
      (await ctx.read('guidance/notes.md')) === 'Existing guidance.\n'
      && ctx.pendingEdits(pid).some((e) => e.path === 'guidance/notes.md' && e.proposed_content === 'Updated guidance.\n'));
    const kinds = ctx.eventsOf('file_change').map((e) => e.kind);
    ctx.check('file_change events: proposed, proposed, create, proposed',
      JSON.stringify(kinds) === JSON.stringify(['proposed', 'proposed', 'create', 'proposed']),
      JSON.stringify(kinds));
  },
};

/** 6 — Citations and references against the fixture literature (STH-49
 * contract: PubMed via add_citation; identifier-bearing sources are fetched
 * from their registry by code; only identifier-less sources take the manual
 * path, with an organization as corporate author). */
export const citationsReferences = {
  id: 'citations-references',
  title: 'PubMed citation, registry-fetched arXiv reference, and a manual entry land in the .bib store',
  fixture: {
    files: { 'draft/main.md': 'Metformin may protect the heart [@smith2024].\n' },
    literature: {
      pmids: {
        '38450214': {
          title: 'Metformin and cardioprotection: a systematic review',
          authors: ['Smith, Jane', 'Doe, Alan'],
          journal: 'Journal of Test Medicine',
          pubdate: '2024 Jan 15',
          doi: '10.1000/test.2024.38450214',
        },
      },
      searches: { 'metformin cardioprotective': ['38450214'] },
      // Served by the fetch fake as the arXiv API Atom feed the REAL
      // arxivFetchById()/parseArxivFeed() code consumes (id_list lookup).
      arxivIds: {
        '2401.01234v1': {
          title: 'Deep learning for metabolic disease risk prediction',
          authors: ['Rita Roe', 'Sam Cole'],
          published: '2024-01-02T17:00:00Z',
          summary: 'We predict metabolic disease risk from routine imaging.',
        },
      },
    },
  },
  tasks: [{
    role: 'ra',
    input: 'Cite the metformin review, add the arXiv preprint by id, add a manual web reference, and correct the preprint title.',
    model: {
      attempts: [{
        turns: [
          { toolCalls: [{ tool: 'pubmed_search', args: { query: 'metformin cardioprotective' } }] },
          { toolCalls: [{ tool: 'add_citation', args: { pmid: '38450214' } }] },
          { toolCalls: [{ tool: 'add_reference', args: { arxiv_id: '2401.01234v1' } }] },
          { toolCalls: [{
            tool: 'add_reference',
            args: {
              title: 'Cardiovascular endpoints in metabolic disease: guidance for trial design',
              organization: 'National Heart Institute',
              year: 2023,
              url: 'https://example.org/nhi/roe-2023',
              source_type: 'web',
            },
          }] },
          { toolCalls: [{ tool: 'update_reference', args: { cite_key: 'roe2024', title: 'Deep learning for metabolic disease risk prediction (updated)' } }] },
          { text: 'Bibliography updated.', usage: { input: 12, output: 6 } },
        ],
      }],
    },
  }],
  assert: async (ctx) => {
    const refs = ctx.references(ctx.fixture.projectId);
    ctx.check('three references stored', refs.length === 3, JSON.stringify(refs.map((r) => r.cite_key)));
    const pmRef = refs.find((r) => r.pmid === '38450214');
    ctx.check('PubMed citation verified with metadata',
      pmRef?.cite_key === 'smith2024' && pmRef.title === 'Metformin and cardioprotection: a systematic review'
      && pmRef.year === 2024 && pmRef.source_type === 'pubmed' && pmRef.identity_status === 'strong',
      JSON.stringify(pmRef));
    const arxivRef = refs.find((r) => r.cite_key === 'roe2024');
    ctx.check('arXiv reference fetched from the registry with corrected title',
      arxivRef?.source_type === 'preprint' && arxivRef.title.includes('(updated)')
      && JSON.parse(arxivRef.authors_json ?? '[]')?.[0] === 'Roe, Rita' && arxivRef.year === 2024
      && arxivRef.url === 'http://arxiv.org/abs/2401.01234v1',
      JSON.stringify(arxivRef));
    const manual = refs.find((r) => r.cite_key === 'nationalheartinstitute2023');
    ctx.check('manual identifier-less reference stored with corporate author',
      manual?.source_type === 'web' && JSON.parse(manual.authors_json ?? '[]')?.[0] === '{National Heart Institute}'
      && manual.url === 'https://example.org/nhi/roe-2023',
      JSON.stringify(manual));
    const bib = await ctx.read('draft/references.bib');
    ctx.check('bib file materialized with all three entries',
      bib != null && bib.includes('smith2024') && bib.includes('roe2024') && bib.includes('nationalheartinstitute2023'), bib);
    const citationEvents = ctx.eventsOf('citation');
    ctx.check('live citation events emitted for each bibliography change',
      citationEvents.length === 4
      && citationEvents.map((e) => e.key).join(',') === 'smith2024,roe2024,nationalheartinstitute2023,roe2024',
      JSON.stringify(citationEvents.map((e) => e.key)));
  },
};

/** 7 — Comment lifecycle with cross-role attribution. */
export const commentsLifecycle = {
  id: 'comments-lifecycle',
  title: 'Reviewer files a comment; the writer replies and resolves; attribution is preserved',
  fixture: {
    files: { 'draft/main.md': 'The cohort was small. Recruitment was slow.\n' },
  },
  tasks: [
    {
      role: 'reviewer',
      input: 'Flag the sampling weakness.',
      model: {
        attempts: [{
          turns: [
            { toolCalls: [{
              tool: 'add_comment',
              args: {
                path: 'draft/main.md',
                quote: 'The cohort was small.',
                body: 'Small n weakens the survival analysis; state the power calculation.',
              },
            }] },
            { text: 'Comment filed.', usage: { input: 8, output: 3 } },
          ],
        }],
      },
    },
    {
      role: 'writer',
      input: 'Address the open comment on the draft.',
      model: {
        attempts: [{
          turns: [
            { toolCalls: [{ tool: 'list_comments', args: {} }] },
            { toolCalls: [{ tool: 'reply_comment', args: { comment_id: '$first_comment_id', body: 'Added a power analysis to the methods section.' } }] },
            { toolCalls: [{ tool: 'resolve_comment', args: { comment_id: '$first_comment_id', note: 'Addressed in v2.' } }] },
            { text: 'Comment addressed and resolved.', usage: { input: 8, output: 3 } },
          ],
        }],
      },
    },
  ],
  assert: async (ctx) => {
    const threads = ctx.comments(ctx.fixture.projectId).filter((c) => c.parent_id == null);
    ctx.check('one comment thread filed', threads.length === 1);
    const root = threads[0];
    ctx.check('comment attributed to the reviewer agent', root?.agent_slug === 'reviewer' && root.orphaned === 0);
    ctx.check('anchor quote stored', root?.anchor_quote === 'The cohort was small.');
    const replies = ctx.comments(ctx.fixture.projectId).filter((c) => c.parent_id === root?.id);
    ctx.check('writer reply + closing note recorded', replies.length === 2, JSON.stringify(replies.map((r) => r.body)));
    ctx.check('thread resolved', root?.resolved_at != null);
    // Attribution: the writer's job carried the same user id as the reviewer's.
    const jobs = ctx.jobs();
    ctx.check('both jobs share the acting user',
      new Set(jobs.map((j) => j.user_id)).size === 1);
  },
};

/** 8 — Project config: PM interview persisted. */
export const projectConfig = {
  id: 'project-config-save',
  title: 'The PM interview saves the structured project configuration',
  tasks: [{
    role: 'pm',
    input: 'Interview me about the new protocol project.',
    model: {
      attempts: [{
        turns: [
          { toolCalls: [{ tool: 'ask_user', args: { question: 'What type of project is this?' } }] },
          {
            toolCalls: [{
              tool: 'save_project_config',
              args: {
                title: 'RWE Protocol — Heart Failure Biomarkers',
                project_type: 'rwe-protocol',
                research_question: 'Do circulating biomarkers predict readmission in heart failure cohorts?',
                deliverables: ['Protocol draft v1', 'Literature table'],
                timeline: 'IRB submission by 2026-11-01; data collection 2027-01',
                source_materials: ['guidance/rwe-checklist.md'],
              },
            }],
          },
          { text: 'Project configuration saved.', usage: { input: 10, output: 5 } },
        ],
      }],
    },
  }],
  interactions: [
    { when: 'question', match: 'What type of project', reply: 'A real-world evidence protocol.' },
  ],
  assert: async (ctx) => {
    const project = ctx.project(ctx.fixture.projectId);
    const cfg = typeof project?.config === 'string' ? JSON.parse(project.config) : project?.config;
    ctx.check('project config persisted', cfg?.title === 'RWE Protocol — Heart Failure Biomarkers'
      && cfg.project_type === 'rwe-protocol' && Array.isArray(cfg.deliverables) && cfg.deliverables.length === 2,
      JSON.stringify(cfg));
    const question = ctx.eventsOf('question')[0];
    ctx.check('question event carried the job id', question?.jobId == ctx.runs[0].jobId);
    const toolMsgs = ctx.messages(ctx.conversations().find((c) => c.agent_slug === 'pm')?.id).filter((m) => m.role === 'tool');
    ctx.check('ask_user reply round-tripped to the model',
      toolMsgs.some((m) => /real-world evidence protocol/i.test(m.content ?? '')),
      JSON.stringify(toolMsgs.map((m) => m.content)));
  },
};

/** 9 — Org knowledge search over the fixture documents. */
export const orgKnowledge = {
  id: 'org-knowledge-search',
  title: 'search_org_knowledge ranks fixture passages with provenance',
  fixture: {
    orgDocuments: [{
      title: 'Sponsor reporting standards',
      filename: 'reporting.md',
      chunks: [
        { headingPath: ['Safety', 'Grading'], text: 'Adverse events must be graded with the CTCAE v5 scale and reported within 24 hours.' },
        { headingPath: ['Finance'], text: 'Invoices follow the quarterly cycle and require two signatures.' },
      ],
    }],
  },
  tasks: [{
    role: 'advisor',
    input: 'What does the org require for adverse event grading?',
    model: {
      attempts: [{
        turns: [
          { toolCalls: [{ tool: 'search_org_knowledge', args: { query: 'adverse event grading' } }] },
          { text: 'Org standard: CTCAE v5 grading, 24-hour reporting.', usage: { input: 9, output: 5 } },
        ],
      }],
    },
  }],
  assert: async (ctx) => {
    const toolMsgs = ctx.messages(ctx.conversations().find((c) => c.agent_slug === 'advisor')?.id).filter((m) => m.role === 'tool');
    const hit = toolMsgs.map((m) => m.content).join('\n');
    ctx.check('knowledge hit contains the safety passage', hit.includes('CTCAE v5'), hit.slice(0, 200));
    ctx.check('unrelated passage not returned', !hit.includes('Invoices follow the quarterly'));
    const toolCalls = ctx.messages(ctx.conversations().find((c) => c.agent_slug === 'advisor')?.id)
      .find((m) => m.role === 'assistant')?.tool_calls ?? null;
    ctx.check('search was actually invoked (not answered from memory)',
      JSON.stringify(toolCalls ?? '').includes('search_org_knowledge'));
  },
};

/** 10 — Active document inheritance (STH-43) incl. sub-agent inheritance. */
export const activeDocument = {
  id: 'active-document-inheritance',
  title: 'The open document rides along in context, including into dispatched children',
  fixture: {
    files: { 'research/lit-review.md': '# Lit review\n' },
    project: { activeDocument: 'research/lit-review.md' },
  },
  tasks: [
    {
      role: 'writer',
      input: 'Summarize the doc.',
      context: null, // fall back to the project's persisted active document
      model: {
        attempts: [{
          turns: [{ text: 'Summary of the lit review.', usage: { input: 8, output: 4 } }],
        }],
      },
    },
    {
      role: 'pm',
      input: 'Have the RA check the doc for outdated references.',
      context: { activeDocument: 'research/lit-review.md', selection: 'a selected span' },
      model: {
        attempts: [{
          turns: [
            { toolCalls: [{ tool: 'dispatch_agent', args: { agent_slug: 'ra', task: 'Check research/lit-review.md for outdated references.' } }] },
            { text: 'Dispatched.', usage: { input: 9, output: 4 } },
          ],
        }],
      },
    },
    {
      role: 'ra',
      input: 'Check research/lit-review.md for outdated references.',
      dispatchedBy: 1,
      model: {
        attempts: [{
          turns: [{ text: 'Two references are outdated.', usage: { input: 8, output: 4 } }],
        }],
      },
    },
  ],
  assert: async (ctx) => {
    const writerObs = ctx.driver.observations.find((o) => o.role === 'writer');
    ctx.check('writer prompt carries the persisted active document',
      writerObs?.prompt?.includes('The user currently has research/lit-review.md open'),
      writerObs?.prompt);
    const pmObs = ctx.driver.observations.find((o) => o.role === 'pm' && o.prompt?.includes('Have the RA check'));
    ctx.check('pm prompt carries the active document', pmObs?.prompt?.includes('research/lit-review.md open'));
    const raObs = ctx.driver.observations.find((o) => o.role === 'ra');
    ctx.check('child inherits the active document', raObs?.prompt?.includes('research/lit-review.md open'), raObs?.prompt);
    ctx.check('child does NOT inherit the selection', !(raObs?.prompt ?? '').includes('a selected span'));
  },
};

/** 11 — Nested dispatch with parent/child/user attribution. */
export const subagentDispatch = {
  id: 'subagent-dispatch',
  title: 'Dispatched children get their own jobs/conversations, run in attribution, and report back',
  fixture: {
    files: { 'draft/main.md': 'Draft base.\n' },
    literature: {
      pmids: {
        '38450214': {
          title: 'Metformin and cardioprotection: a systematic review',
          authors: ['Smith, Jane', 'Doe, Alan'],
          journal: 'Journal of Test Medicine',
          pubdate: '2024 Jan 15',
          doi: '10.1000/test.2024.38450214',
        },
      },
      searches: { 'metformin cardioprotective': ['38450214'] },
    },
  },
  tasks: [
    {
      role: 'pm',
      input: 'Find a metformin review and file it under research/.',
      model: {
        attempts: [{
          turns: [
            { toolCalls: [{ tool: 'dispatch_agent', args: { agent_slug: 'ra', task: 'Search for the metformin cardioprotection review and save a note to research/finding.md' } }] },
            { text: 'Research complete; the note is saved.', usage: { input: 10, output: 5 } },
          ],
        }],
      },
    },
    {
      role: 'ra',
      input: 'Search for the metformin cardioprotection review and save a note to research/finding.md',
      dispatchedBy: 0,
      model: {
        attempts: [{
          turns: [
            { toolCalls: [{ tool: 'pubmed_search', args: { query: 'metformin cardioprotective' } }] },
            { toolCalls: [{ tool: 'write_file', args: { path: 'research/finding.md', content: 'smith2024 — systematic review of metformin cardioprotection.\n' } }] },
            { text: 'Filed research/finding.md with the smith2024 review.', usage: { input: 9, output: 4 } },
          ],
        }],
      },
    },
  ],
  assert: async (ctx) => {
    const jobs = ctx.jobs();
    const pmJob = jobs.find((j) => j.role === 'pm');
    const raJob = jobs.find((j) => j.role === 'ra');
    ctx.check('two jobs exist', jobs.length === 2, JSON.stringify(jobs.map((j) => j.role)));
    ctx.check('child job linked to parent', raJob?.parent_job_id === pmJob?.id);
    ctx.check('both jobs done', pmJob?.status === 'done' && raJob?.status === 'done');
    ctx.check('both jobs carry the acting user', pmJob?.user_id != null && raJob?.user_id === pmJob.user_id);
    ctx.check('two conversations (one per run)', ctx.conversations().length === 2);
    ctx.check('child file written directly', (await ctx.read('research/finding.md'))?.includes('smith2024'));
    const pmResult = ctx.toolMessages(pmJob?.conversation_id);
    ctx.check('parent received the child final text as the tool result',
      pmResult.some((m) => /Filed research\/finding\.md/.test(m.content ?? '')),
      JSON.stringify(pmResult.map((m) => m.content)));
    // The parent's live stream forwards the child's progress (forwarded
    // events carry the child's jobId, so filter on agent identity).
    const forwarded = ctx.events.filter((e) => e.type === 'text' && e.agent === 'ra');
    ctx.check('child progress forwarded into the parent channel', forwarded.some((e) => /Filed/.test(e.content)));
  },
};

/** 12 — Max dispatch depth: the third tier cannot dispatch further. */
export const dispatchDepthLimit = {
  id: 'max-dispatch-depth',
  title: 'At maxDispatchDepth the spawn tool is withheld; deeper calls fail as unavailable',
  tasks: [
    {
      role: 'pm',
      input: 'Have the writer tighten the abstract, with a second writer pass for polish.',
      model: {
        attempts: [{
          turns: [
            { toolCalls: [{ tool: 'dispatch_agent', args: { agent_slug: 'writer', task: 'Tighten the abstract, then dispatch a second writer pass to polish the result.' } }] },
            { text: 'Done.', usage: { input: 8, output: 3 } },
          ],
        }],
      },
    },
    {
      role: 'writer',
      input: 'Tighten the abstract, then dispatch a second writer pass to polish the result.',
      dispatchedBy: 0,
      model: {
        attempts: [{
          turns: [
            { toolCalls: [{ tool: 'dispatch_agent', args: { agent_slug: 'writer', task: 'Polish the tightened abstract.' } }] },
            { text: 'First pass done; second pass dispatched.', usage: { input: 8, output: 3 } },
          ],
        }],
      },
    },
    {
      role: 'writer',
      input: 'Polish the tightened abstract.',
      dispatchedBy: 1,
      model: {
        attempts: [{
          turns: [
            // depth 2 == maxDispatchDepth: the tool must be withheld even
            // though the writer role normally has the spawn grant.
            { toolCalls: [{ tool: 'dispatch_agent', args: { agent_slug: 'ra', task: 'You cannot do this level.' } }] },
            { text: 'I cannot dispatch further; I polished the abstract myself.', usage: { input: 8, output: 3 } },
          ],
        }],
      },
    },
  ],
  assert: async (ctx) => {
    const jobs = ctx.jobs();
    ctx.check('three jobs (three tiers)', jobs.length === 3, JSON.stringify(jobs.map((j) => j.role)));
    // The depth-2 writer is the LAST writer observation (FIFO role queue).
    const writerObs = ctx.driver.observations.filter((o) => o.role === 'writer').at(-1);
    ctx.check('depth-2 writer has no dispatch_agent tool',
      writerObs && !writerObs.mcpToolNames.includes('dispatch_agent'),
      JSON.stringify(writerObs?.mcpToolNames));
    const writerJob = jobs.filter((j) => j.role === 'writer').at(-1);
    const writerConv = ctx.conversations().find((c) => c.id === writerJob?.conversation_id);
    const toolMsgs = ctx.toolMessages(writerConv?.id);
    ctx.check('the withheld call surfaced as a tool error',
      toolMsgs.some((m) => m.is_error === 1 && /not available|not found/i.test(m.content ?? '')));
    ctx.check('all three jobs completed', jobs.every((j) => j.status === 'done'));
  },
};

/** 13 — Shared budget: weighted accounting trips the budget with a clean stop. */
export const sharedBudget = {
  id: 'shared-budget',
  title: 'A run over the weighted token budget stops with a budget_exceeded terminal',
  tasks: [{
    role: 'pm',
    input: 'Plan the full project.',
    internal: { budget: { used: 90000, limit: 100000 } },
    model: {
      attempts: [{
        turns: [
          { text: 'Phase one outline.', toolCalls: [{ tool: 'list_files', args: {} }], usage: { input: 5000, output: 500 } },
          // 90000 + 5500 + 22000*1 = 117500 > 100000 * 1.1 → stop after this message.
          { text: 'Phase two outline, in great detail.', usage: { input: 20000, output: 2000 } },
        ],
      }],
    },
  }],
  expectTerminal: 'error',
  jobStatus: 'error',
  assert: async (ctx) => {
    const err = ctx.lastEventOf('error');
    ctx.check('error event carries the budget_exceeded reason', err?.reason === 'budget_exceeded', JSON.stringify(err));
    ctx.check('error event reports the weighted budget',
      err?.budget?.used === 117500 && err?.budget?.limit === 100000, JSON.stringify(err?.budget));
    const job = ctx.job(ctx.runs[0].jobId);
    ctx.check('job marked error with the budget reason', job?.error === 'token budget exceeded');
    // The interrupted run's transcript must still be contract-complete: the
    // harness validator checks this globally; here we check the observation.
    const obs = ctx.driver.observations[0];
    ctx.check('driver recorded the interruption', obs?.interrupted === true);
  },
};
