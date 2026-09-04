// Org-admin "Models" tab (issue #111): provider credentials, model profiles,
// and per-agent routing by task difficulty, on top of the #107 backend.
//
// Owner-only. Credentials are org secrets (write-only); profiles reference
// them by name and never receive a value back. Routing changes that widen
// where the org's content is sent (a new provider host) are confirmed first.
//
// The profile form keeps its own draft (module state), so a re-render — or
// a server-side rejection of one field — never wipes what the owner typed;
// syntax is checked client-side before anything is sent.

import {
  type ModelCatalogEntry,
  type ModelProbeResult,
  type ModelProfile,
  type ModelProfileInput,
  type ModelProvider,
  type ModelRoute,
  type ModelRouteAgent,
  type OrgSecret,
  createModelProfile,
  deleteModelProfile,
  listModelProfiles,
  listModelRoutes,
  listOrgSecrets,
  lookupModelCatalog,
  putModelRoutes,
  putOrgSecret,
  testModelProfile,
  updateModelProfile,
} from './api';
import { emptyRow, hint, inlineError, sectionTitle } from './admin-ui';
import { toast } from './toast';

interface Ctx {
  orgId: number;
  rerender: () => void;
}

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible endpoint',
};
const PROVIDERS = Object.keys(PROVIDER_LABEL) as ModelProvider[];
const PROVIDER_HOST: Record<ModelProvider, string | null> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  openrouter: 'openrouter.ai',
  'openai-compatible': null,
};
const SUGGESTED_SECRET: Record<ModelProvider, string> = {
  anthropic: 'anthropic-api-key',
  openai: 'openai-api-key',
  openrouter: 'openrouter-api-key',
  'openai-compatible': 'model-endpoint-key',
};
const MODEL_ID_EXAMPLE: Record<ModelProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5-mini',
  openrouter: 'openai/gpt-oss-20b',
  'openai-compatible': 'the name your server reports under /v1/models',
};
const SLUG_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

// ---- State --------------------------------------------------------------------

let profiles: ModelProfile[] | null = null;
let agents: ModelRouteAgent[] | null = null;
let secrets: OrgSecret[] = [];
let error: string | null = null;
let busy = false;
const testResults = new Map<string, ModelProbeResult | 'running'>();
/** Unsaved route edits per agent slug. */
const routeDrafts = new Map<string, ModelRoute[]>();

/** The open profile form, or null. Survives re-renders and server rejections. */
interface ProfileDraft {
  editingSlug: string | null;           // null = new profile
  slug: string;
  slugTouched: boolean;
  name: string;
  provider: ModelProvider;
  modelId: string;
  baseUrl: string;
  credential: string;                   // secret name or ''
  useCatalog: boolean;                  // true = provider's published values, no overrides
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  tools: boolean;
  costWeight: string;                   // '' = use the catalog suggestion
  dataPolicy: string;
  enabled: boolean;
  errors: Record<string, string>;
  formError: string | null;
  catalog: ModelCatalogEntry | null;    // lookup for the current provider + model id
  catalogFor: string;                   // `${provider}:${modelId}` the lookup belongs to
}
let draft: ProfileDraft | null = null;
let catalogTimer: ReturnType<typeof setTimeout> | null = null;

export function resetModelsTab(): void {
  profiles = null;
  agents = null;
  secrets = [];
  error = null;
  busy = false;
  draft = null;
  testResults.clear();
  routeDrafts.clear();
}

export async function reloadModels({ orgId, rerender }: Ctx): Promise<void> {
  try {
    const [p, a, s] = await Promise.all([listModelProfiles(orgId), listModelRoutes(orgId), listOrgSecrets(orgId)]);
    profiles = p;
    agents = a;
    secrets = s;
    error = null;
  } catch (err) {
    error = (err as Error).message;
  } finally {
    rerender();
  }
}

// ---- Helpers ------------------------------------------------------------------

function hostOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try { return new URL(endpoint).host; } catch { return endpoint; }
}

function profileBySlug(slug: string): ModelProfile | undefined {
  return profiles?.find((p) => p.slug === slug);
}

function profileLabel(p: ModelProfile): string {
  return `${p.name} (${PROVIDER_LABEL[p.provider]} · ${p.model_id ?? 'default'})`;
}

/** A slug derived from a model id: lowercase, unsupported characters → dashes. */
function slugFromModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 64);
}

