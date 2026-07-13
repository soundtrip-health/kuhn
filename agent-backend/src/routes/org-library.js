// Story 006-001: HTTP surface of the org knowledge library. Documents are
// org-scoped (the first org-scoped content in the system): metadata rows in
// org_documents, bytes at <orgsRoot>/<orgId>/library/<docId>/<filename>
// through the storage service's org scope. Every route is membership-guarded
// with the same non-leaking 404 pattern as the project routes.

import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import { Router } from 'express';

import { isMember } from '../db/orgs.js';
import {
  deleteOrgDocument,
  getOrgDocument,
  insertOrgDocument,
  listOrgDocuments,
} from '../db/org-documents.js';
import { queueIngest } from '../ingest.js';
import { subscribeOrgEvents } from '../project-events.js';
import { StorageError, deleteOrgEntry, readOrgFile, writeOrgFile } from '../storage.js';
import { bodyErrorHandler, uploadMiddleware } from './uploads.js';

const router = Router();

const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

/** Resolve an org the session user may access, or 404 without leaking. */
async function authorizeOrg(req, res) {
  const orgId = parseInt(req.params.orgId);
  if (Number.isNaN(orgId)) {
    res.status(400).json({ error: 'orgId must be a number' });
    return null;
  }
  if (!(await isMember(req.user.id, orgId))) {
    res.status(404).json({ error: 'organization not found' });
    return null;
  }
  return orgId;
}

/** Multer originalname is client-controlled: keep the base name only. */
function safeFilename(original) {
  const name = basename(String(original)).replace(/[\0]/g, '').trim();
  return name && name !== '.' && name !== '..' ? name : 'document';
}

export const docPath = (doc) => `${doc.id}/${doc.filename}`;

/**
 * Store one uploaded/promoted buffer as a library document. Dedupe by
 * (org, sha256); a fresh row gets its bytes written, and a failed write
 * removes the row again so no orphan metadata survives. Unless
 * `ingest: false`, a fresh document is queued for ingestion (006-002) — and
 * re-offering bytes whose earlier ingestion failed retries it.
 */
export async function storeOrgDocument(orgId, buffer, {
  filename, title = null, mime = null, source = 'upload',
  sourceProjectId = null, createdBy = null, ingest = true,
}) {
  const { document, deduped } = insertOrgDocument({
    orgId,
    filename: safeFilename(filename),
    title,
    mime,
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    source,
    sourceProjectId,
    createdBy,
  });
  if (deduped) {
    if (ingest && document.status === 'failed') queueIngest(orgId, document.id);
    return { document, deduped };
  }
  try {
    await writeOrgFile(orgId, docPath(document), buffer);
  } catch (err) {
    deleteOrgDocument(orgId, document.id); // no orphan metadata
    throw err;
  }
  if (ingest) queueIngest(orgId, document.id);
  return { document, deduped };
}

/** GET /api/orgs/:orgId/library — the org's documents, newest first. */
router.get('/api/orgs/:orgId/library', async (req, res) => {
  const orgId = await authorizeOrg(req, res);
  if (orgId == null) return;
  res.json({ documents: listOrgDocuments(orgId) });
});

/**
 * POST /api/orgs/:orgId/library/upload — multipart (`files`, up to 20).
 * Same all-or-nothing transport semantics as project uploads (story 026);
 * per-file dedupe on identical bytes returns the existing document.
 */
router.post('/api/orgs/:orgId/library/upload', uploadMiddleware, async (req, res) => {
  const orgId = await authorizeOrg(req, res);
  if (orgId == null) return;
  const files = req.files ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: 'No files in upload (use the "files" form field)' });
    return;
  }
  const documents = [];
  for (const file of files) {
    const { document, deduped } = await storeOrgDocument(orgId, file.buffer, {
      filename: file.originalname,
      mime: file.mimetype || null,
      createdBy: req.user.id,
    });
    documents.push({ ...document, deduped });
  }
  res.status(201).json({ documents });
});

/** GET /api/orgs/:orgId/library/:docId — document metadata. */
router.get('/api/orgs/:orgId/library/:docId', async (req, res) => {
  const orgId = await authorizeOrg(req, res);
  if (orgId == null) return;
  const doc = getOrgDocument(orgId, parseInt(req.params.docId));
  if (!doc) {
    res.status(404).json({ error: 'document not found' });
    return;
  }
  res.json({ document: doc });
});

/** GET /api/orgs/:orgId/library/:docId/content — raw bytes. */
router.get('/api/orgs/:orgId/library/:docId/content', async (req, res) => {
  const orgId = await authorizeOrg(req, res);
  if (orgId == null) return;
  const doc = getOrgDocument(orgId, parseInt(req.params.docId));
  if (!doc) {
    res.status(404).json({ error: 'document not found' });
    return;
  }
  const buf = await readOrgFile(orgId, docPath(doc));
  res.set('Content-Type', doc.mime || CONTENT_TYPES[extname(doc.filename).toLowerCase()] || 'application/octet-stream');
  res.send(buf);
});

/** DELETE /api/orgs/:orgId/library/:docId — remove record and bytes. */
router.delete('/api/orgs/:orgId/library/:docId', async (req, res) => {
  const orgId = await authorizeOrg(req, res);
  if (orgId == null) return;
  const doc = getOrgDocument(orgId, parseInt(req.params.docId));
  if (!doc) {
    res.status(404).json({ error: 'document not found' });
    return;
  }
  try {
    await deleteOrgEntry(orgId, String(doc.id)); // the whole <docId>/ dir
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
    // Bytes already gone — still remove the record.
  }
  deleteOrgDocument(orgId, doc.id);
  res.json({ id: doc.id, deleted: true });
});

/**
 * GET /api/orgs/:orgId/events — org event feed (story 006-002): `doc_status`
 * ingestion transitions, streamed as SSE with the same framing/heartbeat
 * contract as the project feed. Poll fallback: the list endpoint carries
 * status too.
 */
router.get('/api/orgs/:orgId/events', async (req, res) => {
  const orgId = await authorizeOrg(req, res);
  if (orgId == null) return;

  const unsubscribe = subscribeOrgEvents(orgId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  if (!unsubscribe) {
    res.status(503).json({ error: 'too many event subscribers for this organization' });
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
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.use(bodyErrorHandler);

export default router;
