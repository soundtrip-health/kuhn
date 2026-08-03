// Story 019: render & export service. Markdown is canonical; PDF preview is
// markdown → Typst (Pandoc) → PDF (Typst), exports are straight Pandoc runs.
// Everything executes through the story-018 sandbox helpers — never
// Typst/Pandoc in the backend process. Citations resolve via Pandoc citeproc
// against the project's one canonical bibliography (DEFAULT_BIB_PATH),
// materialized from the reference DB — never a bib "next to the source",
// which would scatter derived copies into every folder rendered from
// (story 012-003).

import { createHash } from 'node:crypto';
import { dirname, basename } from 'node:path';

import { pandocConvert, renderTypstPdf } from './sandbox.js';
import { StorageError, readProjectFile, writeProjectFile, deleteProjectEntry } from './storage.js';
import { materializeBib, DEFAULT_BIB_PATH } from './db/references.js';

export const EXPORT_FORMATS = {
  docx: { outputName: 'export.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  tex: { outputName: 'export.tex', contentType: 'application/x-tex; charset=utf-8' },
};

// Rendered PDFs keyed by content hash — re-render only when the source or
// bibliography changed. Small bounded map; eviction is oldest-first.
const pdfCache = new Map();
const PDF_CACHE_MAX = 20;

// Concurrent renders of identical content share one run: the temp .typ name
// is derived from the hash, so parallel runs would clobber each other's file.
const inFlight = new Map();

async function readIfExists(projectId, relPath) {
  try {
    return await readProjectFile(projectId, relPath);
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') return null;
    throw err;
  }
}

/**
 * Pandoc arguments shared by preview and export: standalone output, citeproc
 * when the project has a bibliography. Paths are container-absolute (/work is
 * the read-only project mount).
 */
function pandocArgs(bibPath, hasBib) {
  const args = ['--standalone'];
  if (hasBib) args.push('--citeproc', `--bibliography=/work/${bibPath}`);
  return args;
}

/**
 * Render a markdown source file to PDF. Returns { pdf, cached }.
 * Throws SandboxError (failed | timeout | output_too_large) or StorageError.
 */
export async function renderPdf(projectId, sourcePath) {
  const source = await readProjectFile(projectId, sourcePath); // throws not_found early
  const bibPath = DEFAULT_BIB_PATH;
  // References live in the DB; regenerate the .bib Pandoc reads so it always
  // reflects the canonical store (a no-op when the project has no references —
  // a hand-authored bib at the canonical path is then read as-is, and one
  // anywhere else is ignored by design: users are steered to the RA/DB).
  await materializeBib(projectId, bibPath).catch(() => {});
  const bib = await readIfExists(projectId, bibPath);

  const hash = createHash('sha256')
    .update(`${projectId}:${sourcePath}:`).update(source).update(bib ?? '')
    .digest('hex');
  if (pdfCache.has(hash)) return { pdf: pdfCache.get(hash), cached: true };
  if (inFlight.has(hash)) {
    return { pdf: await inFlight.get(hash), cached: true };
  }

  const run = doRender(projectId, sourcePath, bibPath, bib, hash);
  inFlight.set(hash, run);
  try {
    return { pdf: await run, cached: false };
  } finally {
    inFlight.delete(hash);
  }
}

async function doRender(projectId, sourcePath, bibPath, bib, hash) {
  // Stage 1: markdown → Typst. Stage 2 compiles inside the read-only project
  // mount, so the intermediate .typ is written next to the source (relative
  // image paths keep resolving) and removed afterwards.
  const { output: typSource } = await pandocConvert(
    projectId, sourcePath, 'preview.typ', pandocArgs(bibPath, bib != null),
  );
  const dir = dirname(sourcePath);
  const typPath = `${dir === '.' ? '' : `${dir}/`}.preview-${hash.slice(0, 12)}.typ`;
  await writeProjectFile(projectId, typPath, typSource);
  try {
    const { output: pdf } = await renderTypstPdf(projectId, typPath);
    pdfCache.set(hash, pdf);
    if (pdfCache.size > PDF_CACHE_MAX) {
      pdfCache.delete(pdfCache.keys().next().value);
    }
    return pdf;
  } finally {
    await deleteProjectEntry(projectId, typPath).catch(() => {});
  }
}

/**
 * Export a markdown source file via Pandoc. Returns
 * { output, contentType, filename }. Throws on unknown format.
 */
export async function exportDocument(projectId, sourcePath, format) {
  const spec = EXPORT_FORMATS[format];
  if (!spec) {
    throw new RangeError(`Unsupported export format: ${format}`);
  }
  await readProjectFile(projectId, sourcePath); // throws not_found early
  const bibPath = DEFAULT_BIB_PATH;
  await materializeBib(projectId, bibPath).catch(() => {});
  const hasBib = (await readIfExists(projectId, bibPath)) != null;

  const { output } = await pandocConvert(
    projectId, sourcePath, spec.outputName, pandocArgs(bibPath, hasBib),
  );
  const stem = basename(sourcePath).replace(/\.[^.]+$/, '');
  return { output, contentType: spec.contentType, filename: `${stem}.${format}` };
}