function button(text: string, onClick: () => void, { primary = false, disabled = false, label }: { primary?: boolean; disabled?: boolean; label?: string } = {}): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = primary ? 'btn btn-accent btn-sm' : 'btn btn-ghost btn-sm';
  b.textContent = text;
  b.disabled = disabled;
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function input(opts: { value?: string; placeholder?: string; type?: string; label: string; width?: string }): HTMLInputElement {
  const el = document.createElement('input');
  el.className = 'pb-input';
  el.type = opts.type ?? 'text';
  if (opts.value != null) el.value = opts.value;
  if (opts.placeholder) el.placeholder = opts.placeholder;
  if (opts.width) el.style.width = opts.width;
  el.setAttribute('aria-label', opts.label);
  return el;
}

function select<T extends string>(options: Array<[T, string]>, value: T, label: string): HTMLSelectElement {
  const el = document.createElement('select');
  el.className = 'pb-select';
  el.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = text;
    o.selected = v === value;
    el.append(o);
  }
  return el;
}

/** A labelled control with help text and an optional validation message. */
function field(label: string, control: HTMLElement, help: string, errorText?: string): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'admin-field';
  if (errorText) wrap.classList.add('is-invalid');
  const span = document.createElement('span');
  span.className = 'admin-field-label';
  span.textContent = label;
  const helpEl = document.createElement('span');
  helpEl.className = 'admin-field-help';
  helpEl.textContent = help;
  wrap.append(span, control, helpEl);
  if (errorText) {
    const err = document.createElement('span');
    err.className = 'admin-field-error';
    err.setAttribute('role', 'alert');
    err.textContent = errorText;
    wrap.append(err);
  }
  return wrap;
}

function checkbox(checked: boolean, label: string, onChange: (v: boolean) => void): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'admin-field-inline';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.setAttribute('aria-label', label);
  box.addEventListener('change', () => onChange(box.checked));
  const text = document.createElement('span');
  text.textContent = label;
  wrap.append(box, text);
  return wrap;
}

async function run(ctx: Ctx, work: () => Promise<void>, done?: string): Promise<void> {
  busy = true;
  ctx.rerender();
  try {
    await work();
    if (done) toast(done);
  } catch (err) {
    error = (err as Error).message;
  } finally {
    busy = false;
    await reloadModels(ctx);
  }
}

// ---- Tab ------------------------------------------------------------------------

export function modelsTab(ctx: Ctx): HTMLElement[] {
  const parts: HTMLElement[] = [];
  parts.push(hint(
    'Which model each agent runs on, and with whose credential. A profile names a provider, a model, '
    + 'the endpoint your content is sent to, and a credential kept as an org secret (never shown again). '
    + 'Routing gives each agent a ranked list of profiles: the cheapest one trusted with a task’s difficulty runs it.',
  ));
  if (error) parts.push(inlineError(error));
  if (!profiles || !agents) {
    parts.push(emptyRow('Loading models…'));
    return parts;
  }
  parts.push(...credentialsSection(ctx));
  parts.push(...profilesSection(ctx));
  parts.push(...routingSection(ctx));
  return parts;
}

// ---- Credentials ------------------------------------------------------------------

function credentialsSection(ctx: Ctx): HTMLElement[] {
  const parts: HTMLElement[] = [];
  parts.push(sectionTitle('Provider credentials'));
  const names = secrets.map((s) => s.name);
  parts.push(hint(names.length
    ? `Saved secrets: ${names.join(', ')}. Values are write-only; save the same name again to rotate. The Secrets tab manages all secrets.`
    : 'No secrets yet. Save a provider API key here, then reference it from a profile below.'));
  const form = document.createElement('form');
  form.className = 'admin-form-row';
  const provider = select<ModelProvider>(PROVIDERS.map((p) => [p, PROVIDER_LABEL[p]]), 'openai', 'Credential provider');
  const name = input({ value: SUGGESTED_SECRET.openai, label: 'Secret name', width: '180px' });
  name.title = 'The name profiles use to refer to this key: lowercase letters, digits, dashes.';
  provider.addEventListener('change', () => { name.value = SUGGESTED_SECRET[provider.value as ModelProvider]; });
  const value = input({ type: 'password', placeholder: 'API key (stored write-only)', label: 'API key', width: '260px' });
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-accent btn-sm';
  save.textContent = 'Save credential';
  save.disabled = busy;
  const err = inlineError(null);
  form.append(provider, name, value, save, err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(n)) {
      err.textContent = 'Secret name: lowercase letters, digits, and dashes, starting with a letter.';
      err.hidden = false;
      return;
    }
    if (!value.value) {
      err.textContent = 'Paste the API key first.';
      err.hidden = false;
      return;
    }
    if (secrets.some((s) => s.name === n) && !confirm(`Replace the value of "${n}"?`)) return;
    void run(ctx, async () => { await putOrgSecret(ctx.orgId, n, value.value, `${PROVIDER_LABEL[provider.value as ModelProvider]} API key`); }, `Saved ${n}`);
  });
  parts.push(form);
  return parts;
}

