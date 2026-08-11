// Org knowledge library UI (story 006-004): the library panel overlay
// (browse / upload / delete, live ingestion status), the org-creation modal
// with its library-seeding step, and a shared org event feed that both the
// panel and the file manager's promote flow (files.ts) subscribe to. Backend
// surface is stories 006-001/002: /api/orgs/:id/library + the org SSE feed.

import {
  adminCreateOrg,
  deleteOrgDocument,
  getKnowledgeCatalog,
  getOrgDocument,
  listOrgLibrary,
  putKnowledgeSelections,
  subscribeOrgEvents,
  uploadOrgDocuments,
  type KnowledgePackage,
  type OrgDocStatusEvent,
  type OrgDocument,
} from './api';
import { trapFocus } from './a11y';
import { icon } from './icons';
import { currentUser } from './login';
import { toast } from './toast';
import * as workspace from './workspace';

// ---- Shared org feed (SSE with poll-while-open fallback) ---------------------

/** A live ingestion event, or a poll tick while the SSE feed is down. */
type FeedEvent = OrgDocStatusEvent | { type: 'poll' };
type FeedListener = (event: FeedEvent) => void;

const POLL_MS = 4000;

interface FeedState {
  orgId: number;
  listeners: Set<FeedListener>;
  closeSse: () => void;
  pollTimer: number | null;
}

let feed: FeedState | null = null;

function stopPoll(state: FeedState): void {
  if (state.pollTimer != null) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function closeFeed(state: FeedState): void {
  state.closeSse();
  stopPoll(state);
  if (feed === state) feed = null;
}

function ensureFeed(orgId: number): FeedState {
  if (feed?.orgId === orgId) return feed;
  if (feed) closeFeed(feed);
  const state: FeedState = { orgId, listeners: new Set(), closeSse: () => {}, pollTimer: null };
  state.closeSse = subscribeOrgEvents(orgId, {
    onOpen: () => stopPoll(state),
    // Feed down → poll while anyone is listening; EventSource keeps retrying
    // in the background and onOpen stands the poll down again.
    onError: () => {
      if (state.pollTimer != null) return;
      state.pollTimer = window.setInterval(() => {
        for (const fn of [...state.listeners]) fn({ type: 'poll' });
      }, POLL_MS);
    },
    onEvent: (event) => {
      for (const fn of [...state.listeners]) fn(event);
    },
  });
  feed = state;
  return state;
}

/** Listen to an org's ingestion events; the feed lives while listeners do.
 * Exported for the org-admin Knowledge tab (issue #65), which watches many
 * imported documents at once through the same shared feed. */
export function addOrgFeedListener(orgId: number, fn: FeedListener): () => void {
  const state = ensureFeed(orgId);
  state.listeners.add(fn);
  return () => {
    state.listeners.delete(fn);
    if (state.listeners.size === 0) closeFeed(state);
  };
}

/**
 * Watch one document until its ingestion settles (`ready`/`failed`), then call
 * back once and stop. Used by the file manager's promote flow for its
 * ingesting/done badges. Poll ticks re-check the document directly.
 */
export function watchDocIngestion(
  orgId: number,
  docId: number,
  onSettled: (status: 'ready' | 'failed', detail?: string | null) => void,
): void {
  let settled = false;
  const settle = (status: 'ready' | 'failed', detail?: string | null): void => {
    if (settled) return;
    settled = true;
    stop();
    onSettled(status, detail);
  };
  const stop = addOrgFeedListener(orgId, (event) => {
    if (event.type === 'doc_status' && event.docId === docId) {
      if (event.status === 'ready' || event.status === 'failed') {
        settle(event.status, event.statusDetail);
      }
      return;
    }
    if (event.type === 'poll') {
      void getOrgDocument(orgId, docId)
        .then((doc) => {
          if (doc.status === 'ready' || doc.status === 'failed') {
            settle(doc.status, doc.status_detail);
          }
        })
        .catch(() => { /* transient — the next tick retries */ });
    }
  });
  // A fast ingest can finish before the caller subscribes (the terminal event
  // has already streamed past) — check the current status once up front.
  void getOrgDocument(orgId, docId)
    .then((doc) => {
      if (doc.status === 'ready' || doc.status === 'failed') {
        settle(doc.status, doc.status_detail);
      }
    })
    .catch(() => { /* the feed/poll path still covers it */ });
}

// ---- Library setup hint (breadcrumb org menu) --------------------------------

/** orgId → whether the org has at least one `ready` library document. */
const hasReadyDocs = new Map<number, boolean>();

/** Cached answer to "should the org menu show the set-up hint?" — true until
 * the first document is ready. Undefined before the first fetch. */
export function libraryNeedsSetup(orgId: number): boolean | undefined {
  const ready = hasReadyDocs.get(orgId);
  return ready === undefined ? undefined : !ready;
}

/** Refresh the hint cache from the backend (best-effort). */
export async function refreshLibraryHint(orgId: number): Promise<boolean | undefined> {
  try {
    recordDocs(orgId, await listOrgLibrary(orgId));
  } catch {
    return undefined;
  }
  return libraryNeedsSetup(orgId);
}

function recordDocs(orgId: number, docs: OrgDocument[]): void {
  hasReadyDocs.set(orgId, docs.some((d) => d.status === 'ready'));
}

// ---- Library panel overlay ----------------------------------------------------

const SOURCE_LABEL: Record<OrgDocument['source'], string> = {
  upload: 'Uploaded',
  'project-promotion': 'From project',
  'guidance-import': 'Guidance import',
};

let overlay: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let panelOrgId = 0;
let panelDocs: OrgDocument[] = [];
let panelLoading = false;
let panelError: string | null = null;
let stopPanelFeed: (() => void) | null = null;

function ensureOverlay(): HTMLElement {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'org-library';
  overlay.className = 'pb-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Organization library');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOrgLibrary();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay!.hidden) closeOrgLibrary();
  });
  document.body.append(overlay);
  return overlay;
}

