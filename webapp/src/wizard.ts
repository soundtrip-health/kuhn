// Project setup wizard: a token-free, multi-step modal that collects project
// intake (type, title, research question, deliverables, timeline, seed uploads)
// and saves it via PUT /api/projects/:id/config — replacing the PM intake
// interview. Each step has a collapsible "What helps here?" guidance disclosure.
// Answers persist as a resumable draft on every step-advance and on abort;
// re-opening prefills from config.setup.answers. The final step asks whether to
// launch research + skeleton now (startSeeding) or later.

import { saveProjectConfig, uploadFiles, type WizardAnswers } from './api';
import { icon } from './icons';
import { PROJECT_TYPES } from './project-types';
import * as workspace from './workspace';
import { startSeeding } from './chat';

interface Step {
  key: string;
  title: string;
  render: (body: HTMLElement) => void;
  guidance: () => string; // HTML for the "What helps here?" disclosure
}

// Per-project-type seed-material guidance (used by the uploads step + the thin
// note on review). Keys mirror PROJECT_TYPES values.
const SEED_GUIDANCE: Record<string, string[]> = {
  manuscript: [
    'Key papers you are building on or citing',
    'Your dataset, results tables, or figures',
    'Any draft, outline, or abstract you already have',
    'Target journal + author guidelines',
  ],
  'rwe-protocol': [
    'Prior or template protocols',
    'A statistical analysis plan (SAP), if drafted',
    'Data dictionary / cohort definitions',
    'Relevant FDA guidance you must follow',
  ],
  'rct-protocol': [
    'Precedent trial protocols',
    'Draft endpoints or statistical plan',
    'Investigator brochure / product background',
    'Applicable ICH, CONSORT, or SPIRIT guidance',
  ],
  grant: [
    'The funder RFA / PA / solicitation',
    'Preliminary data and figures',
    'An aims page or prior application drafts',
    'Biosketches / team background',
  ],
  sop: [
    'Existing SOPs or templates',
    'Applicable regulatory standards (ISO / GxP)',
    'Process notes or validation data',
    'Related work instructions',
  ],
};

function seedListHtml(projectType: string): string {
  const items = SEED_GUIDANCE[projectType] ?? [
    'Any background documents you are working from',
    'Prior drafts, data, or key references',
  ];
  return `<ul>${items.map((i) => `<li>${escape(i)}</li>`).join('')}</ul>`;
}

// ---- Module state (one wizard at a time) ----
let overlay: HTMLElement | null = null;
let projectId = 0;
let stepIndex = 0;
let answers: WizardAnswers = blankAnswers();
let launchNow = true;
let saving = false;

function blankAnswers(): WizardAnswers {
  return {
    title: '', projectType: PROJECT_TYPES[0]?.value ?? 'manuscript',
    researchQuestion: '', deliverables: [], timeline: '', sourceMaterials: [],
  };
}

export function openSetupWizard(pid: number, opts: { auto?: boolean } = {}): void {
  projectId = pid;
  stepIndex = 0;
  launchNow = true;
  const project = workspace.projects().find((p) => p.id === pid);
  const saved = project?.config?.setup?.answers;
  answers = { ...blankAnswers(), ...(saved as Partial<WizardAnswers> | undefined) };
  // Seed the type from the creation-time choice when the wizard has no prior answer.
  if (!saved?.projectType && project?.project_type) answers.projectType = project.project_type;

  ensureOverlay();
  overlay!.hidden = false;
  render();

  // Auto-open stamps a draft immediately so the wizard auto-opens exactly once
  // ever; explicit re-entry from the project browser does not need this.
  if (opts.auto && !project?.config?.setup) void persistDraft();
}

function close(): void {
  if (overlay) overlay.hidden = true;
}

/** Abort: keep answers as a draft so re-entry prefills; do not launch anything. */
function abort(): void {
  if (saving) return;
  void persistDraft();
  close();
}

function ensureOverlay(): void {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'setup-wizard';
  overlay.className = 'wz-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Project setup');
  document.body.append(overlay);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) abort();
  });
}

