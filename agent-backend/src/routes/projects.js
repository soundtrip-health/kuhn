// Story 013: minimal project endpoints so the webapp can pick (or bootstrap)
// the active project. Story 005: project listing and creation are org-scoped to
// the session user; a project's org is set from the session, not the client.
// Full project lifecycle belongs to the PM agent (012).

import { Router } from 'express';
import { runSeedPipeline } from '../agents/seeding.js';
import { applyProjectConfig } from '../agents/project-config.js';
import { listProjectConversations } from '../db/conversation.js';
import { isMember, primaryOrgId } from '../db/orgs.js';
import {
  createProject,
  getProject,
  listProjectsForUser,
  setActiveDocument,
  updateProjectConfig,
} from '../db/projects.js';
import { markSeen, listFileActivity } from '../db/file-activity.js';
import { subscribeProjectEvents, teeProjectEvents } from '../project-events.js';
import { StorageError, readProjectFile } from '../storage.js';
import { storeOrgDocument } from './org-library.js';
import { streamEvents } from './sse.js';

const router = Router();

const PROJECT_TYPES = ['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'];

/** GET /api/projects — the session user's projects across their orgs, oldest first */
router.get('/api/projects', async (req, res) => {
  const projects = await listProjectsForUser(req.user.id);
  res.json({ projects });
});

/**
 * POST /api/projects — body { name, projectType?, orgId? }
 * The org is the requested `orgId` (only if the user is a member) or the user's
 * primary org; it is never trusted blindly from the client.
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

  let targetOrg = orgId != null ? Number(orgId) : null;
  if (targetOrg != null) {
    if (!(await isMember(req.user.id, targetOrg))) {
      res.status(403).json({ error: 'not a member of that organization' });
      return;
    }
  } else {
    targetOrg = await primaryOrgId(req.user.id);
  }
  if (targetOrg == null) {
    res.status(400).json({ error: 'no organization available for this user' });
    return;
  }

  const project = await createProject({ name, projectType, orgId: targetOrg });
  res.status(201).json({ project });
});

/**
 * Resolve a project the session user may access, or send the right error.
 * @returns {Promise<object|null>} the project row, or null after responding
 */
async function authorizeProject(req, res) {
  const project = await getProject(parseInt(req.params.id));
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  if (!(await isMember(req.user.id, project.org_id))) {
    res.status(404).json({ error: 'project not found' }); // don't leak existence
    return null;
  }
  return project;
}

/**
 * PATCH /api/projects/:id — body { name }
 * Rename a project. The project directory is keyed by id, so this is a pure
 * record update — no files move.
 */
router.patch('/api/projects/:id', async (req, res) => {
  const project = await authorizeProject(req, res);
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
  const project = await authorizeProject(req, res);
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
  const project = await authorizeProject(req, res);
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
  const project = await authorizeProject(req, res);
  if (!project) return;
  // teeProjectEvents publishes the pipeline's own stage markers / status-file
  // event to the project feed; agent events inside the pipeline are already
  // published by their channel tees (the hub dedupes overlap). (story 005-001)
  await streamEvents(res, teeProjectEvents(project.id, runSeedPipeline(project.id, { userId: req.user.id }), { userId: req.user.id }));
});

/**
 * POST /api/projects/:id/files/promote — body { path, title? }. Copy a
 * project file into the owning org's knowledge library (story 006-001).
 * Authorization is project membership; the org is derived from the project,
 * never taken from the client.
 */
router.post('/api/projects/:id/files/promote', async (req, res) => {
  const project = await authorizeProject(req, res);
  if (!project) return;
  const { path, title } = req.body ?? {};
  if (!path || typeof path !== 'string') {
    res.status(400).json({ error: 'path is required' });
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
  const project = await authorizeProject(req, res);
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
  const project = await authorizeProject(req, res);
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
  const project = await authorizeProject(req, res);
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
  const project = await authorizeProject(req, res);
  if (!project) return;
  const limit = req.query.limit != null ? parseInt(req.query.limit) : 20;
  const conversations = await listProjectConversations(project.id, { limit });
  res.json({ conversations });
});

export default router;
