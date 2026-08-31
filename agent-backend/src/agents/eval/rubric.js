/**
 * Blinded rubric sheet (STH-31).
 *
 * Human evaluation of the baseline outputs is blinded: the sheet presents
 * each case's prompt, output, and effects under an anonymized case id
 * (salted hash — the salt lives in the result record so the mapping is
 * recoverable from the record, never from the sheet), with no runtime,
 * model, or git information.
 *
 * Hard invariants are shown pass/fail. Raters are instructed to keep them
 * out of the prose-quality score: a run that fabricates a citation or
 * writes outside its allowed paths fails the case regardless of how good
 * the prose is — averaging would hide exactly the regression the
 * migration exists to catch.
 */
import { createHash } from 'node:crypto';

export const RUBRIC_CRITERIA = [
  { id: 'grounding', label: 'Grounding' },
  { id: 'citation-correctness', label: 'Citation correctness' },
  { id: 'instruction-adherence', label: 'Instruction adherence' },
  { id: 'completeness', label: 'Completeness' },
  { id: 'unsupported-claims', label: 'Absence of unsupported claims' },
  { id: 'preservation-of-source-meaning', label: 'Preservation of source meaning' },
  { id: 'prose-quality', label: 'Prose quality' },
  { id: 'organization', label: 'Organization' },
  { id: 'edit-precision', label: 'Edit precision' },
  { id: 'review-usefulness', label: 'Review usefulness' },
  { id: 'tool-effect-discipline', label: 'Tool / effect discipline' },
];

/** Random per-run salt (hex); stored in the result record's extra.blinded. */
export function makeSalt() {
  return createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);
}

/** Deterministic, non-guessable case id: C-<12 hex chars of sha256>. */
export function blindCaseId(caseId, salt) {
  return `C-${createHash('sha256').update(`${salt}:${caseId}`).digest('hex').slice(0, 12)}`;
}

