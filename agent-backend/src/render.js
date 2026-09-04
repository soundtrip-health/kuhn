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

import { SandboxError, pandocConvert, renderMarp, renderTypstPdf } from './sandbox.js';
import { StorageError, readProjectFile, writeProjectFile, deleteProjectEntry } from './storage.js';
import { materializeBib, DEFAULT_BIB_PATH } from './db/references.js';
import { getProject } from './db/projects.js';
import { MARP_BUILTIN_THEMES, resolveThemeCss } from './db/slide-themes.js';

export const EXPORT_FORMATS = {
  // The rendered PDF as an attachment download — the same bytes the preview
  // paints, for browsers whose native viewer can't show them inline.
  pdf: { outputName: 'export.pdf', contentType: 'application/pdf', pdf: true },
  docx: { outputName: 'export.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  tex: { outputName: 'export.tex', contentType: 'application/x-tex; charset=utf-8' },
  // STH-57: Marp slide exports. Any markdown converts (Marp splits slides on
  // `---` rules); citeproc does not apply — slide decks cite informally.
  pptx: { outputName: 'export.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', marp: true },
  html: { outputName: 'export.html', contentType: 'text/html; charset=utf-8', marp: true },
};

/**
 * STH-57: a document opts into slide rendering with `marp: true` in its YAML
 * front matter (the standard Marp toggle). Only the leading front-matter
 * block is consulted, so prose mentioning marp does not opt in.
 */
export function isMarpSource(source) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.toString('utf-8'));
  return fm != null && /^\s*marp\s*:\s*true\s*$/m.test(fm[1]);
}

/** STH-58: the deck's front-matter `theme:` name (leading block only). */
export function marpThemeName(source) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.toString('utf-8'));
  if (!fm) return null;
  const m = /^\s*theme\s*:\s*["']?([A-Za-z0-9][\w-]*)["']?\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

/**
 * STH-58: resolve a deck's custom theme through the org/catalog library.
 * Built-in marp themes (and unknown names) resolve to null — marp then
 * handles the name itself, exactly as before themes existed.
 */
async function resolveMarpTheme(projectId, source) {
  const name = marpThemeName(source);
  if (!name || MARP_BUILTIN_THEMES.includes(name)) return null;
  const project = await getProject(projectId);
  return resolveThemeCss(project?.org_id ?? null, name);
}

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
  const marp = isMarpSource(source);
  const bibPath = DEFAULT_BIB_PATH;
  // References live in the DB; regenerate the .bib Pandoc reads so it always
  // reflects the canonical store (a no-op when the project has no references —
  // a hand-authored bib at the canonical path is then read as-is, and one
  // anywhere else is ignored by design: users are steered to the RA/DB).
  // Marp decks skip citeproc entirely (STH-57): slides cite informally.
  let bib = null;
  let theme = null;
  if (marp) {
    theme = await resolveMarpTheme(projectId, source); // theme edits must re-render (hash below)
  } else {
    await materializeBib(projectId, bibPath).catch(() => {});
    bib = await readIfExists(projectId, bibPath);
  }

  const hash = createHash('sha256')
    .update(`${projectId}:${sourcePath}:${marp ? 'marp:' : ''}`).update(source).update(bib ?? '')
    .update(theme?.css ?? '')
    .digest('hex');
  if (pdfCache.has(hash)) return { pdf: pdfCache.get(hash), cached: true };
  if (inFlight.has(hash)) {
    return { pdf: await inFlight.get(hash), cached: true };
  }

  const run = marp
    ? doRenderMarp(projectId, sourcePath, hash, theme)
    : doRender(projectId, sourcePath, bibPath, bib, hash);
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
    cachePdf(hash, pdf);
    return pdf;
  } finally {
    await deleteProjectEntry(projectId, typPath).catch(() => {});
  }
}

/** STH-57: slide-deck preview — one sandboxed Marp run, straight to PDF. */
async function doRenderMarp(projectId, sourcePath, hash, theme) {
  const { output: pdf } = await renderMarp(projectId, sourcePath, 'pdf', {
    themeName: theme?.name, themeCss: theme?.css,
  });
  cachePdf(hash, pdf);
  return pdf;
}

function cachePdf(hash, pdf) {
  pdfCache.set(hash, pdf);
  if (pdfCache.size > PDF_CACHE_MAX) {
    pdfCache.delete(pdfCache.keys().next().value);
  }
}

/**
 * Export a markdown source file via Pandoc (docx/tex) or Marp (pptx/html). Returns
 * { output, contentType, filename }. Throws on unknown format.
 */
export async function exportDocument(projectId, sourcePath, format) {
  const spec = EXPORT_FORMATS[format];
  if (!spec) {
    throw new RangeError(`Unsupported export format: ${format}`);
  }
  const source = await readProjectFile(projectId, sourcePath); // throws not_found early
  let output;
  if (spec.pdf) {
    ({ pdf: output } = await renderPdf(projectId, sourcePath));
  } else if (spec.marp) {
    const theme = await resolveMarpTheme(projectId, source);
    const marpOpts = { themeName: theme?.name, themeCss: theme?.css };
    if (format === 'pptx') {
      // STH-61: prefer an EDITABLE pptx (real text boxes). It needs
      // LibreOffice in the marp image (docker/marp); on a stock marp-cli
      // image the conversion fails, so fall back to marp's default
      // slides-as-images pptx rather than failing the export.
      try {
        ({ output } = await renderMarp(projectId, sourcePath, format, { ...marpOpts, editablePptx: true }));
      } catch (err) {
        if (!(err instanceof SandboxError) || err.code !== 'failed') throw err;
        ({ output } = await renderMarp(projectId, sourcePath, format, marpOpts));
      }
    } else {
      ({ output } = await renderMarp(projectId, sourcePath, format, marpOpts));
    }
  } else {
    const bibPath = DEFAULT_BIB_PATH;
    await materializeBib(projectId, bibPath).catch(() => {});
    const hasBib = (await readIfExists(projectId, bibPath)) != null;
    ({ output } = await pandocConvert(
      projectId, sourcePath, spec.outputName, pandocArgs(bibPath, hasBib),
    ));
  }
  const stem = basename(sourcePath).replace(/\.[^.]+$/, '');
  return { output, contentType: spec.contentType, filename: `${stem}.${format}` };
}