async function persistDraft(): Promise<void> {
  try {
    const project = await saveProjectConfig(projectId, answers, true);
    workspace.applyProjectUpdate(project);
  } catch {
    /* draft persistence is best-effort */
  }
}

// ---- Steps ----
function steps(): Step[] {
  return [
    {
      key: 'type',
      title: 'What are you writing?',
      guidance: () =>
        `<p>Pick the closest match — it tunes the whole team (which literature the ` +
        `RA gathers, which conventions the Writer follows). You can change it later.</p>`,
      render: (body) => {
        const select = fieldSelect('Document type', answers.projectType,
          PROJECT_TYPES.map((t) => ({ value: t.value, label: t.label })),
          (v) => { answers.projectType = v; });
        const title = fieldText('Project title', answers.title,
          'e.g. GLP-1 receptor agonists and cardiovascular outcomes',
          (v) => { answers.title = v; });
        body.append(select, title);
      },
    },
    {
      key: 'focus',
      title: 'What is it about?',
      guidance: () =>
        `<p>One or two sentences on the central question or purpose. This is the ` +
        `single most useful thing you provide — the RA searches from it and the ` +
        `Writer frames the draft around it.</p>`,
      render: (body) => {
        body.append(fieldTextarea('Research question / purpose', answers.researchQuestion,
          'What are you trying to establish, and in whom?',
          (v) => { answers.researchQuestion = v; }));
      },
    },
    {
      key: 'scope',
      title: 'Deliverables & timeline',
      guidance: () =>
        `<p>Optional but helpful. Deliverables are the concrete outputs (e.g. ` +
        `"FDA RWE protocol", "manuscript for JAMA"). Use absolute dates in the ` +
        `timeline so the team can plan.</p>`,
      render: (body) => {
        body.append(fieldList('Deliverables', answers.deliverables,
          'Add a deliverable…', (list) => { answers.deliverables = list; }));
        body.append(fieldText('Timeline', answers.timeline,
          'e.g. Draft by 2026-08-01, submit by 2026-09-15',
          (v) => { answers.timeline = v; }));
      },
    },
    {
      key: 'seed',
      title: 'Add your materials',
      guidance: () =>
        `<p>The more you give the team to work from, the better the first draft. ` +
        `Helpful for this project type:</p>${seedListHtml(answers.projectType)}` +
        `<p>No materials? That's fine — the team will start from public literature.</p>`,
      render: (body) => {
        body.append(buildUploader());
      },
    },
    {
      key: 'review',
      title: 'Review & launch',
      guidance: () =>
        `<p>Launching now runs the research and skeleton steps from what you have. ` +
        `You can always add materials and re-run later.</p>`,
      render: (body) => {
        body.append(buildReview());
      },
    },
  ];
}

// ---- Rendering ----
function render(): void {
  if (!overlay) return;
  const list = steps();
  const step = list[stepIndex];
  const isLast = stepIndex === list.length - 1;

  const modal = document.createElement('div');
  modal.className = 'wz-modal';

  // Header: step counter + progress dots + title
  const head = document.createElement('header');
  head.className = 'wz-head';
  head.innerHTML =
    `<div class="wz-eyebrow">Project setup · ${stepIndex + 1} of ${list.length}</div>` +
    `<h2 class="wz-title"></h2>` +
    `<div class="wz-dots">${list.map((_, i) =>
      `<span class="wz-dot${i === stepIndex ? ' is-on' : ''}"></span>`).join('')}</div>`;
  (head.querySelector('.wz-title') as HTMLElement).textContent = step.title;

  // Body: the step's fields
  const body = document.createElement('div');
  body.className = 'wz-body';
  step.render(body);

  // Guidance disclosure ("rollup") — collapsed by default
  const details = document.createElement('details');
  details.className = 'wz-guide';
  details.innerHTML = `<summary>What helps here?</summary><div class="wz-guide-body">${step.guidance()}</div>`;

  // Footer: nav
  const foot = document.createElement('footer');
  foot.className = 'wz-foot';
  const left = document.createElement('div');
  const skip = textButton(stepIndex === 0 ? 'Skip for now' : 'Save & close', () => abort());
  skip.className = 'btn btn-quiet btn-sm';
  left.append(skip);

  const right = document.createElement('div');
  right.className = 'wz-foot-right';
  if (stepIndex > 0) {
    const back = textButton('Back', () => { stepIndex -= 1; render(); });
    back.className = 'btn btn-ghost btn-sm';
    right.append(back);
  }
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'btn btn-accent btn-sm';
  next.disabled = saving;
  next.textContent = isLast ? (launchNow ? 'Finish & launch' : 'Finish') : 'Next';
  next.addEventListener('click', () => void advance(isLast));
  right.append(next);

  foot.append(left, right);
  modal.append(head, body, details, foot);
  overlay.replaceChildren(modal);
}