export function openOrgLibrary(): void {
  const org = workspace.activeOrg();
  if (!org) return;
  const root = ensureOverlay();
  const wasHidden = root.hidden;
  root.hidden = false;
  panelOrgId = org.id;
  panelDocs = [];
  panelError = null;
  render();
  void reloadDocs();

  // Live status while open: apply doc_status events to the cached rows; a
  // poll tick (feed down) refetches the list instead.
  stopPanelFeed?.();
  stopPanelFeed = addOrgFeedListener(org.id, (event) => {
    if (event.type === 'poll') {
      void reloadDocs();
      return;
    }
    const doc = panelDocs.find((d) => d.id === event.docId);
    if (!doc) {
      void reloadDocs(); // a document we don't know yet (e.g. promoted elsewhere)
      return;
    }
    doc.status = event.status;
    doc.status_detail = event.statusDetail ?? null;
    recordDocs(panelOrgId, panelDocs);
    render();
  });

  if (wasHidden) {
    releaseFocus?.();
    releaseFocus = trapFocus(root);
  }
}

export function closeOrgLibrary(): void {
  if (overlay) overlay.hidden = true;
  stopPanelFeed?.();
  stopPanelFeed = null;
  releaseFocus?.(); // restores focus to the opener
  releaseFocus = null;
}

async function reloadDocs(): Promise<void> {
  const orgId = panelOrgId;
  panelLoading = panelDocs.length === 0;
  panelError = null;
  render();
  try {
    const docs = await listOrgLibrary(orgId);
    if (orgId !== panelOrgId) return; // superseded by an org switch
    panelDocs = docs;
    recordDocs(orgId, docs);
  } catch (err) {
    panelError = (err as Error).message;
  } finally {
    panelLoading = false;
  }
  render();
}

async function uploadToLibrary(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const { uploaded, failed } = await uploadOrgDocuments(panelOrgId, files);
  if (uploaded.length > 0) {
    toast(`Added ${uploaded.length} document${uploaded.length === 1 ? '' : 's'} to the library`);
  }
  for (const f of failed) toast(`${f.name}: ${f.error}`);
  await reloadDocs();
}

