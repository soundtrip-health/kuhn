// Org-admin "Models" tab (issue #111): provider credentials, model profiles,
// and per-agent routing by task difficulty, on top of the #107 backend.
//
// Owner-only. Credentials are org secrets (write-only); profiles reference
// them by name and never receive a value back. Routing changes that widen
// where the org's content is sent (a new provider host) are confirmed first.

import {
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
const SUGGESTED_SECRET: Record<ModelProvider, string> = {
  anthropic: 'anthropic-api-key',
  openai: 'openai-api-key',
  openrouter: 'openrouter-api-key',
  'openai-compatible': 'model-endpoint-key',
};

// ---- State --------------------------------------------------------------------

let profiles: ModelProfile[] | null = null;
let agents: ModelRouteAgent[] | null = null;
let secrets: OrgSecret[] = [];
let error: string | null = null;
let busy = false;
/** 'new', a profile slug, or null when no profile form is open. */
let editing: string | null = null;
let formError: string | null = null;
const testResults = new Map<string, ModelProbeResult | 'running'>();
/** Unsaved route edits per agent slug. */
const routeDrafts = new Map<string, ModelRoute[]>();
let routeErrors = new Map<string, string>();

export function resetModelsTab(): void {
  profiles = null;
  agents = null;
  secrets = [];
  error = null;
  busy = false;
  editing = null;
  formError = null;
  testResults.clear();
  routeDrafts.clear();
  routeErrors = new Map();
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

function button(text: string, onClick: () => void, { primary = false, disabled = false, label }: { primary?: boolean; disabled?: boolean; label?: string } = {}): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = primary ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  b.textContent = text;
  b.disabled = disabled;
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function input(opts: { value?: string; placeholder?: string; type?: string; label: string; required?: boolean; pattern?: string; width?: string }): HTMLInputElement {
  const el = document.createElement('input');
  el.className = 'pb-input';
  el.type = opts.type ?? 'text';
  if (opts.value != null) el.value = opts.value;
  if (opts.placeholder) el.placeholder = opts.placeholder;
  if (opts.required) el.required = true;
  if (opts.pattern) el.pattern = opts.pattern;
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

function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'admin-field';
  const span = document.createElement('span');
  span.className = 'admin-field-label';
  span.textContent = text;
  wrap.append(span, control);
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
  const name = input({ value: SUGGESTED_SECRET.openai, label: 'Secret name', required: true, pattern: '[a-z][a-z0-9-]{0,63}', width: '180px' });
  provider.addEventListener('change', () => { name.value = SUGGESTED_SECRET[provider.value as ModelProvider]; });
  const value = input({ type: 'password', placeholder: 'API key (stored write-only)', label: 'API key', required: true, width: '260px' });
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-ghost btn-sm';
  save.textContent = 'Save credential';
  save.disabled = busy;
  form.append(provider, name, value, save);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = name.value.trim();
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
  if (editing === null) {
    parts.push(button('Add profile', () => { editing = 'new'; formError = null; ctx.rerender(); }, { disabled: busy }));
  } else {
    parts.push(profileForm(ctx, editing === 'new' ? null : profileBySlug(editing) ?? null));
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
    caps.textContent = `${Math.round(p.capabilities.contextWindow / 1000)}k context${p.capabilities.reasoning ? ' · reasoning' : ''}${p.capabilities.tools ? '' : ' · no tools'}`;
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
      td.append(button('Edit', () => { editing = p.slug; formError = null; ctx.rerender(); }, { disabled: busy, label: `Edit ${p.name}` }));
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

function profileForm(ctx: Ctx, current: ModelProfile | null): HTMLElement {
  const form = document.createElement('form');
  form.className = 'admin-profile-form';
  const title = sectionTitle(current ? `Edit ${current.name}` : 'New profile');
  form.append(title);
  if (formError) form.append(inlineError(formError));

  const slug = input({ value: current?.slug ?? '', placeholder: 'slug (e.g. gpt-mini)', label: 'Profile slug', required: true, pattern: '[a-z][a-z0-9-]{0,63}' });
  slug.disabled = current !== null;
  const name = input({ value: current?.name ?? '', placeholder: 'Display name', label: 'Profile name', required: true });
  const provider = select<ModelProvider>(PROVIDERS.map((p) => [p, PROVIDER_LABEL[p]]), current?.provider ?? 'openai', 'Provider');
  const modelId = input({ value: current?.model_id ?? '', placeholder: 'model id (e.g. gpt-5-mini, openai/gpt-oss-20b)', label: 'Model id', required: true });
  const baseUrl = input({ value: current?.base_url ?? '', placeholder: 'https://host/v1', label: 'Base URL', type: 'url' });
  const secretOptions: Array<[string, string]> = [['', 'none (keyless local endpoint)'], ...secrets.map((s) => [s.name, s.name] as [string, string])];
  const credential = select<string>(secretOptions, current?.credential.secret ?? '', 'Credential secret');
  const contextWindow = input({ value: String(current?.capabilities.contextWindow ?? 128000), label: 'Context window (tokens)', type: 'number', width: '120px' });
  const maxTokens = input({ value: String(current?.capabilities.maxTokens ?? 16384), label: 'Max output tokens', type: 'number', width: '120px' });
  const reasoning = document.createElement('input');
  reasoning.type = 'checkbox';
  reasoning.checked = current?.capabilities.reasoning ?? false;
  reasoning.setAttribute('aria-label', 'Reasoning model');
  const tools = document.createElement('input');
  tools.type = 'checkbox';
  tools.checked = current?.capabilities.tools ?? true;
  tools.setAttribute('aria-label', 'Supports tool calls');
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = current?.enabled ?? true;
  enabled.setAttribute('aria-label', 'Enabled');
  const weight = input({ value: String(current?.cost_weight ?? 5), label: 'Cost weight', type: 'number', width: '90px' });
  weight.step = '0.1';
  weight.min = '0.1';
  const policy = document.createElement('textarea');
  policy.className = 'pb-input';
  policy.rows = 2;
  policy.placeholder = 'Data policy note for owners (does the provider log, train on, or retain submitted content?)';
  policy.value = current?.data_policy ?? '';
  policy.setAttribute('aria-label', 'Data policy');

  const baseUrlField = labelled('Base URL', baseUrl);
  const egress = document.createElement('div');
  egress.className = 'admin-setting-hint';
  const refreshEgress = () => {
    const p = provider.value as ModelProvider;
    baseUrlField.hidden = p !== 'openai-compatible';
    const host = p === 'openai-compatible' ? (hostOf(baseUrl.value.trim()) ?? '(base URL)')
      : p === 'anthropic' ? 'api.anthropic.com' : p === 'openai' ? 'api.openai.com' : 'openrouter.ai';
    egress.textContent = `Content sent to ${host} using ${credential.value ? `secret ${credential.value}` : 'no credential'}. `
      + (p === 'openai-compatible' ? 'Public hosts must use https; private hosts need KUHN_ALLOW_PRIVATE_MODEL_ENDPOINTS on the server.' : 'Web search is available to agents only on the Anthropic provider.');
  };
  provider.addEventListener('change', refreshEgress);
  baseUrl.addEventListener('input', refreshEgress);
  credential.addEventListener('change', refreshEgress);
  refreshEgress();

  const grid = document.createElement('div');
  grid.className = 'admin-profile-grid';
  grid.append(
    labelled('Slug', slug), labelled('Name', name), labelled('Provider', provider), labelled('Model id', modelId),
    baseUrlField, labelled('Credential', credential), labelled('Context window', contextWindow), labelled('Max output', maxTokens),
    labelled('Cost weight', weight), labelled('Reasoning', reasoning), labelled('Tool calls', tools), labelled('Enabled', enabled),
  );
  form.append(grid, labelled('Data policy', policy), egress);

  const actions = document.createElement('div');
  actions.className = 'admin-actions';
  const cancel = button('Cancel', () => { editing = null; formError = null; ctx.rerender(); }, { disabled: busy });
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-primary btn-sm';
  save.textContent = current ? 'Save changes' : 'Create profile';
  save.disabled = busy;
  actions.append(cancel, save);
  form.append(actions);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = provider.value as ModelProvider;
    const body: ModelProfileInput = {
      name: name.value.trim(),
      provider: p,
      model_id: modelId.value.trim(),
      base_url: p === 'openai-compatible' ? baseUrl.value.trim() : null,
      credential_secret: credential.value || null,
      capabilities: {
        contextWindow: Number.parseInt(contextWindow.value, 10),
        maxTokens: Number.parseInt(maxTokens.value, 10),
        reasoning: reasoning.checked,
        tools: tools.checked,
      },
      cost_weight: Number.parseFloat(weight.value),
      data_policy: policy.value.trim() || null,
      enabled: enabled.checked,
    };
    if (!current) body.slug = slug.value.trim();
    busy = true;
    ctx.rerender();
    const work = current ? updateModelProfile(ctx.orgId, current.slug, body) : createModelProfile(ctx.orgId, body);
    void work
      .then((saved) => { editing = null; formError = null; toast(`Saved ${saved.name}`); })
      .catch((err) => { formError = (err as Error).message; })
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

  const draft = routeDrafts.get(agent.slug) ?? agent.routes.map((r) => ({ ...r }));
  const dirty = routeDrafts.has(agent.slug);
  const selectable = (profiles ?? []).filter((p) => p.enabled);
  const rows = document.createElement('div');
  rows.className = 'admin-route-rows';
  draft.forEach((route, i) => {
    const row = document.createElement('div');
    row.className = 'admin-form-row';
    const which = select<string>(selectable.map((p) => [p.slug, profileLabel(p)]), route.profile_slug, `${agent.name} route ${i + 1} profile`);
    which.addEventListener('change', () => { draft[i] = { ...draft[i], profile_slug: which.value }; routeDrafts.set(agent.slug, draft); ctx.rerender(); });
    const diff = input({ value: String(route.difficulty), label: `${agent.name} route ${i + 1} difficulty`, type: 'number', width: '80px' });
    diff.min = '0'; diff.max = '1'; diff.step = '0.05';
    diff.addEventListener('change', () => { draft[i] = { ...draft[i], difficulty: Number.parseFloat(diff.value) }; routeDrafts.set(agent.slug, draft); });
    const remove = button('Remove', () => { draft.splice(i, 1); routeDrafts.set(agent.slug, draft); ctx.rerender(); }, { disabled: busy, label: `Remove ${agent.name} route ${i + 1}` });
    row.append(which, labelled('up to difficulty', diff), remove);
    rows.append(row);
  });
  box.append(rows);

  const actions = document.createElement('div');
  actions.className = 'admin-form-row';
  actions.append(button('Add row', () => {
    const first = selectable[0];
    if (!first) return;
    draft.push({ profile_slug: first.slug, difficulty: 1 });
    routeDrafts.set(agent.slug, draft);
    ctx.rerender();
  }, { disabled: busy || selectable.length === 0 }));
  if (dirty) {
    actions.append(button('Save', () => {
      const before = routeHosts(agent.routes, agent);
      const after = routeHosts(draft, agent);
      const added = after.filter((h) => !before.includes(h));
      if (added.length && !confirm(`Saving sends ${agent.name} content to a new destination: ${added.join(', ')}. Continue?`)) return;
      void run(ctx, async () => {
        const res = await putModelRoutes(ctx.orgId, agent.slug, draft.sort((a, b) => a.difficulty - b.difficulty));
        routeDrafts.delete(agent.slug);
        routeErrors.delete(agent.slug);
        if (res.egress.added.length) toast(`${agent.name} now also sends content to ${res.egress.added.join(', ')}`);
      }, `Saved routing for ${agent.name}`).catch(() => { /* surfaced via error */ });
    }, { primary: true, disabled: busy }));
    actions.append(button('Discard', () => { routeDrafts.delete(agent.slug); ctx.rerender(); }, { disabled: busy }));
  } else if (agent.routes.length) {
    actions.append(button('Revert to default', () => {
      if (!confirm(`Remove ${agent.name}'s routes and use the deployment default?`)) return;
      void run(ctx, async () => { await putModelRoutes(ctx.orgId, agent.slug, []); }, `${agent.name} reverted to the default`);
    }, { disabled: busy }));
  }
  box.append(actions);
  const routeError = routeErrors.get(agent.slug);
  if (routeError) box.append(inlineError(routeError));
  for (const w of agent.warnings) {
    const warn = document.createElement('div');
    warn.className = 'admin-setting-hint admin-route-warning';
    warn.textContent = w.message;
    box.append(warn);
  }
  return box;
}