// ---- Profiles ---------------------------------------------------------------------

function profilesSection(ctx: Ctx): HTMLElement[] {
  const parts: HTMLElement[] = [];
  parts.push(sectionTitle('Model profiles'));
  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML = '<thead><tr><th>Profile</th><th>Provider · model</th><th>Sends content to</th><th>Credential</th><th>Weight</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const p of profiles ?? []) tbody.append(profileRow(ctx, p));
  table.append(tbody);
  parts.push(table);
  parts.push(hint('Weight is the budget cost relative to the deployment’s tiers (Haiku 1, Sonnet 3, Opus 5). '
    + 'Deployment profiles come from the server configuration and cannot be edited here.'));
  if (draft === null) {
    parts.push(button('Add profile', () => { draft = newDraft(null); ctx.rerender(); }, { disabled: busy }));
  } else {
    parts.push(profileForm(ctx, draft));
  }
  return parts;
}

function profileRow(ctx: Ctx, p: ModelProfile): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (!p.enabled) tr.classList.add('is-disabled');
  const cell = (fill: (td: HTMLTableCellElement) => void) => { const td = document.createElement('td'); fill(td); tr.append(td); return td; };
  cell((td) => {
    const name = document.createElement('div');
    name.className = 'admin-member-name';
    name.textContent = p.name;
    const meta = document.createElement('div');
    meta.className = 'admin-member-email';
    meta.textContent = `${p.slug}${p.managed ? ' · deployment' : ''}${p.enabled ? '' : ' · disabled'}`;
    td.append(name, meta);
    if (p.data_policy) {
      const policy = document.createElement('div');
      policy.className = 'admin-member-email';
      policy.textContent = `Data policy: ${p.data_policy}`;
      td.append(policy);
    }
  });
  cell((td) => {
    td.textContent = `${PROVIDER_LABEL[p.provider]} · ${p.model_id ?? 'provider default'}`;
    const caps = document.createElement('div');
    caps.className = 'admin-member-email';
    const pinned = Object.keys(p.capability_overrides ?? {}).length > 0;
    caps.textContent = `${Math.round(p.capabilities.contextWindow / 1000)}k context${p.capabilities.reasoning ? ' · reasoning' : ''}${p.capabilities.tools ? '' : ' · no tools'}${pinned ? ' · pinned' : p.catalog_known ? '' : ' · declared'}`;
    td.append(caps);
  });
  cell((td) => { td.textContent = hostOf(p.endpoint) ?? '—'; });
  cell((td) => {
    td.textContent = p.credential.kind === 'deployment' ? 'deployment key'
      : p.credential.kind === 'secret' ? `secret ${p.credential.secret}` : 'none (keyless)';
  });
  cell((td) => { td.textContent = String(p.cost_weight); });
  cell((td) => {
    td.className = 'admin-row-actions';
    td.append(button('Test', () => {
      testResults.set(p.slug, 'running');
      ctx.rerender();
      void testModelProfile(ctx.orgId, p.slug)
        .then((r) => testResults.set(p.slug, r))
        .catch((err) => testResults.set(p.slug, { ok: false, provider: null, model: null, api: null, endpoint: null, latency_ms: 0, marker_seen: false, usage: null, contract_violations: [], error: { code: 'request', message: (err as Error).message } }))
        .finally(() => ctx.rerender());
    }, { disabled: busy || testResults.get(p.slug) === 'running', label: `Test connection for ${p.name}` }));
    if (!p.managed) {
      td.append(button('Edit', () => { draft = newDraft(p); ctx.rerender(); }, { disabled: busy, label: `Edit ${p.name}` }));
      td.append(button('Delete', () => {
        if (!confirm(`Delete profile "${p.name}"? Agents routed to it fall back to the remaining routes or the deployment default.`)) return;
        void run(ctx, async () => { await deleteModelProfile(ctx.orgId, p.slug); }, `Deleted ${p.name}`);
      }, { disabled: busy, label: `Delete ${p.name}` }));
    }
    const result = testResults.get(p.slug);
    if (result) {
      const out = document.createElement('div');
      out.className = 'admin-test-result';
      if (result === 'running') {
        out.textContent = 'Testing…';
      } else if (result.ok) {
        out.dataset.state = 'ok';
        out.textContent = `OK · ${result.model ?? ''} · ${result.latency_ms} ms${result.warning ? ` · ${result.warning}` : ''}`;
      } else {
        out.dataset.state = 'error';
        out.textContent = `Failed: ${result.error?.message ?? 'unknown error'}`;
      }
      td.append(out);
    }
  });
  return tr;
}