async function removeDoc(doc: OrgDocument, row: HTMLElement): Promise<void> {
  if (doc.catalog_item_id) return; // managed via the Knowledge tab (issue #65)
  // Documented exception (story 005-004): native confirm() is accessible by
  // construction; the file manager's delete uses the same pattern.
  if (!window.confirm(`Remove "${doc.title || doc.filename}" from the organization library?`)) return;
  try {
    // The doc's own org, not the panel's — rows also render in the org-creation
    // seed step, where the library panel may belong to a different org.
    await deleteOrgDocument(doc.org_id, doc.id);
  } catch (err) {
    toast(`Delete failed: ${(err as Error).message}`);
    return;
  }
  row.remove();
  if (overlay && !overlay.hidden && doc.org_id === panelOrgId) await reloadDocs();
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Status cell: spinner while processing, check when searchable, honest
 * failure detail otherwise (the delete button doubles as the fix affordance —
 * remove and re-upload a corrected file). */
function statusEl(doc: OrgDocument): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `ol-status is-${doc.status}`;
  if (doc.status === 'ready') {
    wrap.innerHTML = `${icon('check', { size: 13, stroke: 2 })}<span>Searchable</span>`;
  } else if (doc.status === 'failed') {
    wrap.innerHTML = `${icon('x', { size: 13, stroke: 2 })}<span></span>`;
    (wrap.querySelector('span:last-child') as HTMLElement).textContent =
      `Failed — ${doc.status_detail || 'could not process this file'}. Delete it and upload a revised copy.`;
  } else {
    const spinner = document.createElement('span');
    spinner.className = 'file-spinner';
    const label = document.createElement('span');
    label.textContent = doc.status === 'pending' ? 'Queued…' : 'Processing…';
    wrap.append(spinner, label);
  }
  wrap.setAttribute('role', 'status');
  return wrap;
}

function docRow(doc: OrgDocument): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ol-row';
  row.dataset.docId = String(doc.id);

  const iconEl = document.createElement('span');
  iconEl.className = 'ol-doc-icon';
  iconEl.innerHTML = icon('file-text', { size: 15, stroke: 1.7 });

  const body = document.createElement('div');
  body.className = 'ol-doc-body';
  const name = document.createElement('div');
  name.className = 'ol-doc-name';
  name.textContent = doc.title || doc.filename;
  const meta = document.createElement('div');
  meta.className = 'ol-doc-meta';
  const parts = [formatSize(doc.size_bytes), SOURCE_LABEL[doc.source] ?? doc.source];
  // Only mention the filename when the display name is a distinct title.
  if (doc.title && doc.title !== doc.filename) parts.unshift(doc.filename);
  meta.textContent = parts.join(' · ');
  body.append(name, meta, statusEl(doc));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'file-action ol-delete';
  if (doc.catalog_item_id) {
    // Catalog imports are deselected in the Knowledge tab, not deleted here —
    // deleting the copy while the selection stands would desync the two.
    del.disabled = true;
    del.classList.add('is-locked');
    del.title = 'Managed in the org admin Knowledge tab';
    del.setAttribute('aria-label', `${doc.title || doc.filename} is managed in the Knowledge tab`);
  } else {
    del.title = 'Remove from library';
    del.setAttribute('aria-label', `Remove ${doc.title || doc.filename} from library`);
    del.addEventListener('click', () => void removeDoc(doc, row));
  }
  del.innerHTML = icon('trash', { size: 13, stroke: 1.7 });

  row.append(iconEl, body, del);
  return row;
}

/** Drop-zone + hidden input wiring shared by the panel and the seed step. */
function uploadZone(sub: string, onFiles: (files: File[]) => void): HTMLElement {
  const zone = document.createElement('div');
  zone.className = 'drop-zone ol-drop';
  zone.innerHTML =
    `<div class="dz-icon">${icon('upload', { size: 18, stroke: 1.7 })}</div>` +
    `<div class="dz-title">Add documents</div>` +
    `<div class="dz-sub"></div>` +
    `<div class="dz-types">PDF · DOCX · MD · TXT · HTML</div>`;
  (zone.querySelector('.dz-sub') as HTMLElement).textContent = sub;

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.className = 'ol-upload-input';
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles(Array.from(input.files));
    input.value = '';
  });
  zone.append(input);

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  zone.tabIndex = 0;
  zone.setAttribute('role', 'button');
  zone.setAttribute('aria-label', 'Add documents to the organization library');
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    zone.classList.remove('drag-over');
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    onFiles(Array.from(e.dataTransfer.files));
  });
  return zone;
}

