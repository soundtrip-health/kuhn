# Pre-migration quality baseline (STH-31, baseline portion)

A small, **versioned, fully synthetic** scientific-writing evaluation corpus
plus an opt-in runner that captures a reproducible quality record for the
current (Claude) runtime — the baseline the post-migration Pi run is
compared against. This answers *"is the new runtime/model combination at
least as good for scientific writing and research?"* with objective checks
and a blinded human rubric.

**Deliverable label for this PR: conformance harness + pre-migration quality
baseline infrastructure.** Both the Claude baseline and the Pi run are
produced by the same suite; the Pi run happens once the Pi runtime is
registered with `runAgentTask` (`run.js --runtime pi`).

```
npm run eval:baseline -- --dry-run      # plan only; no credentials, no model calls
ANTHROPIC_API_KEY=... npm run eval:baseline   # capture (ONLY quota-spending path)
npx vitest run src/agents/eval/          # infrastructure tests; token-free
```

## Design rules

- **Ordinary tests never spend model quota.** The vitest suite
  (`eval.test.js`) validates the corpus, case definitions, checks, network
  fakes (against the real `search.js` code paths), and blinding machinery —
  it does not import the execution path. `run.js` is the only file that
  drives the model, and it refuses to run without `ANTHROPIC_API_KEY`.
- **Deterministic, offline execution.** All literature comes from the corpus
  fixture (`corpus/literature.json`); `network.js` intercepts `globalThis.fetch`
  (NCBI E-utilities, the arXiv API, Crossref) and serves the fixture. Any
  call that escapes the interceptor is logged in the record's
  `unmockedNetwork` field — a non-empty list means the run is not
  reproducible.
- **Unique temp `KUHN_DATA_DIR`** per run (`mkdtemp`); guidance/script
  catalog roots point at empty temp dirs, so org knowledge is exactly the
  corpus org document and nothing else. No shared state, no other
  contributor's data.
- **Synthetic but structurally real.** The corpus is a fictional trial
  (MIRAS-T2D) with internally consistent numbers, a study summary, a
  flawed first draft, PMIDs/DOIs that do not resolve on live services, and
  an org grant-writing SOP. Nothing in it is drawn from real research.

## The corpus (v1.0.0)

`corpus/` — a manifest-verified file set, hashed on load:

| File | Role in the cases |
| --- | --- |
| `notes/study-summary.md` | the only legitimate source of statistics (grounding truth) |
| `draft/main.md` | a flawed draft: overstated claims, an unsourced statistic, a wrong p-value framing |
| `org/grant-writing-sop.md` | org knowledge fixture (aim limits, page limits, budget rules) |
| `literature.json` | fixture PubMed/arXiv records + query→PMID map, served by the fetch interceptor |
| `data/primary-endpoints.csv` | the analyst case's dataset |

The corpus version and SHA-256 are recorded in every result record; changing
any corpus file changes the hash, which is how "same fixtures" is checked
across runs.

## The nine cases

| Case | Role | What it exercises |
| --- | --- | --- |
| `pm-project-setup` | pm | project setup through the intake interview (config save, required fields) |
| `writer-grant-aims` | writer | Specific Aims page grounded in the org SOP + source notes + real literature |
| `writer-manuscript-section` | writer | a Results section using **only** the reported statistics (no invented numbers) |
| `writer-narrow-edit` | writer | one precise edit, nothing else (edit precision) |
| `ra-literature-research` | ra | finds, verifies, and annotates evidence; citation discipline (STH-49: identifier-driven references, field-level verification) |
| `reviewer-manuscript-critique` | reviewer | margin comments anchored to verbatim quotes; actionable critique |
| `advisor-org-guidance` | advisor | answers from the org knowledge fixture, not parametric memory |
| `analyst-data-summary` | analyst | sandboxed R script + endpoints summary (requires `--sandbox` + Docker) |
| `pm-dispatch-subagent` | pm | project setup + dispatching the research assistant (sub-agent workflow, attribution) |

## Objective checks

Each case declares check specs (`cases.js`); the runner executes them
against the **observed effects** (files, references, comments, config, jobs,
tool calls, terminal state) — `checks.js`. Every check is flagged
`invariant: true` or rubric-input.

