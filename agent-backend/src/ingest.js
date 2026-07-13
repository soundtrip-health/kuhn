// Story 006-002: org-library ingestion — turn stored document bytes into
// searchable knowledge. Extraction of binary formats runs SANDBOXED
// (sandbox.js: no network, read-only mount, cpu/mem/time limits); only
// plain-text formats are read in-process. Extracted text is chunked
// (heading-aware for markdown-shaped text) and indexed into SQLite FTS5 via
// db/org-documents.js. Documents move pending → ingesting → ready|failed,
// with each transition published on the org event hub.

import { extname, join } from 'node:path';

import { config } from './config.js';
import {
  getOrgDocument,
  replaceDocumentChunks,
  setOrgDocumentStatus,
} from './db/org-documents.js';
import { publishOrgEvent } from './project-events.js';
import { runSandboxed } from './sandbox.js';
import { readOrgFile, resolveOrgSafe } from './storage.js';

/** Thrown for expected, user-readable ingestion failures. */
export class IngestError extends Error {}

const PLAIN_EXTS = new Set(['.md', '.markdown', '.txt']);
const PANDOC_EXTS = new Set(['.docx', '.odt', '.html', '.htm', '.rtf', '.epub']);

/**
 * Extract text for a library document. Returns { text, format } where format
 * 'markdown' means headings survive for heading-aware chunking.
 * @param {Function} [runner] - injectable sandbox runner for tests
 */
export async function extractText(orgId, doc, runner = runSandboxed) {
  const ext = extname(doc.filename).toLowerCase();
  const docRel = `${doc.id}/${doc.filename}`;

  if (PLAIN_EXTS.has(ext)) {
    const buf = await readOrgFile(orgId, docRel);
    return { text: buf.toString('utf-8'), format: ext === '.txt' ? 'plain' : 'markdown' };
  }

  // Binary formats: mount ONLY this document's directory, read-only.
  const { root } = await resolveOrgSafe(orgId, docRel);
  const docDir = join(root, String(doc.id));

  if (PANDOC_EXTS.has(ext)) {
    const result = await runner({
      image: config.sandbox.pandocImage,
      cmd: [`/work/${doc.filename}`, '-t', 'gfm', '--wrap=none'],
      projectDir: docDir,
    });
    if (result.exitCode !== 0) {
      throw new IngestError(`text extraction failed (pandoc): ${firstLine(result.stderr)}`);
    }
    return { text: result.stdout, format: 'markdown' };
  }

  if (ext === '.pdf') {
    const result = await runner({
      image: config.sandbox.popplerImage,
      cmd: ['pdftotext', '-layout', '-l', String(config.ingest.maxPdfPages), `/work/${doc.filename}`, '-'],
      projectDir: docDir,
    });
    if (result.exitCode !== 0) {
      throw new IngestError(`text extraction failed (pdftotext): ${firstLine(result.stderr)}`);
    }
    return { text: result.stdout, format: 'plain' };
  }

  if (ext === '.bib' || ext === '.csv' || ext === '.json') {
    // Indexable as-is: literal content is what a searcher would want.
    const buf = await readOrgFile(orgId, docRel);
    return { text: buf.toString('utf-8'), format: 'plain' };
  }

  throw new IngestError(`unsupported file type "${ext || 'none'}" — supported: md, txt, pdf, docx, odt, html, rtf, epub, bib, csv, json`);
}

const firstLine = (s) => String(s ?? '').split('\n')[0].slice(0, 200);

/**
 * Split extracted text into indexable chunks. Markdown-shaped text is split
 * heading-aware (each chunk carries its `heading_path`, e.g. "Methods >
 * Statistics"); plain text splits on blank lines. Chunks target
 * chunkTargetChars and never exceed chunkMaxChars; consecutive chunks overlap
 * by the last block of the previous chunk so passages straddling a boundary
 * stay findable.
 * @returns {Array<{ seq: number, headingPath: string|null, text: string }>}
 */
export function chunkText(text, format = 'plain') {
  const target = config.ingest.chunkTargetChars;
  const max = config.ingest.chunkMaxChars;
  const chunks = [];
  let seq = 0;

  let current = [];
  let currentLen = 0;
  let currentHeading = null;

  const flush = (overlapBlock = null) => {
    if (currentLen === 0) return;
    chunks.push({ seq: seq++, headingPath: currentHeading, text: current.join('\n\n') });
    current = overlapBlock ? [overlapBlock] : [];
    currentLen = overlapBlock ? overlapBlock.length : 0;
  };

  const headingStack = []; // [{ level, title }]
  const headingPath = () => (headingStack.length ? headingStack.map((h) => h.title).join(' > ') : null);

  for (const rawBlock of text.split(/\n\s*\n/)) {
    const block = rawBlock.trim();
    if (!block) continue;

    const heading = format === 'markdown' ? /^(#{1,6})\s+(.+)$/.exec(block.split('\n')[0]) : null;
    if (heading) {
      // New section: close the current chunk (no overlap across headings).
      flush();
      const level = heading[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title: heading[2].trim() });
      currentHeading = headingPath();
      const rest = block.split('\n').slice(1).join('\n').trim();
      if (!rest) continue;
      current.push(rest);
      currentLen += rest.length;
      continue;
    }

    if (currentLen === 0) currentHeading = headingPath();

    // A single block larger than the hard cap is split on the cap boundary.
    for (let piece = block; piece.length > 0;) {
      const take = piece.slice(0, max);
      piece = piece.slice(take.length);
      if (currentLen + take.length > max && currentLen > 0) {
        flush(current[current.length - 1].length < target / 2 ? current[current.length - 1] : null);
        currentHeading = headingPath();
      }
      current.push(take);
      currentLen += take.length;
      if (currentLen >= target) {
        flush(take.length < target / 2 ? take : null);
        currentHeading = headingPath();
      }
    }
  }
  flush();
  return chunks;
}

/**
 * Run the full ingestion lifecycle for one document. Fail-soft: every
 * failure lands in status 'failed' with a readable detail; nothing throws to
 * the caller.
 */
export async function ingestOrgDocument(orgId, docId, runner = runSandboxed) {
  const doc = getOrgDocument(orgId, docId);
  if (!doc) return;

  const publish = (status, statusDetail = null) =>
    publishOrgEvent(orgId, { type: 'doc_status', docId: doc.id, filename: doc.filename, status, ...(statusDetail ? { statusDetail } : {}) });

  setOrgDocumentStatus(orgId, docId, 'ingesting');
  publish('ingesting');
  try {
    const { text, format } = await extractText(orgId, doc, runner);
    if (!text || text.trim().length < config.ingest.minTextChars) {
      throw new IngestError('no extractable text — scanned PDFs need OCR, which is not supported');
    }
    const chunks = chunkText(text, format);
    replaceDocumentChunks(docId, chunks);
    setOrgDocumentStatus(orgId, docId, 'ready');
    publish('ready');
  } catch (err) {
    const detail = err instanceof IngestError
      ? err.message
      : `ingestion failed: ${firstLine(err.message)}`;
    if (!(err instanceof IngestError)) console.error('[ingest] Unexpected failure:', err);
    setOrgDocumentStatus(orgId, docId, 'failed', detail);
    publish('failed', detail);
  }
}

/** Fire-and-forget ingestion after upload/promote/import. */
export function queueIngest(orgId, docId) {
  setImmediate(() => void ingestOrgDocument(orgId, docId));
}