function render(): void {
  const root = ensureOverlay();
  const org = workspace.activeOrg();

  const modal = document.createElement('div');
  modal.className = 'pb-modal ol-modal';

  const head = document.createElement('header');
  head.className = 'pb-head';
  const heading = document.createElement('div');
  heading.innerHTML = `<div class="pb-eyebrow">Organization library</div><h2 class="pb-org"></h2>`;
  (heading.querySelector('.pb-org') as HTMLElement).textContent = org?.name ?? '';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pb-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icon('x', { size: 16, stroke: 2 });
  closeBtn.addEventListener('click', () => closeOrgLibrary());
  head.append(heading, closeBtn);

  const blurb = document.createElement('p');
  blurb.className = 'ol-blurb';
  blurb.textContent =
    'Style guides, SOPs, regulatory guidance, templates — documents here are searchable by agents across every project in this organization.';

  const list = document.createElement('div');
  list.className = 'ol-list';
  if (panelLoading) {
    const loading = document.createElement('div');
    loading.className = 'pb-empty';
    loading.setAttribute('role', 'status');
    loading.textContent = 'Loading library…';
    list.append(loading);
  } else if (panelError) {
    const errBox = document.createElement('div');
    errBox.className = 'pb-empty';
    errBox.setAttribute('role', 'alert');
    errBox.textContent = `Could not load the library: ${panelError} `;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-quiet btn-sm';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => void reloadDocs());
    errBox.append(retry);
    list.append(errBox);
  } else if (panelDocs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ol-empty';
    empty.innerHTML =
      `<div class="dz-icon">${icon('book', { size: 20, stroke: 1.6 })}</div>` +
      `<div class="dz-title">Build your organization's knowledge</div>` +
      `<div class="dz-sub">Upload the documents your team writes from — agents will cite them ` +
      `when drafting and reviewing, in this project and every future one.</div>`;
    list.append(empty);
  } else {
    // Tenant material first; Kuhn catalog imports grouped under their own
    // header so uploads stay visually primary (issue #65).
    const own = panelDocs.filter((d) => !d.catalog_item_id);
    const imported = panelDocs.filter((d) => d.catalog_item_id);
    for (const doc of own) list.append(docRow(doc));
    if (imported.length > 0) {
      const header = document.createElement('div');
      header.className = 'ol-group-title';
      header.textContent = 'Kuhn knowledge library';
      list.append(header);
      for (const doc of imported) list.append(docRow(doc));
    }
  }

  const zone = uploadZone(
    'Drop files here, or click to choose. Documents are indexed for agent search.',
    (files) => void uploadToLibrary(files),
  );

  modal.append(head, blurb, list, zone);
  root.replaceChildren(modal);
}

// ---- Org-creation modal (name → seed library) ---------------------------------

/** Mirror of the backend's slugify (routes/orgs.js) for the live preview. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

let createOverlay: HTMLElement | null = null;
let releaseCreateFocus: (() => void) | null = null;

function closeCreateModal(): void {
  createOverlay?.remove();
  createOverlay = null;
  releaseCreateFocus?.();
  releaseCreateFocus = null;
}

/**
 * The org-creation modal (replaces the interim window.prompt): step 1 names
 * the org and its first admin (with a live slug preview), step 2 offers to
 * seed its library — with an explicit, no-guilt skip. Super-admin only since
 * epic 011 (breadcrumb.ts already hides the entry; this re-checks on open).
 * When the first admin is someone else, the caller ends up with NO membership
 * (member:false), so step 2 becomes an "invitation sent" note instead of the
 * seed step — library uploads into an org you're not a member of would 404.
 */