function newDraft(current: ModelProfile | null): ProfileDraft {
  const caps = current?.capabilities;
  return {
    editingSlug: current?.slug ?? null,
    slug: current?.slug ?? '',
    slugTouched: current !== null,
    name: current?.name ?? '',
    provider: current?.provider ?? 'openai',
    modelId: current?.model_id ?? '',
    baseUrl: current?.base_url ?? '',
    credential: current?.credential.secret ?? '',
    useCatalog: current ? Object.keys(current.capability_overrides ?? {}).length === 0 : true,
    contextWindow: String(caps?.contextWindow ?? 128000),
    maxTokens: String(caps?.maxTokens ?? 16384),
    reasoning: caps?.reasoning ?? false,
    tools: caps?.tools ?? true,
    costWeight: current ? String(current.cost_weight) : '',
    dataPolicy: current?.data_policy ?? '',
    enabled: current?.enabled ?? true,
    errors: {},
    formError: null,
    catalog: null,
    catalogFor: '',
  };
}

/** Look the current provider + model id up in the catalog (debounced); re-render on arrival. */
function scheduleCatalogLookup(ctx: Ctx): void {
  if (!draft) return;
  const key = `${draft.provider}:${draft.modelId.trim()}`;
  if (draft.catalogFor === key) return;
  if (catalogTimer) clearTimeout(catalogTimer);
  const d = draft;
  catalogTimer = setTimeout(() => {
    if (draft !== d || !d.modelId.trim()) return;
    void lookupModelCatalog(ctx.orgId, d.provider, d.modelId.trim())
      .then((entry) => {
        if (draft !== d) return;
        d.catalog = entry;
        d.catalogFor = key;
        if (entry.known && entry.capabilities && d.useCatalog) {
          d.contextWindow = String(entry.capabilities.contextWindow);
          d.maxTokens = String(entry.capabilities.maxTokens);
          d.reasoning = entry.capabilities.reasoning;
          d.tools = entry.capabilities.tools;
        }
        if (entry.known && !d.name.trim() && entry.name) d.name = entry.name;
        ctx.rerender();
      })
      .catch(() => { /* the form works without the catalog */ });
  }, 350);
}

/** Client-side syntax checks mirroring the server's rules; returns per-field messages. */
function validateDraft(d: ProfileDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!SLUG_PATTERN.test(d.slug)) errors.slug = 'Lowercase letters, digits, dots, and dashes; must start with a letter (up to 64 characters).';
  else if (d.slug.startsWith('deployment-')) errors.slug = 'Names starting with "deployment-" are reserved.';
  else if (d.editingSlug === null && profileBySlug(d.slug)) errors.slug = 'A profile with this handle already exists.';
  if (!d.name.trim()) errors.name = 'Give the profile a display name.';
  else if (d.name.trim().length > 120) errors.name = 'At most 120 characters.';
  if (!d.modelId.trim()) errors.modelId = 'Enter the provider’s model identifier.';
  else if (/\s/.test(d.modelId.trim())) errors.modelId = 'Model ids contain no spaces.';
  if (d.provider === 'openai-compatible') {
    let url: URL | null = null;
    try { url = new URL(d.baseUrl.trim()); } catch { /* handled below */ }
    if (!url) errors.baseUrl = 'Enter the server’s base URL, e.g. https://llm.example.org/v1';
    else if (!['http:', 'https:'].includes(url.protocol)) errors.baseUrl = 'Use http or https.';
    else if (url.username || url.password || url.search || url.hash) errors.baseUrl = 'No credentials, query parameters, or fragments in the URL.';
  } else if (!d.credential) {
    errors.credential = `${PROVIDER_LABEL[d.provider]} needs an API key: save one under Provider credentials first.`;
  }
  {
    const cw = Number.parseInt(d.contextWindow, 10);
    if (!Number.isInteger(cw) || cw < 1024) errors.contextWindow = 'A whole number of tokens, at least 1024.';
    const mt = Number.parseInt(d.maxTokens, 10);
    if (!Number.isInteger(mt) || mt < 1) errors.maxTokens = 'A positive whole number of tokens.';
  }
  if (d.costWeight.trim()) {
    const w = Number.parseFloat(d.costWeight);
    if (!Number.isFinite(w) || w <= 0 || w > 100) errors.costWeight = 'A number above 0 and at most 100, or blank to use the suggestion.';
  }
  if (d.dataPolicy.length > 2000) errors.dataPolicy = 'At most 2000 characters.';
  return errors;
}

