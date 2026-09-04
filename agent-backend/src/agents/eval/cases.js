/**
 * Quality-baseline evaluation cases (STH-31).
 *
 * One case = one realistic user request to one Kuhn role, driven against a
 * fixture composed from the synthetic corpus (corpus/). Cases cover all six
 * roles where appropriate:
 *
 *   pm-project-setup          pm       grant project setup (interview + config)
 *   writer-grant-aims         writer   grant drafting with literature search
 *   writer-manuscript-section writer   manuscript drafting grounded in data
 *   writer-narrow-edit        writer   narrow edit precision
 *   ra-literature-research    ra       research with known references + citation correctness
 *   reviewer-manuscript-critique reviewer  critique via anchored margin comments
 *   advisor-org-guidance      advisor  guidance grounded in org knowledge
 *   analyst-data-summary      analyst  sandboxed R analysis (Docker-dependent)
 *   pm-dispatch-subagent      pm       sub-agent workflow (parent/child attribution)
 *
 * The same case definitions will later run unchanged against the Pi runtime:
 * prompts, fixtures, and checks speak Kuhn-only terms; the runner is the
 * runtime seam (see run.js --runtime).
 *
 * `checks` uses the registry in checks.js. `invariant: true` marks hard
 * product/safety checks that are pass/fail and never averaged into rubric
 * prose scores.
 */

/** The one interview answer the pm cases rely on when the pm asks. */
const PM_SCOPE_REPLY =
  'Scope: 5-year NIH R01. Aim 1 — post-MI efficacy cohort (n=1500, primary ' +
  'endpoint MACE at 3 years). Aim 2 — biomarker prediction (nested cohort, ' +
  'NT-proBNP and CRP at 12 weeks). Aim 3 — long-term safety and adherence ' +
  '(3-year follow-up). Target submission Q3; first milestone is the pilot ' +
  'data write-up at month 12. Team: me (PI) plus one co-PI in biostatistics. ' +
  'Budget target is under $4.5M total direct costs. That covers it — proceed ' +
  'with what we have discussed.';

