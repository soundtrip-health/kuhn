// Story 013: minimal project endpoints so the webapp can pick (or bootstrap)
// the active project. Story 005: project listing and creation are org-scoped to
// the session user; a project's org is set from the session, not the client.
// Full project lifecycle belongs to the PM agent (012).
// Roles (story 010-003): reads (activity, events, conversations, seen) need
// viewer; anything that mutates the project or its files needs editor.

import { Router } from 'express';
import { runSeedPipeline } from '../agents/seeding.js';
import { applyProjectConfig } from '../agents/project-config.js';
import { listProjectConversations } from '../db/conversation.js';
import { listUserOrgs, primaryOrgId } from '../db/orgs.js';
import {
  createProject,
  listProjectsForUser,
  setActiveDocument,
  updateProjectConfig,
} from '../db/projects.js';
import { markSeen, listFileActivity } from '../db/file-activity.js';
import { getOrgSettings } from '../db/org-settings.js';
import { createPromotionRequest } from '../db/promotions.js';
import {
  publishOrgEvent,
  publishProjectEvent,
  subscribeProjectEvents,
  teeProjectEvents,
} from '../project-events.js';
import { StorageError, readProjectFile } from '../storage.js';
import { requireOrgRole, requireProjectRole } from './guards.js';
import { storeOrgDocument } from './org-library.js';
import { streamEvents } from './sse.js';

const router = Router();

const PROJECT_TYPES = ['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'];

/** GET /api/projects — the session user's projects across their orgs, oldest
 *  first. Projects of suspended orgs are excluded (story 011-001): the
 *  per-project routes 403 them anyway, so listing them would only produce a
 *  wall of failing fetches. */
router.get('/api/projects', async (req, res) => {
  const [projects, orgs] = await Promise.all([
    listProjectsForUser(req.user.id),
    listUserOrgs(req.user.id),
  ]);
  const suspended = new Set(orgs.filter((o) => o.status === 'suspended').map((o) => o.id));
  res.json({
    projects: suspended.size === 0 ? projects : projects.filter((p) => !suspended.has(p.org_id)),
  });
});

/**
 * POST /api/projects — body { name, projectType?, orgId? }
 * The org is the requested `orgId` or the user's primary org; either way the
 * user must hold editor there (story 010-003) — it is never trusted blindly
 * from the client.
 */
router.post('/api/projects', async (req, res) => {
  const { name, projectType = 'manuscript', orgId } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!PROJECT_TYPES.includes(projectType)) {
    res.status(400).json({ error: `projectType must be one of: ${PROJECT_TYPES.join(', ')}` });
    return;
  }

  const targetOrg = orgId != null ? orgId : await primaryOrgId(req.user.id);
  if (targetOrg == null) {
    res.status(400).json({ error: 'no organization available for this user' });
    return;
  }
  const ctx = await requireOrgRole(req, res, targetOrg, 'editor');
  if (!ctx) return;

  const project = await createProject({ name, projectType, orgId: ctx.orgId });
  res.status(201).json({ project });
});

/**
 * Resolve the project named by :id where the session user holds minRole, or
 * send the right refusal (400 bad id · non-leaking 404 · 403 role/suspended —
 * routes/guards.js).
 * @returns {Promise<object|null>} the project row, or null after responding
 */
function authorizeProject(req, res, minRole) {
  return requireProjectRole(req, res, req.params.id, minRole);
}

/**
 * PATCH /api/projects/:id — body { name }
 * Rename a project. The project directory is keyed by id, so this is a pure
 * record update — no files move.
 */
router.patch('/api/projects/:id', async (req, res) => {
  const project = await authorizeProject(req, res, 'editor');
  if (!project) return;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const updated = await updateProjectConfig(project.id, { name });
  res.json({ project: updated });
});

/**
 * PUT /api/projects/:id/config — body { answers, draft? }
 * The setup wizard's save endpoint (token-free replacement for the PM intake
 * interview). `answers` is the camelCase wizard state. draft:true persists a
 * resumable draft under config.setup; a final save validates the pipeline's
 * required fields, writes canonical config + project.json, and marks setup
 * complete.
 */