function profileForm(ctx: Ctx, d: ProfileDraft): HTMLElement {
  scheduleCatalogLookup(ctx);
  const form = document.createElement('form');
  form.className = 'admin-profile-form';
  form.noValidate = true; // our own messages, not the browser's "Please fill out this field"
  form.append(sectionTitle(d.editingSlug ? `Edit ${d.editingSlug}` : 'New profile'));
  if (d.formError) form.append(inlineError(d.formError));
  const bind = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, key: keyof ProfileDraft, after?: () => void) => {
    el.addEventListener('input', () => {
      (d as unknown as Record<string, unknown>)[key] = el.value;
      if (d.errors[key]) { delete d.errors[key]; ctx.rerender(); }
      after?.();
    });
  };

  const slug = input({ value: d.slug, placeholder: 'e.g. gpt-5-mini or lab-vllm', label: 'Profile slug' });
  slug.disabled = d.editingSlug !== null;
  bind(slug, 'slug', () => { d.slugTouched = true; });
  const name = input({ value: d.name, placeholder: 'e.g. GPT-5 Mini (OpenAI)', label: 'Profile name' });
  bind(name, 'name');
  const provider = select<ModelProvider>(PROVIDERS.map((p) => [p, PROVIDER_LABEL[p]]), d.provider, 'Provider');
  provider.addEventListener('change', () => {
    d.provider = provider.value as ModelProvider;
    delete d.errors.provider; delete d.errors.baseUrl; delete d.errors.credential;
    d.catalog = null; d.catalogFor = '';
    ctx.rerender();
  });
  const modelId = input({ value: d.modelId, placeholder: MODEL_ID_EXAMPLE[d.provider], label: 'Model id' });
  bind(modelId, 'modelId', () => {
    if (!d.slugTouched && d.editingSlug === null) { d.slug = slugFromModelId(d.modelId); slug.value = d.slug; }
    scheduleCatalogLookup(ctx);
  });
  const baseUrl = input({ value: d.baseUrl, placeholder: 'https://host/v1', label: 'Base URL' });
  bind(baseUrl, 'baseUrl');
  const secretOptions: Array<[string, string]> = [['', d.provider === 'openai-compatible' ? 'none (server needs no key)' : 'choose a saved credential…'], ...secrets.map((s) => [s.name, s.name] as [string, string])];
  const credential = select<string>(secretOptions, d.credential, 'Credential secret');
  credential.addEventListener('change', () => { d.credential = credential.value; delete d.errors.credential; ctx.rerender(); });

  const catalogKnown = Boolean(d.catalog?.known && d.catalogFor === `${d.provider}:${d.modelId.trim()}`);
  const liveSource = catalogKnown && d.catalog?.source === 'openrouter-live';
  const capsHelp = catalogKnown
    ? `Published values for ${d.catalog?.name ?? d.modelId}${liveSource ? ' (from OpenRouter’s model list; newer than the built-in catalog, so they are saved with the profile)' : ''}: ${Math.round(Number(d.contextWindow) / 1000)}k context, ${Number(d.maxTokens).toLocaleString()} max output${d.reasoning ? ', reasoning' : ''}. Untick to pin your own (for example a smaller context window to stay under a long-context surcharge).`
    : d.provider === 'openai-compatible'
      ? 'Self-hosted servers publish no limits Kuhn can read. Enter the model’s context window and output cap from your server’s documentation.'
      : d.modelId.trim()
        ? 'This model id is not in the built-in catalog; enter its limits from the provider’s documentation.'
        : 'Enter a model id to look up its published limits.';
  const useCatalog = checkbox(d.useCatalog, catalogKnown ? 'Use the provider’s published values' : 'Use default values (128k context, 16k output, no reasoning)', (v) => {
    d.useCatalog = v;
    if (v && d.catalog?.capabilities) {
      d.contextWindow = String(d.catalog.capabilities.contextWindow);
      d.maxTokens = String(d.catalog.capabilities.maxTokens);
      d.reasoning = d.catalog.capabilities.reasoning;
      d.tools = d.catalog.capabilities.tools;
    }
    ctx.rerender();
  });
  const contextWindow = input({ value: d.contextWindow, label: 'Context window (tokens)', type: 'number' });
  contextWindow.disabled = d.useCatalog;
  bind(contextWindow, 'contextWindow');
  const maxTokens = input({ value: d.maxTokens, label: 'Max output tokens', type: 'number' });
  maxTokens.disabled = d.useCatalog;
  bind(maxTokens, 'maxTokens');
  const reasoning = checkbox(d.reasoning, 'Reasoning model (extended thinking)', (v) => { d.reasoning = v; });
  const tools = checkbox(d.tools, 'Supports tool calls (required for every Kuhn agent)', (v) => { d.tools = v; });
  for (const box of [reasoning, tools]) (box.querySelector('input') as HTMLInputElement).disabled = d.useCatalog;

  const suggestedWeight = d.catalog?.suggested_cost_weight ?? null;
  const weight = input({ value: d.costWeight, placeholder: suggestedWeight != null ? `suggested ${suggestedWeight}` : 'e.g. 1', label: 'Cost weight', type: 'number' });
  weight.step = '0.05';
  weight.min = '0.05';
  bind(weight, 'costWeight');
  const policy = document.createElement('textarea');
  policy.className = 'pb-input';
  policy.rows = 2;
  policy.placeholder = 'e.g. "Zero-retention API tier; not used for training" — shown to owners, not enforced';
  policy.value = d.dataPolicy;
  policy.setAttribute('aria-label', 'Data policy');
  bind(policy, 'dataPolicy');
  const enabled = checkbox(d.enabled, 'Enabled (routes may use this profile)', (v) => { d.enabled = v; });

  const host = d.provider === 'openai-compatible' ? (hostOf(d.baseUrl.trim()) ?? '(the base URL)') : PROVIDER_HOST[d.provider];
  const egress = hint(`Content sent to ${host} using ${d.credential ? `secret ${d.credential}` : 'no credential'}. `
    + (d.provider === 'openai-compatible' ? 'Public hosts must use https; private hosts need KUHN_ALLOW_PRIVATE_MODEL_ENDPOINTS on the server.' : 'General web search is available to agents only on the Anthropic provider.'));

  const grid = document.createElement('div');
  grid.className = 'admin-profile-grid';
  grid.append(
    field('Provider', provider, 'Who runs the model. OpenAI-compatible covers vLLM, Ollama, LiteLLM, or any server that speaks the OpenAI chat API.', d.errors.provider),
    field('Model id', modelId, `The provider’s own identifier for the model, exactly as their API expects it, e.g. ${MODEL_ID_EXAMPLE[d.provider]}.`, d.errors.modelId),
    field('Slug', slug, d.editingSlug ? 'The handle routes refer to; it cannot change.' : 'A short handle for this profile, used by routing. Lowercase letters, digits, dots, dashes. Filled in from the model id; edit it if you want something friendlier.', d.errors.slug),
    field('Name', name, 'How the profile appears in lists and routing menus.', d.errors.name),
  );
  if (d.provider === 'openai-compatible') {
    grid.append(field('Base URL', baseUrl, 'The server’s OpenAI-compatible root, usually ending in /v1. Leave the credential empty if the server needs no key.', d.errors.baseUrl));
  }
  grid.append(
    field('Credential', credential, d.provider === 'openai-compatible' ? 'Optional: a saved secret sent as the bearer token.' : 'The saved API key to send. Save one under Provider credentials above if the list is empty.', d.errors.credential),
    field('Cost weight', weight, 'Budget cost relative to the deployment’s tiers (Haiku 1, Sonnet 3, Opus 5). Blank uses the catalog’s list price when known.', d.errors.costWeight),
  );
  const capsBlock = document.createElement('div');
  capsBlock.className = 'admin-field';
  const capsTitle = document.createElement('span');
  capsTitle.className = 'admin-field-label';
  capsTitle.textContent = 'Model limits';
  const capsHelpEl = document.createElement('span');
  capsHelpEl.className = 'admin-field-help';
  capsHelpEl.textContent = capsHelp;
  capsBlock.append(capsTitle, useCatalog, capsHelpEl);
  const capsGrid = document.createElement('div');
  capsGrid.className = 'admin-profile-grid';
  capsGrid.append(
    field('Context window', contextWindow, 'Tokens the model can hold per request; the chat’s context meter uses it.', d.errors.contextWindow),
    field('Max output', maxTokens, 'Tokens the model may generate per turn.', d.errors.maxTokens),
    reasoning,
    tools,
  );
  form.append(grid, capsBlock, capsGrid, field('Data policy', policy, 'A note for owners about how this provider handles submitted content (retention, training). Displayed, not enforced.', d.errors.dataPolicy), enabled, egress);

  const actions = document.createElement('div');
  actions.className = 'admin-actions';
  const cancel = button('Cancel', () => { draft = null; ctx.rerender(); }, { disabled: busy });
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-accent btn-sm';
  save.textContent = d.editingSlug ? 'Save changes' : 'Create profile';
  save.disabled = busy;
  actions.append(cancel, save);
  form.append(actions);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    d.slug = d.slug.trim();
    d.errors = validateDraft(d);
    d.formError = Object.keys(d.errors).length ? 'Fix the highlighted fields.' : null;
    if (d.formError) { ctx.rerender(); return; }
    const body: ModelProfileInput = {
      name: d.name.trim(),
      provider: d.provider,
      model_id: d.modelId.trim(),
      base_url: d.provider === 'openai-compatible' ? d.baseUrl.trim() : null,
      credential_secret: d.credential || null,
      // Values from the pinned catalog are re-derived server-side, so nothing
      // is stored; values from the live list (or typed) are saved as overrides.
      capabilities: d.useCatalog && d.catalog?.source === 'catalog' ? {} : {
        contextWindow: Number.parseInt(d.contextWindow, 10),
        maxTokens: Number.parseInt(d.maxTokens, 10),
        reasoning: d.reasoning,
        tools: d.tools,
      },
      cost_weight: d.costWeight.trim() ? Number.parseFloat(d.costWeight) : null,
      data_policy: d.dataPolicy.trim() || null,
      enabled: d.enabled,
    };
    if (d.editingSlug === null) body.slug = d.slug;
    busy = true;
    ctx.rerender();
    const work = d.editingSlug ? updateModelProfile(ctx.orgId, d.editingSlug, body) : createModelProfile(ctx.orgId, body);
    void work
      .then((saved) => { draft = null; toast(`Saved ${saved.name}`); })
      .catch((err) => {
        // Keep everything typed; attach the server's message to its field.
        const fieldName = (err as { field?: string }).field;
        const message = (err as Error).message;
        const map: Record<string, string> = { model_id: 'modelId', base_url: 'baseUrl', credential_secret: 'credential', cost_weight: 'costWeight', data_policy: 'dataPolicy', capabilities: 'contextWindow' };
        if (fieldName && (map[fieldName] || fieldName in d)) d.errors[map[fieldName] ?? fieldName] = message;
        d.formError = fieldName ? 'The server rejected one field; see below.' : message;
      })
      .finally(() => { busy = false; void reloadModels(ctx); });
  });
  return form;
}