export function openCreateOrgModal(): void {
  if (!currentUser()?.is_superadmin) return;
  closeCreateModal();
  const root = document.createElement('div');
  root.className = 'pb-overlay';
  root.id = 'org-create';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'New organization');
  root.addEventListener('click', (e) => {
    if (e.target === root) closeCreateModal();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCreateModal();
  });
  document.body.append(root);
  createOverlay = root;

  renderNameStep(root);
  releaseCreateFocus = trapFocus(root);
}

function modalShell(root: HTMLElement, eyebrow: string, title: string): { modal: HTMLElement; body: HTMLElement } {
  const modal = document.createElement('div');
  modal.className = 'pb-modal om-modal';
  const head = document.createElement('header');
  head.className = 'pb-head';
  const heading = document.createElement('div');
  heading.innerHTML = `<div class="pb-eyebrow"></div><h2 class="pb-org"></h2>`;
  (heading.querySelector('.pb-eyebrow') as HTMLElement).textContent = eyebrow;
  (heading.querySelector('.pb-org') as HTMLElement).textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pb-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icon('x', { size: 16, stroke: 2 });
  closeBtn.addEventListener('click', () => closeCreateModal());
  head.append(heading, closeBtn);
  const body = document.createElement('div');
  body.className = 'om-body';
  modal.append(head, body);
  root.replaceChildren(modal);
  return { modal, body };
}

function renderNameStep(root: HTMLElement): void {
  const { body } = modalShell(root, 'New organization · step 1 of 2', 'Name your organization');

  const form = document.createElement('form');
  form.className = 'om-form';
  const label = document.createElement('label');
  label.className = 'om-label';
  label.textContent = 'Organization name';
  const input = document.createElement('input');
  input.className = 'pb-input';
  input.required = true;
  input.placeholder = 'e.g. Okafor Lab';
  input.id = 'org-create-name';
  label.htmlFor = input.id;

  const slugLine = document.createElement('div');
  slugLine.className = 'om-slug';
  const updateSlug = (): void => {
    const slug = slugify(input.value);
    slugLine.textContent = slug ? `Workspace id: ${slug}` : '';
  };
  input.addEventListener('input', updateSlug);

  // First admin (MB1): defaults to the caller. Keeping your own email makes
  // you owner (member:true) so the seed step still works; naming someone else
  // hands the org over and you get no access to it.
  const adminLabel = document.createElement('label');
  adminLabel.className = 'om-label';
  adminLabel.textContent = 'First admin';
  const adminInput = document.createElement('input');
  adminInput.className = 'pb-input';
  adminInput.type = 'email';
  adminInput.required = true;
  adminInput.value = currentUser()?.email ?? '';
  adminInput.placeholder = 'first-admin@example.org';
  adminInput.id = 'org-create-admin';
  adminLabel.htmlFor = adminInput.id;
  const adminHint = document.createElement('div');
  adminHint.className = 'om-slug';
  adminHint.textContent = 'Becomes the organization’s owner. Keep your own email to set it up yourself.';

  const actions = document.createElement('div');
  actions.className = 'om-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => closeCreateModal());
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-accent';
  submit.textContent = 'Create organization';
  actions.append(cancel, submit);

  form.append(label, input, slugLine, adminLabel, adminInput, adminHint, actions);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    const ownerEmail = adminInput.value.trim();
    if (!name || !ownerEmail) return;
    submit.disabled = true;
    const failed = (err: Error, field: HTMLInputElement): void => {
      submit.disabled = false;
      field.setCustomValidity(err.message);
      field.reportValidity();
      field.addEventListener('input', () => field.setCustomValidity(''), { once: true });
    };
    const self = ownerEmail.toLowerCase() === (currentUser()?.email ?? '').toLowerCase();
    if (self) {
      // The caller is the first admin (member:true) — create through the
      // workspace store so it switches in, then offer the seed step.
      void workspace
        .createNewOrg(name, ownerEmail)
        .then((org) => renderSeedStep(root, org.id, org.name))
        .catch((err: Error) => failed(err, input));
    } else {
      // Someone else's org: the caller is NOT a member (member:false), so
      // don't switch the workspace into it and skip the seed step (MB1) —
      // its project/library fetches would 404 for us.
      void adminCreateOrg({ name, ownerEmail })
        .then(({ org }) => renderInviteSentStep(root, org.name, ownerEmail))
        .catch((err: Error) => failed(err, adminInput));
    }
  });
  body.append(form);
  input.focus();
}