router.put('/api/projects/:id/config', async (req, res) => {
  const project = await authorizeProject(req, res, 'editor');
  if (!project) return;
  const body = req.body ?? {};
  if (!body.answers || typeof body.answers !== 'object') {
    res.status(400).json({ error: 'answers is required' });
    return;
  }
  const answers = normalizeAnswers(body.answers);

  if (body.draft) {
    const updated = await updateProjectConfig(project.id, {
      config: { setup: { status: 'draft', answers } },
    });
    res.json({ project: updated });
    return;
  }

  const errors = [];
  if (!answers.title.trim()) errors.push('title is required');
  if (!PROJECT_TYPES.includes(answers.projectType)) {
    errors.push(`projectType must be one of: ${PROJECT_TYPES.join(', ')}`);
  }
  if (!answers.researchQuestion.trim()) errors.push('research question is required');
  if (errors.length) {
    res.status(400).json({ error: errors.join('; ') });
    return;
  }

  const canonical = {
    title: answers.title.trim(),
    project_type: answers.projectType,
    research_question: answers.researchQuestion.trim(),
    deliverables: answers.deliverables,
    timeline: answers.timeline,
    source_materials: answers.sourceMaterials,
    ...(answers.notes ? { notes: answers.notes } : {}),
  };
  const { project: updated } = await applyProjectConfig(project.id, canonical, {
    extraConfig: { setup: { status: 'complete', answers } },
  });
  res.json({ project: updated });
});

/** Coerce a wizard answers payload to the expected shape/types (camelCase). */
function normalizeAnswers(a) {
  const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  return {
    title: typeof a.title === 'string' ? a.title : '',
    projectType: typeof a.projectType === 'string' ? a.projectType : '',
    researchQuestion: typeof a.researchQuestion === 'string' ? a.researchQuestion : '',
    deliverables: strArr(a.deliverables),
    timeline: typeof a.timeline === 'string' ? a.timeline : '',
    sourceMaterials: strArr(a.sourceMaterials),
    ...(typeof a.notes === 'string' && a.notes.trim() ? { notes: a.notes.trim() } : {}),
  };
}

/**
 * PUT /api/projects/:id/active-document — body { path }
 * Persist which document is open in this project (story 006), so reopening the
 * project restores it.
 */