async function advance(isLast: boolean): Promise<void> {
  // Per-step minimal gating: type+title on step 0, research question on step 1.
  const list = steps();
  const key = list[stepIndex].key;
  if (key === 'type' && !answers.title.trim()) { flashInvalid(); return; }
  if (key === 'focus' && !answers.researchQuestion.trim()) { flashInvalid(); return; }

  if (!isLast) {
    void persistDraft(); // fire-and-forget; keeps the draft resumable
    stepIndex += 1;
    render();
    return;
  }

  // Final save.
  saving = true;
  render();
  try {
    const project = await saveProjectConfig(projectId, answers, false);
    workspace.applyProjectUpdate(project);
    close();
    if (launchNow) {
      workspace.setActiveProject(projectId); // ensure the launched pipeline targets it
      void startSeeding();
    }
  } catch (err) {
    saving = false;
    render();
    const msg = document.createElement('div');
    msg.className = 'wz-error';
    msg.textContent = (err as Error).message;
    overlay?.querySelector('.wz-body')?.prepend(msg);
  } finally {
    saving = false;
  }
}

function buildReview(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'wz-review';
  const typeLabel = PROJECT_TYPES.find((t) => t.value === answers.projectType)?.label ?? answers.projectType;
  const rows: [string, string][] = [
    ['Type', typeLabel],
    ['Title', answers.title || '—'],
    ['Focus', answers.researchQuestion || '—'],
    ['Deliverables', answers.deliverables.length ? answers.deliverables.join('; ') : '—'],
    ['Timeline', answers.timeline || '—'],
    ['Materials', answers.sourceMaterials.length ? `${answers.sourceMaterials.length} file(s)` : 'none'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'wz-review-row';
    const l = document.createElement('span'); l.className = 'wz-review-label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'wz-review-value'; v.textContent = value;
    row.append(l, v);
    wrap.append(row);
  }

  // Gentle thin-seed nudge — informational, never blocking.
  if (answers.sourceMaterials.length === 0) {
    const note = document.createElement('div');
    note.className = 'wz-nudge';
    note.innerHTML =
      `${icon('sparkle', { size: 14, stroke: 1.8 })} No materials added yet. The team will ` +
      `work from public literature — adding your own materials (e.g. ${escape(
        (SEED_GUIDANCE[answers.projectType] ?? ['prior drafts, data, or key references'])[0],
      )}) usually gives a much stronger first draft. You can add them now or later.`;
    wrap.append(note);
  }

  // Launch choice — the "always ask before running the pipeline" gate.
  const choice = document.createElement('div');
  choice.className = 'wz-launch';
  const mk = (val: boolean, label: string, sub: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `wz-launch-opt${launchNow === val ? ' is-on' : ''}`;
    b.innerHTML = `<span class="wz-launch-label">${escape(label)}</span><span class="wz-launch-sub">${escape(sub)}</span>`;
    b.addEventListener('click', () => { launchNow = val; render(); });
    return b;
  };
  choice.append(
    mk(true, 'Start research & skeleton now', 'The RA builds a bibliography and the Writer drafts a skeleton.'),
    mk(false, 'Not yet', 'Just save the setup. You can launch anytime.'),
  );
  wrap.append(choice);
  return wrap;
}

function buildUploader(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'wz-upload';

  const drop = document.createElement('label');
  drop.className = 'wz-drop';
  drop.innerHTML =
    `${icon('upload', { size: 18, stroke: 1.8 })}<span>Drop files here or click to choose</span>`;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.className = 'wz-file-input';
  drop.append(input);

  const fileList = document.createElement('div');
  fileList.className = 'wz-files';
  const renderFiles = () => {
    fileList.replaceChildren();
    for (const path of answers.sourceMaterials) {
      const chip = document.createElement('div');
      chip.className = 'wz-file-chip';
      chip.textContent = path.split('/').pop() ?? path;
      fileList.append(chip);
    }
  };
  renderFiles();

  const doUpload = async (files: File[]) => {
    if (!files.length) return;
    drop.classList.add('is-busy');
    const { uploaded, failed } = await uploadFiles(projectId, files, 'seed_docs');
    for (const u of uploaded) {
      if (!answers.sourceMaterials.includes(u.path)) answers.sourceMaterials.push(u.path);
    }
    drop.classList.remove('is-busy');
    renderFiles();
    void persistDraft();
    if (failed.length) {
      const err = document.createElement('div');
      err.className = 'wz-error';
      err.textContent = failed.map((f) => `${f.name}: ${f.error}`).join('; ');
      wrap.append(err);
    }
  };

  input.addEventListener('change', () => void doUpload(Array.from(input.files ?? [])));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    void doUpload(Array.from(e.dataTransfer?.files ?? []));
  });

  wrap.append(drop, fileList);
  return wrap;
}