export const CASES = [
  {
    id: 'pm-project-setup',
    title: 'PM sets up a grant project through the intake interview',
    role: 'pm',
    rubricFocus: ['instruction-adherence', 'completeness', 'tool-effect-discipline'],
    fixture: {
      project: { name: 'POST-MIRAS R01', type: 'grant' },
      files: {},
      literature: [],
    },
    ground: [],
    prompt:
      'We are starting an NIH R01 application for the POST-MIRAS study — a ' +
      '5-year trial of mirasatide in type 2 diabetes patients who recently ' +
      'had a myocardial infarction. Scope: Aim 1 post-MI efficacy, Aim 2 ' +
      'biomarker mechanisms, Aim 3 long-term safety. Target submission is ' +
      'Q3; the first milestone is a pilot data write-up. I am the PI with ' +
      'one co-PI. Interview me as needed, then save the project configuration.',
    context: null,
    replies: [{ match: null, reply: PM_SCOPE_REPLY }],
    defaultReply: 'That covers it — proceed with what we have discussed.',
    checks: [
      {
        id: 'config-saved',
        name: 'project config saved with correct shape',
        invariant: true,
        args: {
          project_type: 'grant',
          nonEmpty: ['title', 'research_question', 'timeline'],
          minDeliverables: 1,
        },
      },
      {
        id: 'writes-contained',
        name: 'no file writes (pm files config, not files)',
        invariant: true,
        args: { allowed: [] },
      },
      { id: 'tools-within-grant', name: 'pm only used granted tools', invariant: true, args: {} },
      { id: 'job-status', name: 'pm job reached done', invariant: false, args: { role: 'pm', status: 'done' } },
    ],
  },

  {
    id: 'writer-grant-aims',
    title: 'Writer drafts a Specific Aims page grounded in source notes and real literature',
    role: 'writer',
    rubricFocus: ['grounding', 'citation-correctness', 'completeness', 'prose-quality', 'organization', 'tool-effect-discipline'],
    fixture: {
      project: { name: 'POST-MIRAS R01', type: 'grant' },
      files: { 'notes/aims-outline.md': 'notes/aims-outline.md' },
      literature: ['38450214', '39120455', '40233871'],
    },
    ground: [],
    prompt:
      'Draft the Specific Aims page for our R01. The working outline is in ' +
      'notes/aims-outline.md — turn it into a polished one-page aims page and ' +
      'write it to draft/aims.md. Ground it in the literature: search for ' +
      'relevant peer-reviewed work on GLP-1 receptor agonists and heart ' +
      'failure hospitalization, metformin cardioprotection, and SGLT2 ' +
      'inhibitors after myocardial infarction, and add 2–4 references you ' +
      'find to the project bibliography. Cite the references in the aims ' +
      'text as [@key].',
    context: null,
    replies: [],
    defaultReply: 'Go ahead with what you have.',
    checks: [
      { id: 'file-exists', name: 'aims page written to draft/aims.md', invariant: true, args: { path: 'draft/aims.md' } },
      { id: 'refs-not-fabricated', name: 'no fabricated PMIDs', invariant: true, args: {} },
      { id: 'citations-valid', name: 'in-text citations and bibliography agree', invariant: true, args: {} },
      {
        id: 'writes-contained',
        name: 'writes confined to project drafting paths',
        invariant: true,
        args: { allowed: ['draft/', 'notes/', 'research/'] },
      },
      { id: 'tools-within-grant', name: 'writer only used granted tools', invariant: true, args: {} },
      {
        id: 'text-contains',
        name: 'all three aims present',
        invariant: false,
        args: { path: 'draft/aims.md', values: ['aim 1', 'aim 2', 'aim 3'], min: 3 },
      },
      { id: 'reference-count', name: '2–4 references added', invariant: false, args: { min: 2, max: 4 } },
    ],
  },

  {
    id: 'writer-manuscript-section',
    title: 'Writer drafts a Results section using only the reported statistics',
    role: 'writer',
    rubricFocus: ['grounding', 'instruction-adherence', 'unsupported-claims', 'completeness', 'prose-quality'],
    fixture: {
      project: { name: 'MIRAS-T2D Manuscript', type: 'manuscript' },
      files: {
        'notes/study-summary.md': 'notes/study-summary.md',
        'data/primary-endpoints.csv': 'data/primary-endpoints.csv',
      },
      literature: [],
    },
    ground: ['notes/study-summary.md', 'data/primary-endpoints.csv'],
    prompt:
      'Write the Results section of the MIRAS-T2D paper and save it to ' +
      'draft/results.md. Use only the numbers in notes/study-summary.md and ' +
      'data/primary-endpoints.csv — do not invent, round, or interpolate ' +
      'statistics. Cover the primary endpoint, the key secondary endpoints ' +
      '(including the all-cause mortality result and its statistical ' +
      'significance), the glycemic effect, and the main safety finding.',
    context: null,
    replies: [],
    defaultReply: 'Go ahead with what you have.',
    checks: [
      { id: 'file-exists', name: 'Results section written to draft/results.md', invariant: true, args: { path: 'draft/results.md' } },
      {
        id: 'numbers-grounded',
        name: 'every statistic traces to the fixture',
        invariant: true,
        args: { path: 'draft/results.md' },
      },
      {
        id: 'file-unchanged',
        name: 'endpoint data left untouched',
        invariant: true,
        args: { path: 'data/primary-endpoints.csv' },
      },
      {
        id: 'writes-contained',
        name: 'writes confined to draft/',
        invariant: true,
        args: { allowed: ['draft/'] },
      },
      { id: 'tools-within-grant', name: 'writer only used granted tools', invariant: true, args: {} },
      {
        id: 'text-contains',
        name: 'key statistics reported',
        invariant: false,
        args: { path: 'draft/results.md', values: ['0.82', '0.74', '0.008', '0.003', '1.4'], min: 5 },
      },
      {
        id: 'text-contains',
        name: 'mortality result reported with its non-significance',
        invariant: false,
        args: {
          path: 'draft/results.md',
          values: [{ re: '0\\.16' }, { re: 'not\\s+(statistically\\s+)?significant' }, { re: 'did not reach statistical significance' }],
          min: 1,
        },
      },
    ],
  },

  {
    id: 'writer-narrow-edit',
    title: 'Writer performs one precise edit and nothing else',
    role: 'writer',
    rubricFocus: ['edit-precision', 'instruction-adherence', 'preservation-of-source-meaning', 'tool-effect-discipline'],
    fixture: {
      files: {
        'draft/main.md': 'draft/main.md',
        'notes/study-summary.md': 'notes/study-summary.md',
      },
      literature: [],
      project: { name: 'MIRAS-T2D Manuscript', type: 'manuscript', activeDocument: 'draft/main.md' },
    },
    ground: [],
    prompt:
      'In draft/main.md, the second Results paragraph reports heart-failure ' +
      'hospitalization with a vague "p<0.05". Replace that with the exact ' +
      'p-value from notes/study-summary.md (p=0.003). Change nothing else in ' +
      'the file — not a single character outside that fix.',
    context: { activeDocument: 'draft/main.md' },
    replies: [],
    defaultReply: 'Go ahead with what you have.',
    checks: [
      {
        id: 'text-contains',
        name: 'exact p-value now reported',
        invariant: true,
        args: { path: 'draft/main.md', values: ['p=0.003'] },
      },
      {
        id: 'diff-confined',
        name: 'edit confined to the heart-failure sentence',
        invariant: true,
        args: { path: 'draft/main.md', allow: ['hospitalization', 'heart failure'] },
      },
      {
        id: 'file-unchanged',
        name: 'study summary left untouched',
        invariant: true,
        args: { path: 'notes/study-summary.md' },
      },
      { id: 'tools-within-grant', name: 'writer only used granted tools', invariant: true, args: {} },
    ],
  },

  {
    id: 'ra-literature-research',
    title: 'Research assistant finds, verifies, and annotates the evidence',
    role: 'ra',
    rubricFocus: ['grounding', 'citation-correctness', 'completeness', 'review-usefulness', 'tool-effect-discipline'],
    fixture: {
      project: { name: 'POST-MIRAS R01', type: 'grant' },
      files: { 'notes/aims-outline.md': 'notes/aims-outline.md' },
      literature: ['38450214', '39120455', '40233871'],
    },
    ground: [],
    prompt:
      'For the background section of our grant I need the strongest ' +
      'peer-reviewed evidence on GLP-1 receptor agonists and heart-failure ' +
      'hospitalization. Search the literature, add 2–3 PubMed-verified ' +
      'references to the project bibliography (draft/references.bib), and ' +
      'write a short annotated summary — one paragraph per reference, each ' +
      'noting the design, the key result, and why it matters to our ' +
      'question — to research/evidence.md.',
    context: null,
    replies: [],
    defaultReply: 'Go ahead with what you have.',
    checks: [
      { id: 'refs-not-fabricated', name: 'no fabricated PMIDs', invariant: true, args: {} },
      {
        id: 'writes-contained',
        name: 'writes confined to bibliography and research notes',
        invariant: true,
        args: { allowed: ['draft/', 'research/'] },
      },
      { id: 'tools-within-grant', name: 'ra only used granted tools', invariant: true, args: {} },
      { id: 'file-exists', name: 'annotated summary written', invariant: false, args: { path: 'research/evidence.md' } },
      { id: 'reference-count', name: '2–4 references added', invariant: false, args: { min: 2, max: 4 } },
      { id: 'job-status', name: 'ra job reached done', invariant: false, args: { role: 'ra', status: 'done' } },
    ],
  },

  {
    id: 'reviewer-manuscript-critique',
    title: 'Reviewer critiques the draft through anchored margin comments',
    role: 'reviewer',
    rubricFocus: ['review-usefulness', 'grounding', 'instruction-adherence', 'tool-effect-discipline'],
    fixture: {
      project: { name: 'MIRAS-T2D Manuscript', type: 'manuscript' },
      files: { 'draft/main.md': 'draft/main.md' },
      literature: [],
    },
    ground: [],
    prompt:
      'Review the manuscript draft in draft/main.md. File margin comments on ' +
      'specific passages where the writing is unsupported, vague, or ' +
      'incomplete — quote the exact text you are commenting on, and say what ' +
      'the problem is and what needs to change.',
    context: { activeDocument: 'draft/main.md' },
    replies: [],
    defaultReply: 'Go ahead with what you have.',
    checks: [
      { id: 'comments-anchored', name: 'every comment quote anchors verbatim', invariant: true, args: {} },
      { id: 'comment-count', name: 'at least two comments filed', invariant: false, args: { min: 2 } },
      {
        id: 'writes-contained',
        name: 'no file writes (reviewer comments, does not edit)',
        invariant: true,
        args: { allowed: [] },
      },
      { id: 'tools-within-grant', name: 'reviewer only used granted tools', invariant: true, args: {} },
      {
        id: 'comments-cover',
        name: 'planted flaws addressed',
        invariant: false,
        args: {
          min: 2,
          sets: [
            { name: 'vague p-value', patterns: ['p<0\\.05', 'p &lt; 0\\.05'] },
            { name: 'mortality overreach', patterns: ['0\\.79', '0\\.16', 'survival benefit'] },
            { name: 'superlative claim', patterns: ['superior to all'] },
            { name: 'missing limitations', patterns: ['limitation'] },
          ],
        },
      },
    ],
  },

  {
    id: 'advisor-org-guidance',
    title: 'Advisor answers from the org knowledge library, not memory',
    role: 'advisor',
    rubricFocus: ['grounding', 'citation-correctness', 'instruction-adherence', 'review-usefulness'],
    fixture: {
      project: { name: 'POST-MIRAS R01', type: 'grant' },
      files: { 'notes/aims-outline.md': 'notes/aims-outline.md' },
      orgDocuments: [{ title: 'Grant Writing SOP', corpusKey: 'org/grant-writing-sop.md' }],
      literature: [],
    },
    ground: [],
    prompt:
      'We are building the budget for our R01 application. What does our ' +
      "organization's grant-writing SOP require for the budget section and " +
      'for key personnel? Give me the concrete rules — with the exact ' +
      'numbers — I need to check before finalizing, and where in the SOP ' +
      'they come from.',
    context: null,
    replies: [],
    defaultReply: 'Go ahead with what you have.',
    checks: [
      {
        id: 'tools-used',
        name: 'org knowledge was searched',
        invariant: true,
        args: { names: ['search_org_knowledge'], min: 1 },
      },
      {
        id: 'text-contains',
        name: 'SOP rules quoted with their numbers',
        invariant: false,
        args: { values: ['$4,500,000', '12 pages', '50 FTE', 'biosketch'], min: 2 },
      },
      {
        id: 'writes-contained',
        name: 'no stray file writes',
        invariant: true,
        args: { allowed: ['draft/', 'notes/', 'research/', 'memos/'] },
      },
      { id: 'tools-within-grant', name: 'advisor only used granted tools', invariant: true, args: {} },
      { id: 'job-status', name: 'advisor job reached done', invariant: false, args: { role: 'advisor', status: 'done' } },
    ],
  },

  {
    id: 'analyst-data-summary',
    title: 'Analyst runs a sandboxed R script and summarizes the endpoints',
    role: 'analyst',
    rubricFocus: ['grounding', 'tool-effect-discipline', 'completeness', 'instruction-adherence'],
    requiresSandbox: true,
    fixture: {
      project: { name: 'MIRAS-T2D Manuscript', type: 'manuscript' },
      files: { 'data/primary-endpoints.csv': 'data/primary-endpoints.csv' },
      literature: [],
    },
    ground: [],
    prompt:
      'Analyze data/primary-endpoints.csv. Write a small R script under ' +
      'analyst/, run it with the sandboxed script runner, and save a results ' +
      'summary to analyst/summary.md. Report the hazard ratio and p-value ' +
      'for the MACE composite and HF hospitalization endpoints, plus the ' +
      'mean hazard ratio across those two endpoints.',
    context: null,
    replies: [],
    defaultReply: 'Go ahead with what you have.',
    checks: [
      { id: 'file-exists', name: 'summary written to analyst/summary.md', invariant: true, args: { path: 'analyst/summary.md' } },
      {
        id: 'text-contains',
        name: 'endpoint statistics reported correctly',
        invariant: true,
        args: { path: 'analyst/summary.md', values: ['0.82', '0.74', '0.008', '0.003'], min: 4 },
      },
      {
        id: 'text-contains',
        name: 'mean hazard ratio computed (0.78)',
        invariant: false,
        args: { path: 'analyst/summary.md', values: [{ re: '0\\.78' }] },
      },
      {
        id: 'file-unchanged',
        name: 'input data left untouched',
        invariant: true,
        args: { path: 'data/primary-endpoints.csv' },
      },
      {
        id: 'writes-contained',
        name: 'writes confined to analyst/',
        invariant: true,
        args: { allowed: ['analyst/', 'data/'] },
      },
      { id: 'tools-within-grant', name: 'analyst only used granted tools', invariant: true, args: {} },
    ],
  },

  {
    id: 'pm-dispatch-subagent',
    title: 'PM sets up the project and dispatches the research assistant',
    role: 'pm',
    rubricFocus: ['instruction-adherence', 'completeness', 'tool-effect-discipline', 'organization'],
    fixture: {
      project: { name: 'POST-MIRAS R01', type: 'grant' },
      files: { 'notes/aims-outline.md': 'notes/aims-outline.md' },
      literature: ['38450214', '39120455', '40233871'],
    },
    ground: [],
    prompt:
      'Set up the project configuration for the POST-MIRAS R01: 5-year ' +
      'application, Aim 1 post-MI efficacy, Aim 2 biomarker mechanisms, ' +
      'Aim 3 long-term safety, target submission Q3. When the configuration ' +
      'is saved, dispatch the research assistant to add the best ' +
      'peer-reviewed reference on GLP-1 therapy and heart-failure ' +
      'hospitalization to the project bibliography, so the project starts ' +
      'with a literature base.',
    context: null,
    replies: [{ match: null, reply: PM_SCOPE_REPLY }],
    defaultReply: 'That covers it — proceed with what we have discussed.',
    checks: [
      {
        id: 'config-saved',
        name: 'project config saved with correct shape',
        invariant: true,
        args: {
          project_type: 'grant',
          nonEmpty: ['title', 'research_question', 'timeline'],
          minDeliverables: 1,
        },
      },
      {
        id: 'child-job',
        name: 'ra dispatched as a child job and completed',
        invariant: true,
        args: { role: 'ra', status: 'done' },
      },
      { id: 'refs-not-fabricated', name: 'no fabricated PMIDs', invariant: true, args: {} },
      {
        id: 'writes-contained',
        name: 'writes confined to drafting paths',
        invariant: true,
        args: { allowed: ['draft/', 'notes/'] },
      },
      { id: 'tools-within-grant', name: 'each role only used granted tools', invariant: true, args: {} },
      { id: 'reference-count', name: 'at least one reference added', invariant: false, args: { min: 1, max: 5 } },
      { id: 'job-status', name: 'parent pm job reached done', invariant: false, args: { role: 'pm', status: 'done' } },
      {
        id: 'text-contains',
        name: 'parent reports the literature work',
        invariant: false,
        args: { values: [{ re: 'literature' }, { re: 'reference' }], min: 1 },
      },
    ],
  },
];

/** Validate the case list at load time (fail fast). */
export function validateCases(cases = CASES) {
  const problems = [];
  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.id)) problems.push(`duplicate case id ${c.id}`);
    seen.add(c.id);
    if (!c.prompt || c.prompt.trim() === '') problems.push(`${c.id}: empty prompt`);
    if (!c.defaultReply) problems.push(`${c.id}: missing defaultReply`);
    if (!Array.isArray(c.checks) || c.checks.length === 0) problems.push(`${c.id}: no checks`);
  }
  return problems;
}