**Hard product/safety invariants are pass/fail and are never averaged into
prose quality.** A run that fails an invariant (fabricated citation,
out-of-scope file write, denied tool call, ungrounded number, config not
saved, missing child job, …) is failed, full stop. Examples:

- `citations-valid` / `refs-not-fabricated` — every cited key exists in the
  store and every added reference traces to the fixture literature
- `numbers-grounded` — every decimal statistic in the output appears in the
  source text (sign-exempt, CI-range-safe)
- `diff-confined` / `writes-contained` — edits stay inside the allowed file/line set
- `comments-anchored` — every comment quotes verbatim text from the file
- `tools-within-grant` — every tool call is inside the role's DB grant
  (runtime tool names normalized to DB slugs, e.g. `write_file` → `file_write`)
- `config-saved`, `child-job` — product state actually changed

Rubric-input checks (organization, completeness signals, tool/effect
discipline details) feed the human sheet; they do not gate the run.

## Blinded rubric and scoring

`rubric.js` renders `eval-results/<run-id>/blinded-sheet.md`: each case's
prompt, output, and objective summary under an **anonymous id**
(salted hash; the salt and the id→case mapping live in the record, so the
sheet itself leaks no case identity or runtime/model/SHA). Scoring is
0–4 per criterion:

grounding · citation-correctness · instruction-adherence · completeness ·
unsupported-claims · preservation-of-source-meaning · prose-quality ·
organization · edit-precision · review-usefulness · tool-effect-discipline

The sheet explicitly instructs scorers not to average the hard invariants
into prose quality. Merge scores back with:

```
npm run eval:baseline -- --score <record.json>,<scores.json>
# scores.json: { "<caseId>": { "prose-quality": 3, "grounding": 4, ... } }
```

## Result record format (`eval-results/<run-id>.json`)

Created by `conformance/result.js` (format version 1.0.0). Self-describing
so two runs diff objectively — same `git.sha`, `fixtures.hash`, and
`config` means the only variables are `runtime` and `model`:

```
{ format, suite: 'quality-baseline', runtime, provider, model: {byRole},
  git: { sha, branch }, fixtures: { version, hash, name },
  config: { tokenBudget, budgetGrace, maxDispatchDepth, questionTimeoutMs,
            retry, modelWeights, models, sandbox, network },
  startedAt,
  entries: [ { id, status, ok, violations[], objective, rubric,
               usage: {input, output, cacheRead, cacheWrite}, latencyMs,
               extra: { observation: { files, comments, references, ...
                                        networkPassthroughs } } } ],
  summary: { total, passed, failed, violations[] },
  extra: { label, corpusVersion, blinded: { salt, mapping },
           unmockedNetwork[], dataDir } }
```

The record never contains credentials or raw provider message objects.

## Capture procedure

```
cd agent-backend
ANTHROPIC_API_KEY=sk-ant-... npm run eval:baseline            # all cases (no Docker needed)
ANTHROPIC_API_KEY=sk-ant-... npm run eval:baseline -- --sandbox   # + analyst case
ANTHROPIC_API_KEY=sk-ant-... npm run eval:baseline -- --case writer-narrow-edit --repeat 3
```

For the post-migration comparison, run the identical command with
`--runtime pi` after the Pi runtime is registered; diff the two records'
`entries[].objective` + merged `entries[].rubric`.

If credentials are unavailable, the harness is complete as delivered:
`--dry-run` proves the plan, the vitest suite proves the machinery, and the
exact capture command is printed on refusal (exit code 2).

## Layout

```
eval/
├── run.js          # opt-in CLI: validate → (dry-run | execute) → record + sheet
├── runner.js       # one case: purge throwaway DB, seed fixture, real model, observe, check
├── cases.js        # the nine case definitions (prompts, fixtures, check specs)
├── corpus.js       # manifest load + canonical content hash
├── network.js      # fetch interceptor: eutils, arXiv (search + id_list), Crossref
├── checks.js       # objective check implementations (invariants + rubric inputs)
├── rubric.js       # blinding, sheet rendering, score merging
├── eval.test.js    # token-free infrastructure tests
└── corpus/         # the versioned synthetic corpus (manifest.json + files)
```