function truncate(text, max = 6000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n\n[truncated at ${max} chars]` : s;
}

/** Human-facing effect summary from an observation. */
function effectsSummary(obs) {
  if (!obs) return '_(case skipped — no output)_';
  const lines = [];
  const original = obs.originalFiles ?? {};
  const created = Object.keys(obs.files).filter((p) => original[p] == null);
  const modified = Object.keys(obs.files).filter((p) => original[p] != null && obs.files[p] !== original[p]);
  const untouched = Object.keys(obs.files).filter((p) => original[p] != null && obs.files[p] === original[p]);
  lines.push(`- files created: ${created.join(', ') || 'none'}`);
  lines.push(`- files modified: ${modified.join(', ') || 'none'}`);
  lines.push(`- files present, unchanged: ${untouched.join(', ') || 'none'}`);
  if (obs.references?.length > 0) {
    lines.push(`- bibliography entries: ${obs.references.map((r) => r.cite_key).join(', ')}`);
  }
  if (obs.comments?.length > 0) {
    lines.push(`- margin comments (${obs.comments.length}):`);
    for (const c of obs.comments) {
      lines.push(`  - ${c.path}: “${truncate(c.quote, 200)}” — ${truncate(c.body, 400)}`);
    }
  }
  if (obs.projectConfig) {
    lines.push(`- project config saved: ${truncate(JSON.stringify(obs.projectConfig), 500)}`);
  }
  if (obs.jobs?.length > 0) {
    lines.push(`- jobs: ${obs.jobs.map((j) => `${j.role} (job ${j.id}${j.parent_job_id ? `, child of ${j.parent_job_id}` : ''}): ${j.status}`).join('; ')}`);
  }
  if (obs.qaTranscript?.length > 0) {
    lines.push('- Q&A during the run:');
    for (const { q, a } of obs.qaTranscript) {
      lines.push(`  - Q: ${truncate(q, 300)}`);
      lines.push(`  - A (user, canned): ${truncate(a, 300)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render the blinded evaluation sheet.
 * @param {Array<object>} cases - case definitions (prompt, role)
 * @param {Array<object>} entries - result entries (objective + extra.observation)
 * @param {string} salt - the per-run salt
 * @returns {string} markdown
 */
export function renderBlindedSheet(cases, entries, salt) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const lines = [
    '# Quality-baseline blinded evaluation sheet',
    '',
    'Instructions for raters:',
    '- Score each case 0–4 on the criteria relevant to it (see the case note); leave irrelevant criteria blank.',
    '- The pass/fail invariants listed per case are HARD product checks. They must NOT be averaged into any prose-quality score — a case can have excellent prose and still fail a safety invariant (or vice versa).',
    '- Score only what is shown here. You are not told which runtime or model produced an output; do not guess from style.',
    '',
    'Anchor scale: **0** = fails the criterion entirely · **1** = major problems, not usable as-is · **2** = usable with significant revision · **3** = solid, minor issues only · **4** = exemplary for this task.',
    '',
  ];
  for (const caseDef of cases) {
    const entry = byId.get(caseDef.id);
    if (!entry) continue;
    const blindId = blindCaseId(caseDef.id, salt);
    const obs = entry.extra?.observation;
    lines.push(`---`, '');
    lines.push(`## ${blindId} — ${caseDef.role} role`);
    lines.push('');
    lines.push(`**Task.** ${caseDef.prompt}`);
    lines.push('');
    if (caseDef.rubricFocus?.length) {
      lines.push(`**Rubric focus for this case:** ${caseDef.rubricFocus.join(', ')}.`, '');
    }
    if (entry.status === 'skipped') {
      lines.push(`**Status.** Skipped: ${entry.objective?.reason ?? 'no reason recorded'}.`, '');
      continue;
    }
    lines.push('### Output (final assistant text)');
    lines.push('');
    lines.push(truncate(obs?.finalText ?? obs?.allText ?? '(no assistant text recorded)'));
    lines.push('');
    lines.push('### Effects');
    lines.push('');
    lines.push(effectsSummary(obs));
    lines.push('');
    lines.push('### Hard invariants (pass/fail — do NOT average into prose scores)');
    lines.push('');
    for (const inv of entry.objective?.invariants ?? []) {
      lines.push(`- [${inv.pass ? 'PASS' : 'FAIL'}] ${inv.name} — ${inv.detail}`);
    }
    lines.push('');
    lines.push('### Objective quality checks (informational)');
    lines.push('');
    for (const chk of entry.objective?.checks ?? []) {
      lines.push(`- [${chk.pass ? 'PASS' : 'FAIL'}] ${chk.name} — ${chk.detail}`);
    }
    lines.push('');
    lines.push('### Rubric (score 0–4; blank = not applicable)');
    lines.push('');
    lines.push('| Criterion | Score (0–4) | Note |');
    lines.push('|---|---|---|');
    for (const c of RUBRIC_CRITERIA) {
      const marker = caseDef.rubricFocus?.includes(c.id) ? ' (focus)' : '';
      lines.push(`| ${c.label}${marker} |  |  |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Merge human rubric scores into an existing result record.
 * @param {object} record - the parsed result record
 * @param {object} scores - { [caseId]: { [criterionId]: number (0–4), ... } }
 * @returns {string[]} problems (empty when clean)
 */
export function mergeScores(record, scores) {
  const problems = [];
  const validIds = new Set(record.entries.map((e) => e.id));
  const validCriteria = new Set(RUBRIC_CRITERIA.map((c) => c.id));
  for (const [caseId, rubric] of Object.entries(scores)) {
    if (!validIds.has(caseId)) {
      problems.push(`unknown case id in scores: ${caseId}`);
      continue;
    }
    const cleaned = {};
    for (const [criterion, value] of Object.entries(rubric)) {
      if (!validCriteria.has(criterion)) {
        problems.push(`unknown criterion '${criterion}' for ${caseId}`);
        continue;
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 4) {
        problems.push(`score for ${caseId}/${criterion} must be an integer 0–4 (got ${value})`);
        continue;
      }
      cleaned[criterion] = n;
    }
    record.entries.find((e) => e.id === caseId).rubric = cleaned;
  }
  // Recompute the summary (scores do not change pass/fail, but keep it honest).
  const passed = record.entries.filter((e) => e.ok).length;
  record.summary = {
    total: record.entries.length,
    passed,
    failed: record.entries.length - passed,
    violations: record.entries.flatMap((e) => e.violations ?? []),
    scored: record.entries.filter((e) => e.rubric != null).length,
  };
  return problems;
}