// ---- Routing ----------------------------------------------------------------------

function routingSection(ctx: Ctx): HTMLElement[] {
  const parts: HTMLElement[] = [];
  parts.push(sectionTitle('Routing'));
  parts.push(hint('Each row is a profile and the highest task difficulty (0 = routine, 1 = hardest) it is trusted with. '
    + 'A task runs on the first row whose difficulty covers it, else the last. Agents ask for a difficulty when they '
    + 'dispatch sub-tasks; a user’s own request counts as 1. No rows means the deployment default.'));
  for (const agent of agents ?? []) parts.push(agentRoutes(ctx, agent));
  return parts;
}

function routeHosts(routes: ModelRoute[], agent: ModelRouteAgent): string[] {
  const list = routes.length ? routes.map((r) => profileBySlug(r.profile_slug)) : [profileBySlug(agent.default_profile)];
  return [...new Set(list.map((p) => hostOf(p?.endpoint ?? null)).filter((h): h is string => Boolean(h)))];
}

function agentRoutes(ctx: Ctx, agent: ModelRouteAgent): HTMLElement {
  const box = document.createElement('div');
  box.className = 'admin-route';
  const head = document.createElement('div');
  head.className = 'admin-form-row';
  const title = document.createElement('div');
  title.className = 'admin-member-name';
  title.textContent = agent.name;
  const def = profileBySlug(agent.default_profile);
  const sub = document.createElement('div');
  sub.className = 'admin-member-email';
  sub.textContent = `Default: ${def ? profileLabel(def) : agent.default_profile}`;
  head.append(title, sub);
  box.append(head);

  const routeDraft = routeDrafts.get(agent.slug) ?? agent.routes.map((r) => ({ ...r }));
  const dirty = routeDrafts.has(agent.slug);
  const selectable = (profiles ?? []).filter((p) => p.enabled);
  const rows = document.createElement('div');
  rows.className = 'admin-route-rows';
  routeDraft.forEach((route, i) => {
    const row = document.createElement('div');
    row.className = 'admin-form-row';
    const which = select<string>(selectable.map((p) => [p.slug, profileLabel(p)]), route.profile_slug, `${agent.name} route ${i + 1} profile`);
    which.addEventListener('change', () => { routeDraft[i] = { ...routeDraft[i], profile_slug: which.value }; routeDrafts.set(agent.slug, routeDraft); ctx.rerender(); });
    const diff = input({ value: String(route.difficulty), label: `${agent.name} route ${i + 1} difficulty`, type: 'number', width: '80px' });
    diff.min = '0'; diff.max = '1'; diff.step = '0.05';
    diff.addEventListener('change', () => { routeDraft[i] = { ...routeDraft[i], difficulty: Number.parseFloat(diff.value) }; routeDrafts.set(agent.slug, routeDraft); });
    const remove = button('Remove', () => { routeDraft.splice(i, 1); routeDrafts.set(agent.slug, routeDraft); ctx.rerender(); }, { disabled: busy, label: `Remove ${agent.name} route ${i + 1}` });
    const diffLabel = document.createElement('label');
    diffLabel.className = 'admin-field-inline';
    const diffText = document.createElement('span');
    diffText.textContent = 'up to difficulty';
    diffLabel.append(diffText, diff);
    row.append(which, diffLabel, remove);
    rows.append(row);
  });
  box.append(rows);

  const actions = document.createElement('div');
  actions.className = 'admin-form-row';
  actions.append(button('Add row', () => {
    const first = selectable[0];
    if (!first) return;
    routeDraft.push({ profile_slug: first.slug, difficulty: 1 });
    routeDrafts.set(agent.slug, routeDraft);
    ctx.rerender();
  }, { disabled: busy || selectable.length === 0 }));
  if (dirty) {
    actions.append(button('Save', () => {
      const before = routeHosts(agent.routes, agent);
      const after = routeHosts(routeDraft, agent);
      const added = after.filter((h) => !before.includes(h));
      if (added.length && !confirm(`Saving sends ${agent.name} content to a new destination: ${added.join(', ')}. Continue?`)) return;
      void run(ctx, async () => {
        const res = await putModelRoutes(ctx.orgId, agent.slug, routeDraft.sort((a, b) => a.difficulty - b.difficulty));
        routeDrafts.delete(agent.slug);
        if (res.egress.added.length) toast(`${agent.name} now also sends content to ${res.egress.added.join(', ')}`);
      }, `Saved routing for ${agent.name}`);
    }, { primary: true, disabled: busy }));
    actions.append(button('Discard', () => { routeDrafts.delete(agent.slug); ctx.rerender(); }, { disabled: busy }));
  } else if (agent.routes.length) {
    actions.append(button('Revert to default', () => {
      if (!confirm(`Remove ${agent.name}'s routes and use the deployment default?`)) return;
      void run(ctx, async () => { await putModelRoutes(ctx.orgId, agent.slug, []); }, `${agent.name} reverted to the default`);
    }, { disabled: busy }));
  }
  box.append(actions);
  for (const w of agent.warnings) {
    const warn = document.createElement('div');
    warn.className = 'admin-setting-hint admin-route-warning';
    warn.textContent = w.message;
    box.append(warn);
  }
  return box;
}