router.put('/api/projects/:id/active-document', async (req, res) => {
  const project = await authorizeProject(req, res, 'editor');
  if (!project) return;
  const { path } = req.body ?? {};
  if (!path || typeof path !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const config = await setActiveDocument(project.id, path);
  res.json({ config });
});

/**
 * POST /api/projects/:id/seed
 * Run the seeding pipeline (story 015): PM interview → RA + Advisor research
 * → Writer skeleton. Streams stage markers and agent events as SSE.
 */
router.post('/api/projects/:id/seed', async (req, res) => {
  const project = await authorizeProject(req, res, 'editor');
  if (!project) return;
  // teeProjectEvents publishes the pipeline's own stage markers / status-file
  // event to the project feed; agent events inside the pipeline are already
  // published by their channel tees (the hub dedupes overlap). (story 005-001)
  await streamEvents(res, teeProjectEvents(project.id, runSeedPipeline(project.id, { userId: req.user.id }), { userId: req.user.id }));
});

/**
 * POST /api/projects/:id/files/promote — body { path, title?, note? }. Copy a
 * project file into the owning org's knowledge library (story 006-001).
 * Authorization is project membership; the org is derived from the project,
 * never taken from the client.
 *
 * Policy branch (story 011-004): owners — and everyone when the org opted
 * into promotion_policy 'direct' — take the direct path below, byte-for-byte
 * today's behavior. Otherwise the call files a promotion request (status
 * pending; NO file read, no copy, no ingest — copy happens on approval,
 * routes/promotions.js) and returns 202 { request }. A duplicate suggestion
 * while one is already pending for the same (project, path) returns the
 * existing request with 200 instead of filing (or announcing) a second one.
 */
router.post('/api/projects/:id/files/promote', async (req, res) => {
  const project = await authorizeProject(req, res, 'editor');
  if (!project) return;
  const { path, title, note } = req.body ?? {};
  if (!path || typeof path !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  const policy = getOrgSettings(project.org_id)?.promotion_policy;
  if (req.orgRole !== 'owner' && policy !== 'direct') {
    const { request, existing } = createPromotionRequest({
      orgId: project.org_id,
      projectId: project.id,
      path,
      title: typeof title === 'string' && title.trim() ? title.trim() : null,
      note: typeof note === 'string' && note.trim() ? note.trim() : null,
      suggestedBy: req.user.id,
    });
    if (!existing) {
      publishProjectEvent(project.id, {
        type: 'promotion',
        requestId: request.id,
        path: request.path,
        status: 'pending',
      });
      publishOrgEvent(project.org_id, {
        type: 'promotion_request',
        requestId: request.id,
        projectId: project.id,
        path: request.path,
        status: 'pending',
        suggestedBy: req.user.id,
      });
    }
    res.status(existing ? 200 : 202).json({ request });
    return;
  }

  let buffer;
  try {
    buffer = await readProjectFile(project.id, path);
  } catch (err) {
    if (err instanceof StorageError) {
      res.status(err.code === 'not_found' ? 404 : 400).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
  const { document, deduped } = await storeOrgDocument(project.org_id, buffer, {
    filename: path.split('/').pop(),
    title: typeof title === 'string' && title.trim() ? title.trim() : null,
    source: 'project-promotion',
    sourceProjectId: project.id,
    createdBy: req.user.id,
  });
  res.status(deduped ? 200 : 201).json({ document, deduped });
});

/**
 * POST /api/projects/:id/files/seen — body { path }. Mark a file seen by the
 * session user; clears its new/changed badge (story 005-002). Idempotent.
 */
router.post('/api/projects/:id/files/seen', async (req, res) => {
  const project = await authorizeProject(req, res, 'viewer');
  if (!project) return;
  const { path } = req.body ?? {};
  if (!path || typeof path !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  markSeen(req.user.id, project.id, path);
  res.json({ path, seen: true });
});

/**
 * GET /api/projects/:id/files/activity?since=<iso>&limit= — recent file
 * events, newest first (story 005-002). Hydration/audit companion to the
 * live feed; the tree endpoint already carries per-node unseen flags.
 */
router.get('/api/projects/:id/files/activity', async (req, res) => {
  const project = await authorizeProject(req, res, 'viewer');
  if (!project) return;
  const events = listFileActivity(project.id, {
    since: typeof req.query.since === 'string' ? req.query.since : null,
    limit: req.query.limit,
  });
  res.json({ events });
});

/**
 * GET /api/projects/:id/events — always-on project event feed (story 005-001).
 * SSE stream of every top-level agent/job event for the project, regardless of
 * which request launched the work: file_change, job start, text, question,
 * notice, done, error, seeding stage markers. Unlike the job-scoped streams,
 * this stays open until the client disconnects.
 */
router.get('/api/projects/:id/events', async (req, res) => {
  const project = await authorizeProject(req, res, 'viewer');
  if (!project) return;

  const unsubscribe = subscribeProjectEvents(project.id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  if (!unsubscribe) {
    res.status(503).json({ error: 'too many event subscribers for this project' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  // Comment-frame heartbeat so idle connections survive proxies.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/**
 * GET /api/projects/:id/conversations?limit=
 * Recent top-level conversations with their user/assistant messages, newest
 * conversation first, for chat transcript restore (story 020).
 */
router.get('/api/projects/:id/conversations', async (req, res) => {
  const project = await authorizeProject(req, res, 'viewer');
  if (!project) return;
  const limit = req.query.limit != null ? parseInt(req.query.limit) : 20;
  const conversations = await listProjectConversations(project.id, { limit });
  res.json({ conversations });
});

export default router;
