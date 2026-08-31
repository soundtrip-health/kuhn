/**
 * Quality-baseline infrastructure tests (STH-31).
 *
 * These tests are token-free: they validate the corpus, the case
 * definitions, the objective checks, the network fakes (against the REAL
 * search.js code paths), and the blinding/score-merge machinery. None of
 * them imports the runner's execution path or the model.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadCorpus, composeCaseFixture } from './corpus.js';
import { CASES, validateCases } from './cases.js';
import { validateCheckSpecs, runChecks, decimalsIn, normalizeToolName } from './checks.js';
import { installEvalNetwork } from './network.js';
import { blindCaseId, makeSalt, renderBlindedSheet, mergeScores, RUBRIC_CRITERIA } from './rubric.js';
import { pubmedSearch, arxivSearch, arxivFetchById, crossrefFetchByDoi } from '../search.js';

let corpus;
let net = null;

beforeAll(() => {
  corpus = loadCorpus();
  net = installEvalNetwork(corpus.literature);
});

afterAll(() => {
  net?.restore();
});

describe('corpus integrity', () => {
  it('loads the manifest and every listed file', () => {
    expect(corpus.version).toBe('1.0.0');
    expect(corpus.manifest.files.length).toBeGreaterThanOrEqual(6);
    for (const entry of corpus.manifest.files) {
      expect(corpus.files[entry.path]).toBeDefined();
    }
  });

  it('computes a stable content hash across loads', () => {
    const again = loadCorpus();
    expect(again.hash).toBe(corpus.hash);
    expect(again.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('composes case fixtures only from corpus files', () => {
    for (const c of CASES) {
      const spec = composeCaseFixture(corpus, c.fixture);
      for (const content of Object.values(spec.files)) {
        expect(content.length).toBeGreaterThan(0);
      }
      expect(Object.keys(spec.literature.pmids).length).toBeLessThanOrEqual(Object.keys(corpus.literature.pmids).length);
    }
  });
});

describe('case definitions', () => {
  it('validate cleanly (ids, prompts, check specs)', () => {
    expect(validateCases(CASES)).toEqual([]);
    for (const c of CASES) expect(validateCheckSpecs(c)).toEqual([]);
  });

  it('cover all six roles and a sub-agent workflow', () => {
    const roles = new Set(CASES.map((c) => c.role));
    for (const slug of ['pm', 'writer', 'ra', 'advisor', 'reviewer', 'analyst']) {
      expect(roles.has(slug), `role ${slug} missing`).toBe(true);
    }
    expect(CASES.some((c) => c.id === 'pm-dispatch-subagent')).toBe(true);
  });

  it('marks every invariant check explicitly', () => {
    for (const c of CASES) {
      for (const check of c.checks) expect(check.invariant).toBeTypeOf('boolean');
    }
  });
});

describe('network fakes drive the real search.js code paths', () => {
  it('pubmedSearch returns fixture records for a scripted query', async () => {
    const hits = await pubmedSearch('GLP-1 receptor agonists heart failure hospitalization', 10);
    expect(hits.map((h) => h.pmid)).toContain('39120455');
    const rec = hits.find((h) => h.pmid === '39120455');
    expect(rec.title).toContain('heart failure');
    expect(rec.authors).toContain('Chen, Wei');
    expect(rec.journal).toBe('Circulation');
    expect(rec.doi).toBe('10.1161/CIR.0000000000001245');
  });

  it('pubmedSearch returns empty for unknown topics (no network fallback)', async () => {
    const hits = await pubmedSearch('quantum entanglement in bananas', 10);
    expect(hits).toEqual([]);
  });

  it('respects max_results', async () => {
    const hits = await pubmedSearch('metformin cardioprotection OR glp-1 heart failure OR sglt2 myocardial infarction', 2);
    // The substring map matches the first fixture key contained in the query;
    // whatever it resolves to, the retmax cap must hold.
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('arxivSearch parses the fixture Atom feed through the real parser', async () => {
    const net2 = installEvalNetwork({
      pmids: {},
      searches: {},
      arxiv: {
        'glp-1 preprint': [
          { id: 'SYN-2025-0001', title: 'Mirasatide: <mechanisms> & summary', authors: ['Doe, Jane'], summary: 'A synthetic preprint.', published: '2025-01-02' },
        ],
      },
    });
    try {
      const hits = await arxivSearch('glp-1 preprint landscape', 5);
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe('SYN-2025-0001');
      expect(hits[0].title).toBe('Mirasatide: <mechanisms> & summary');
      expect(hits[0].authors).toEqual(['Doe, Jane']);
      expect(hits[0].published).toBe('2025-01-02');
    } finally {
      net2.restore();
    }
  });

  it('arxivFetchById fetches the fixture record by id (real code path; unknown id -> null)', async () => {
    const net3 = installEvalNetwork({
      pmids: {},
      searches: {},
      arxiv: {},
      arxivIds: {
        '2401.01234v1': {
          title: 'Deep learning for metabolic disease risk prediction',
          authors: ['Rita Roe', 'Sam Cole'],
          published: '2024-01-02T17:00:00Z',
          summary: 'We predict metabolic disease risk from routine imaging.',
        },
      },
    });
    try {
      const entry = await arxivFetchById('2401.01234v1');
      expect(entry.title).toBe('Deep learning for metabolic disease risk prediction');
      expect(entry.authors).toEqual(['Rita Roe', 'Sam Cole']);
      expect(entry.published).toBe('2024-01-02T17:00:00Z');
      expect(await arxivFetchById('9999.99999')).toBeNull();
    } finally {
      net3.restore();
    }
  });

  it('crossrefFetchByDoi serves the corpus record for a fixture DOI (unknown DOI -> null)', async () => {
    const work = await crossrefFetchByDoi('10.1161/CIR.0000000000001245');
    expect(work.title).toContain('heart failure');
    expect(work.authors).toContain('Chen, Wei');
    expect(work.year).toBe('2024');
    expect(work.journal).toBe('Circulation');
    expect(await crossrefFetchByDoi('10.9999/not-registered')).toBeNull();
  });

  it('logs nothing for fully-fixture runs', () => {
    expect(net.passthroughs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Objective checks
// ---------------------------------------------------------------------------

function obs(overrides = {}) {
  return {
    role: 'writer',
    files: { 'draft/aims.md': 'Aim 1. Test [@smith2024].' },
    originalFiles: { 'notes/x.md': 'source' },
    toolCalls: [{ name: 'write_file', args: { path: 'draft/aims.md' }, isError: false }],
    toolCallsByRole: { writer: [{ name: 'write_file', args: { path: 'draft/aims.md' }, isError: false }] },
    grantedToolsByRole: { writer: ['file_read', 'file_write', 'file_list', 'add_citation', 'search_org_knowledge', 'manage_comments', 'spawn_agent'] },
    comments: [],
    references: [{ cite_key: 'smith2024', pmid: '38450214', title: 't', source_type: 'pubmed' }],
    bibText: { 'draft/references.bib': '@article{smith2024,\n  title = {t}\n}\n' },
    projectConfig: null,
    jobs: [{ id: 1, role: 'writer', status: 'done', parent_job_id: null, input_tokens: 10, output_tokens: 5 }],
    finalText: 'Aim 1. Test [@smith2024].',
    allText: 'Aim 1. Test [@smith2024].',
    fileChanges: [{ agent: 'writer', path: 'draft/aims.md', kind: 'create' }],
    fixturePmids: ['38450214'],
    groundText: 'HR 0.82 (95% CI 0.71-0.94), p=0.008',
    qaTranscript: [],
    terminal: 'done',
    ...overrides,
  };
}
const oneCheck = (id, o, args = {}) => runChecks({ id: 'x', checks: [{ id, invariant: false, args }] }, o)[0];

describe('objective checks', () => {
  it('citations-valid passes on a consistent citation and fails on an orphan key', () => {
    expect(oneCheck('citations-valid', obs()).pass).toBe(true);
    expect(oneCheck('citations-valid', obs({ allText: 'See [@ghost2025].', finalText: 'See [@ghost2025].' })).pass).toBe(false);
  });

  it('refs-not-fabricated fails when add_citation used a non-fixture PMID', () => {
    expect(oneCheck('refs-not-fabricated', obs()).pass).toBe(true);
    const o = obs();
    o.toolCalls = [{ name: 'add_citation', args: { pmid: '99999999' }, isError: false }];
    expect(oneCheck('refs-not-fabricated', o).pass).toBe(false);
    const o2 = obs();
    o2.references = [{ cite_key: 'fake2025', pmid: '12345', title: 'x', source_type: 'pubmed' }];
    expect(oneCheck('refs-not-fabricated', o2).pass).toBe(false);
  });

  it('numbers-grounded fails on an invented statistic', () => {
    const o = obs();
    o.files['draft/results.md'] = 'MACE HR 0.82, p=0.008; mortality HR 0.79, p=0.04.';
    o.allText = o.files['draft/results.md'];
    expect(oneCheck('numbers-grounded', o, { path: 'draft/results.md' }).pass).toBe(false);
    o.files['draft/results.md'] = 'MACE HR 0.82 (95% CI 0.71-0.94), p=0.008.';
    expect(oneCheck('numbers-grounded', o, { path: 'draft/results.md' }).pass).toBe(true);
  });

  it('diff-confined passes inside the allowed lines and fails outside', () => {
    const original = 'line one\nHospitalization was reduced (p<0.05).\nline three';
    const o = obs({
      originalFiles: { 'draft/main.md': original },
      files: { 'draft/main.md': 'line one\nHospitalization was reduced (p=0.003).\nline three' },
    });
    expect(oneCheck('diff-confined', o, { path: 'draft/main.md', allow: ['hospitalization'] }).pass).toBe(true);
    o.files['draft/main.md'] = 'line one\nHospitalization was reduced (p=0.003).\nline three CHANGED';
    expect(oneCheck('diff-confined', o, { path: 'draft/main.md', allow: ['hospitalization'] }).pass).toBe(false);
  });

  it('comments-anchored fails when a quote is not verbatim', () => {
    const o = obs();
    o.files['draft/main.md'] = 'The original sentence lives here.';
    o.comments = [{ id: 1, path: 'draft/main.md', quote: 'The original sentence live here.', body: 'typo' }];
    expect(oneCheck('comments-anchored', o).pass).toBe(false);
    o.comments[0].quote = 'The original sentence lives here';
    expect(oneCheck('comments-anchored', o).pass).toBe(true);
  });

  it('tools-within-grant judges each role against its own grant', () => {
    expect(oneCheck('tools-within-grant', obs()).pass).toBe(true);
    const o = obs();
    o.toolCallsByRole = { writer: [{ name: 'pubmed_search', args: {}, isError: false }] };
    expect(oneCheck('tools-within-grant', o).pass).toBe(false);
    // A child's call is judged against the child's grant, not the parent's.
    const o2 = obs();
    o2.toolCallsByRole = {
      pm: [{ name: 'spawn_agent', args: {}, isError: false }],
      ra: [{ name: 'add_citation', args: { pmid: '38450214' }, isError: false }],
    };
    o2.grantedToolsByRole = { pm: ['spawn_agent', 'project_config'], ra: ['add_citation', 'pubmed_search'] };
    expect(oneCheck('tools-within-grant', o2).pass).toBe(true);
  });

  it('writes-contained catches a stray file outside the allowed prefixes', () => {
    const o = obs();
    o.files['../escape.md'] = 'nope';
    o.fileChanges = [{ agent: 'writer', path: 'draft/aims.md', kind: 'create' }, { agent: 'writer', path: '../escape.md', kind: 'create' }];
    expect(oneCheck('writes-contained', o, { allowed: ['draft/'] }).pass).toBe(false);
  });

  it('config-saved enforces project_type and required fields', () => {
    const o = obs();
    o.projectConfig = { title: 'X', project_type: 'grant', research_question: 'q', timeline: 't', deliverables: ['a'] };
    expect(oneCheck('config-saved', o, { project_type: 'grant', nonEmpty: ['title', 'research_question', 'timeline'], minDeliverables: 1 }).pass).toBe(true);
    o.projectConfig.project_type = 'sop';
    expect(oneCheck('config-saved', o, { project_type: 'grant' }).pass).toBe(false);
  });

  it('child-job requires a parented job of the role at the expected status', () => {
    expect(oneCheck('child-job', obs(), { role: 'ra', status: 'done' }).pass).toBe(false);
    const o = obs();
    o.jobs.push({ id: 2, role: 'ra', status: 'done', parent_job_id: 1, input_tokens: 1, output_tokens: 1 });
    expect(oneCheck('child-job', o, { role: 'ra', status: 'done' }).pass).toBe(true);
  });
});

describe('helpers', () => {
  it('normalizeToolName strips the MCP prefix and maps aliases', () => {
    expect(normalizeToolName('mcp__kuhn__write_file')).toBe('file_write');
    expect(normalizeToolName('mcp__kuhn__read_file')).toBe('file_read');
    expect(normalizeToolName('mcp__kuhn__update_reference')).toBe('manage_references');
    expect(normalizeToolName('mcp__kuhn__list_scripts')).toBe('run_script');
  });

  it('decimalsIn extracts only decimal numbers', () => {
    expect(decimalsIn('HR 0.82 (95% CI 0.71-0.94), n=1240, p=0.008, week 52')).toEqual(['0.82', '0.71', '0.94', '0.008']);
  });
});

// ---------------------------------------------------------------------------
// Blinding + score merging
// ---------------------------------------------------------------------------

describe('blinding and scoring', () => {
  const caseDef = CASES.find((c) => c.id === 'writer-manuscript-section');
  const entry = {
    id: caseDef.id,
    ok: true,
    status: 'passed',
    violations: [],
    objective: {
      invariants: [{ name: 'every statistic traces to the fixture', pass: true, detail: 'ok' }],
      checks: [{ name: 'key statistics reported', pass: true, detail: 'ok' }],
    },
    usage: { inputTokens: 100, outputTokens: 50 },
    latencyMs: 4200,
    rubric: null,
    extra: {
      observation: {
        files: { 'draft/results.md': 'Results text.' },
        originalFiles: {},
        toolCalls: [],
        toolCallsByRole: {},
        comments: [],
        references: [],
        projectConfig: null,
        jobs: [{ id: 1, role: 'writer', status: 'done', parent_job_id: null }],
        finalText: 'MACE HR 0.82 (95% CI 0.71-0.94), p=0.008.',
        allText: 'MACE HR 0.82 (95% CI 0.71-0.94), p=0.008.',
        fileChanges: [],
        fixturePmids: [],
        groundText: '',
        qaTranscript: [],
        terminal: 'done',
      },
    },
  };
  const salt = 'testsalt12345678';

  it('blind ids are deterministic and do not leak the case id', () => {
    const a = blindCaseId('writer-manuscript-section', salt);
    const b = blindCaseId('writer-manuscript-section', salt);
    const c = blindCaseId('writer-manuscript-section', 'other-salt');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('C-')).toBe(true);
    expect(a).not.toContain('writer-manuscript');
  });

  it('the sheet hides runtime information but shows the task and invariants', () => {
    const sheet = renderBlindedSheet([caseDef], [entry], salt);
    expect(sheet).toContain(blindCaseId(caseDef.id, salt));
    expect(sheet).not.toContain('writer-manuscript-section');
    expect(sheet).not.toContain('claude');
    expect(sheet).toContain('MACE HR 0.82');
    expect(sheet).toContain('[PASS] every statistic traces to the fixture');
    expect(sheet).toContain('do NOT average into prose scores');
    for (const c of RUBRIC_CRITERIA) expect(sheet).toContain(c.label);
  });

  it('mergeScores validates and writes scores into the record', () => {
    const record = {
      format: '1.0.0',
      suite: 'quality-baseline',
      entries: [entry],
      summary: { total: 1, passed: 1, failed: 0, violations: [] },
    };
    expect(mergeScores(record, { [caseDef.id]: { 'prose-quality': 3, 'grounding': 'x' } }))
      .toEqual([expect.stringContaining('grounding')]);
    expect(mergeScores(record, { [caseDef.id]: { 'prose-quality': 3, 'grounding': 4 } })).toEqual([]);
    expect(record.entries[0].rubric).toEqual({ 'prose-quality': 3, grounding: 4 });
    expect(record.summary.scored).toBe(1);
    expect(mergeScores(record, { 'nope': {} })).toEqual([expect.stringContaining('nope')]);
  });
});

describe('dry run (token-free smoke of the CLI)', () => {
  it('validates the corpus/cases and prints the plan without credentials', () => {
    const out = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./run.js', import.meta.url)), '--dry-run'],
      { encoding: 'utf-8', env: { ...process.env, ANTHROPIC_API_KEY: '' } },
    );
    expect(out).toContain('dry run');
    expect(out).toContain('pm-project-setup');
    expect(out).toContain('analyst-data-summary');
    expect(out).toContain('needs --sandbox + docker');
  });

  it('refuses to execute without credentials (exit 2)', () => {
    let code = 0;
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./run.js', import.meta.url)), '--case', 'pm-project-setup'],
        { encoding: 'utf-8', env: { ...process.env, ANTHROPIC_API_KEY: '' }, stdio: 'pipe' },
      );
    } catch (err) {
      code = err.status;
      stderr = String(err.stderr ?? '');
    }
    expect(code).toBe(2);
    expect(stderr).toContain('ANTHROPIC_API_KEY');
  });
});