/** Step 2 when the first admin is someone else: no seed step (the caller has
 * no access to the new org), just the handoff confirmation. */
function renderInviteSentStep(root: HTMLElement, orgName: string, email: string): void {
  const { body } = modalShell(root, 'New organization · step 2 of 2', `${orgName} is ready`);

  const note = document.createElement('p');
  note.className = 'ol-blurb';
  note.setAttribute('role', 'status');
  note.textContent =
    `Invitation sent to ${email} — they become ${orgName}’s first admin. ` +
    'You are not a member, so it won’t appear in your organization switcher; ' +
    'manage it from the platform console.';

  const actions = document.createElement('div');
  actions.className = 'om-actions';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-accent';
  done.textContent = 'Done';
  done.addEventListener('click', () => closeCreateModal());
  actions.append(done);

  body.append(note, actions);
  done.focus();
}

/**
 * Compact package picker for the seed step (issue #65): top-level packages
 * with their sub-packages indented, "general scientific writing" pre-checked.
 * Item-granular selection lives in the org admin Knowledge tab.
 */
function seedPackagePicker(orgId: number, results: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'om-kn-picker';
  const title = document.createElement('div');
  title.className = 'om-label';
  title.textContent = 'Start from the Kuhn knowledge library';
  const hint = document.createElement('div');
  hint.className = 'om-slug';
  hint.textContent =
    'Curated reporting standards and style references, imported as searchable library documents. ' +
    'Fine-tune per item later in the org admin Knowledge tab.';
  const list = document.createElement('div');
  list.className = 'om-kn-list';
  list.setAttribute('role', 'status');
  list.textContent = 'Loading packages…';
  wrap.append(title, hint, list);

  const checked = new Map<string, HTMLInputElement>();
  let catalog: KnowledgePackage[] = [];

  void getKnowledgeCatalog()
    .then((packages) => {
      catalog = packages.filter((p) => p.available && p.items.some((i) => i.available));
      list.textContent = '';
      list.removeAttribute('role');
      if (catalog.length === 0) {
        wrap.hidden = true;
        return;
      }
      for (const pkg of catalog) {
        const row = document.createElement('label');
        row.className = `om-kn-pkg${pkg.parent ? ' om-kn-nested' : ''}`;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'kn-check';
        box.value = pkg.id;
        box.checked = pkg.id === 'general-scientific-writing';
        checked.set(pkg.id, box);
        const label = document.createElement('span');
        label.textContent = pkg.title;
        const count = document.createElement('span');
        count.className = 'om-kn-count';
        const n = pkg.items.filter((i) => i.available).length;
        count.textContent = `${n} item${n === 1 ? '' : 's'}`;
        row.append(box, label, count);
        list.append(row);
      }
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'btn btn-accent btn-sm om-kn-apply';
      apply.textContent = 'Add selected knowledge';
      apply.addEventListener('click', () => {
        const itemIds = catalog
          .filter((p) => checked.get(p.id)?.checked)
          .flatMap((p) => p.items.filter((i) => i.available).map((i) => i.id));
        if (itemIds.length === 0) return;
        apply.disabled = true;
        void putKnowledgeSelections(orgId, { enable: itemIds })
          .then(() => {
            hasReadyDocs.set(orgId, false); // imports are still ingesting
            void refreshLibraryHint(orgId);
            toast(`Importing ${itemIds.length} knowledge item${itemIds.length === 1 ? '' : 's'}`);
            const note = document.createElement('div');
            note.className = 'om-slug';
            note.setAttribute('role', 'status');
            note.textContent =
              `Importing ${itemIds.length} items — they appear in the org library as they finish.`;
            results.append(note);
            apply.textContent = 'Added';
          })
          .catch((err: Error) => {
            apply.disabled = false;
            const fail = document.createElement('div');
            fail.className = 'om-seed-fail';
            fail.setAttribute('role', 'alert');
            fail.textContent = `Could not enable packages: ${err.message}`;
            results.append(fail);
          });
      });
      list.append(apply);
    })
    .catch(() => {
      // Catalog unavailable (e.g. not seeded in this deploy) — hide quietly;
      // the upload zone below is the primary seeding path.
      wrap.hidden = true;
    });

  return wrap;
}