// ---- Field builders ----
function fieldText(label: string, value: string, placeholder: string, onInput: (v: string) => void): HTMLElement {
  const f = fieldWrap(label);
  const input = document.createElement('input');
  input.className = 'wz-input';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  f.append(input);
  return f;
}

function fieldTextarea(label: string, value: string, placeholder: string, onInput: (v: string) => void): HTMLElement {
  const f = fieldWrap(label);
  const ta = document.createElement('textarea');
  ta.className = 'wz-textarea';
  ta.rows = 4;
  ta.value = value;
  ta.placeholder = placeholder;
  ta.addEventListener('input', () => onInput(ta.value));
  f.append(ta);
  return f;
}

function fieldSelect(
  label: string, value: string, options: { value: string; label: string }[], onChange: (v: string) => void,
): HTMLElement {
  const f = fieldWrap(label);
  const sel = document.createElement('select');
  sel.className = 'wz-select';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  f.append(sel);
  return f;
}

function fieldList(label: string, value: string[], placeholder: string, onChange: (list: string[]) => void): HTMLElement {
  const f = fieldWrap(label);
  const items = [...value];
  const listEl = document.createElement('div');
  listEl.className = 'wz-chiplist';
  const row = document.createElement('div');
  row.className = 'wz-chip-add';
  const input = document.createElement('input');
  input.className = 'wz-input';
  input.placeholder = placeholder;
  const add = textButton('Add', () => commit());
  add.className = 'btn btn-ghost btn-sm';
  row.append(input, add);

  const renderChips = () => {
    listEl.replaceChildren();
    items.forEach((item, i) => {
      const chip = document.createElement('span');
      chip.className = 'wz-chip';
      chip.textContent = item;
      const x = textButton('×', () => { items.splice(i, 1); onChange([...items]); renderChips(); });
      x.className = 'wz-chip-x';
      chip.append(x);
      listEl.append(chip);
    });
  };
  const commit = () => {
    const v = input.value.trim();
    if (!v) return;
    items.push(v);
    input.value = '';
    onChange([...items]);
    renderChips();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  renderChips();
  f.append(listEl, row);
  return f;
}

function fieldWrap(label: string): HTMLElement {
  const f = document.createElement('div');
  f.className = 'wz-field';
  const l = document.createElement('label');
  l.className = 'wz-label';
  l.textContent = label;
  f.append(l);
  return f;
}

function textButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function flashInvalid(): void {
  const body = overlay?.querySelector('.wz-body');
  body?.classList.remove('wz-shake');
  void (body as HTMLElement | undefined)?.offsetWidth; // reflow to restart the animation
  body?.classList.add('wz-shake');
}

function escape(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