function renderSeedStep(root: HTMLElement, orgId: number, orgName: string): void {
  const { body } = modalShell(root, 'New organization · step 2 of 2', "Seed your organization's library");

  const blurb = document.createElement('p');
  blurb.className = 'ol-blurb';
  blurb.textContent =
    `Upload the documents ${orgName} writes from — SOPs, style guides, templates, regulatory guidance. ` +
    'Agents search this library in every project.';

  const results = document.createElement('div');
  results.className = 'ol-list om-seed-list';

  const zone = uploadZone('Drop files here, or click to choose.', (files) => {
    void uploadOrgDocuments(orgId, files).then(({ uploaded, failed }) => {
      hasReadyDocs.set(orgId, false); // freshly uploaded docs are still ingesting
      for (const doc of uploaded) {
        const row = docRow(doc);
        results.append(row);
        watchDocIngestion(orgId, doc.id, (status, detail) => {
          doc.status = status;
          doc.status_detail = detail ?? null;
          row.querySelector('.ol-status')?.replaceWith(statusEl(doc));
          void refreshLibraryHint(orgId);
        });
      }
      for (const f of failed) {
        const err = document.createElement('div');
        err.className = 'om-seed-fail';
        err.setAttribute('role', 'alert');
        err.textContent = `${f.name}: ${f.error}`;
        results.append(err);
      }
      if (uploaded.length > 0) done.textContent = 'Done';
    });
  });

  const actions = document.createElement('div');
  actions.className = 'om-actions';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-ghost om-skip';
  done.textContent = 'Skip for now — you can add documents anytime from the org menu';
  done.addEventListener('click', () => closeCreateModal());
  actions.append(done);

  body.append(blurb, seedPackagePicker(orgId, results), zone, results, actions);
  zone.focus();
}

// ---- Zero-orgs empty state (epic 011 invitation-only door) --------------------

const NO_ORGS_ID = 'no-orgs-state';

/**
 * Full-pane notice once bootstrap finishes with zero orgs: plain sign-ins are
 * told the door is an invitation (there is nothing they can do in-app), while
 * super-admins get the create-org affordance. Self-syncing off the workspace
 * store, same pattern as its suspended banner — it appears after an uninvited
 * magic-link sign-in and disappears the moment a role refresh finds an org.
 */
function syncNoOrgsState(): void {
  const existing = document.getElementById(NO_ORGS_ID);
  if (!workspace.hasNoOrgs()) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const el = document.createElement('div');
  el.id = NO_ORGS_ID;
  el.className = 'no-orgs-state';
  el.setAttribute('role', 'status');
  el.innerHTML =
    `<div class="no-orgs-inner">` +
      `<div class="no-orgs-icon">${icon('folder', { size: 22, stroke: 1.6 })}</div>` +
      `<div class="no-orgs-title">No organization yet</div>` +
      `<div class="no-orgs-sub"></div>` +
    `</div>`;
  const superadmin = currentUser()?.is_superadmin === true;
  (el.querySelector('.no-orgs-sub') as HTMLElement).textContent = superadmin
    ? 'Create your first organization to start writing.'
    : 'Organizations are invitation-only. Ask your organization admin to send you an invitation — the emailed link signs you in and adds you.';
  if (superadmin) {
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'btn btn-accent';
    create.textContent = 'New organization…';
    create.addEventListener('click', () => openCreateOrgModal());
    (el.querySelector('.no-orgs-inner') as HTMLElement).append(create);
  }
  document.body.append(el);
}

workspace.subscribe(() => syncNoOrgsState());
