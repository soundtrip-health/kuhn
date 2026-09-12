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

import { SandboxError, PANDOC_OPTIONAL_FILTERS, pandocConvert, renderMarp, renderTypstPdf, typstQueryBlocks } from './sandbox.js';
import { StorageError, readProjectFile, writeProjectFile, deleteProjectEntry } from './storage.js';
import { materializeBib, DEFAULT_BIB_PATH } from './db/references.js';
import { getProject } from './db/projects.js';
import { log } from './logger.js';
import { MARP_BUILTIN_THEMES, resolveThemeCss } from './db/slide-themes.js';
import { resolveTemplateSource } from './db/typst-templates.js';

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
 * The document's front-matter `template:` name (leading block only) — the
 * Typst page layout it renders with (typst-templates/). Absent → Pandoc's
 * built-in layout.
 */
export function typstTemplateName(source) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.toString('utf-8'));
  if (!fm) return null;
  const m = /^\s*template\s*:\s*["']?([A-Za-z0-9][\w-]*)["']?\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

/** Resolve the template through the org/catalog library (throws on unknown names). */
async function resolveTypstTemplate(projectId, source) {
  const name = typstTemplateName(source);
  if (!name) return null;
  const project = await getProject(projectId);
  return resolveTemplateSource(project?.org_id ?? null, name);
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

// Rendered PDFs (with their page map) keyed by content hash — re-render only
// when the source or bibliography changed. Small bounded map; eviction is
// oldest-first.
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
 * Render a markdown source file to PDF. Returns { pdf, pageMap, cached }.
 * pageMap (prose documents only; null for Marp decks or when the page query
 * failed) is what the editor's page-break lines are drawn from:
 *   { pages, pageHeight, blocks: [{ key, page, y }], end: { page, y } }
 * — one entry per top-level Pandoc block with the page and vertical offset
 * (pt) where it starts, `key` the fingerprint blockmarks.lua computed, and
 * `end` the position after the last block (how full the last page is).
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
  let template = null;
  if (marp) {
    theme = await resolveMarpTheme(projectId, source); // theme edits must re-render (hash below)
  } else {
    template = await resolveTypstTemplate(projectId, source); // throws TemplateError on unknown names
    await materializeBib(projectId, bibPath).catch(() => {});
    bib = await readIfExists(projectId, bibPath);
  }

  const hash = createHash('sha256')
    .update(`${projectId}:${sourcePath}:${marp ? 'marp:' : ''}`).update(source).update(bib ?? '')
    .update(theme?.css ?? '')
    .update(template ? `template:${template.origin}:${template.source}` : '')
    .digest('hex');
  if (pdfCache.has(hash)) return { ...pdfCache.get(hash), cached: true };
  if (inFlight.has(hash)) {
    return { ...(await inFlight.get(hash)), cached: true };
  }

  const run = marp
    ? doRenderMarp(projectId, sourcePath, hash, theme)
    : doRender(projectId, sourcePath, bibPath, bib, hash, template);
  inFlight.set(hash, run);
  try {
    return { ...(await run), cached: false };
  } finally {
    inFlight.delete(hash);
  }
}

/**
 * Shape the raw marker values (blockmarks.lua) into the page map the UI
 * consumes. Headings keep their level/text; `page_limits:` front matter
 * (section title → max pages) becomes `sections`: each budgeted heading
 * measured from its own start to the next heading of the same or a higher
 * level (or the end of the document), in fractional pages — 1.07 means
 * "spills 7% of a page past the first". `over` is what the badge turns red on.
 */
export function pageMapFromMarkers(markers) {
  const blocks = [];
  let end = null;
  let pageHeight = null;
  let limits = {};
  for (const m of markers) {
    if (!m || typeof m.page !== 'number') continue;
    if (pageHeight == null && typeof m.h === 'number') pageHeight = m.h;
    const entry = { key: String(m.key ?? ''), page: m.page, y: Math.round(m.y * 10) / 10 };
    if (typeof m.level === 'number') {
      entry.level = m.level;
      entry.text = String(m.text ?? '');
    }
    if (m.i === -1) {
      end = { page: entry.page, y: entry.y };
      if (m.limits && typeof m.limits === 'object') limits = m.limits;
    } else {
      blocks.push(entry);
    }
  }
  if (!end && blocks.length === 0) return null;
  const last = end ?? blocks[blocks.length - 1];
  const map = { pages: last.page, pageHeight, blocks, end: end ?? { page: last.page, y: last.y } };
  map.sections = sectionsFromMap(map, limits);
  return map;
}

const normTitle = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

function sectionsFromMap({ blocks, end, pageHeight }, limits) {
  const limitByTitle = new Map(
    Object.entries(limits).map(([title, n]) => [normTitle(title), Number(n)]).filter(([, n]) => n > 0),
  );
  if (limitByTitle.size === 0) return [];
  const sections = [];
  blocks.forEach((b, index) => {
    if (b.level == null) return;
    const limit = limitByTitle.get(normTitle(b.text));
    if (limit == null) return;
    let stop = end;
    for (let j = index + 1; j < blocks.length; j += 1) {
      if (blocks[j].level != null && blocks[j].level <= b.level) { stop = blocks[j]; break; }
    }
    const pages = pageHeight
      ? (stop.page - b.page) + (stop.y - b.y) / pageHeight
      : stop.page - b.page + 1;
    const rounded = Math.round(pages * 100) / 100;
    sections.push({ index, title: b.text, key: b.key, page: b.page, pages: rounded, limit, over: rounded > limit });
  });
  return sections;
}

async function doRender(projectId, sourcePath, bibPath, bib, hash, template = null) {
  // Stage 1: markdown → Typst. Stage 2 compiles inside the read-only project
  // mount, so the intermediate .typ is written next to the source (relative
  // image paths keep resolving) and removed afterwards. A template is
  // materialized beside it under a hash-derived name and handed to Pandoc as
  // the `template` variable, which its Typst layout turns into
  // `#import "<file>": conf` — a relative import, resolved by Typst against
  // the .typ's own directory. (A -V variable, not -M metadata: metadata
  // values are markdown-escaped, which mangles the leading dot.)
  const dir = dirname(sourcePath);
  const prefix = `${dir === '.' ? '' : `${dir}/`}.preview-${hash.slice(0, 12)}`;
  const typPath = `${prefix}.typ`;
  const templateFile = `.preview-${hash.slice(0, 12)}.tpl.typ`;
  const args = pandocArgs(bibPath, bib != null);
  if (template) args.push(`--variable=template=${templateFile}`);
  // The page-map markers go in AFTER citeproc (argument order = filter
  // order), so the bibliography block is marked like any other.
  args.push(`--lua-filter=${PANDOC_OPTIONAL_FILTERS.blockmarks}`);
  const { output: typSource } = await pandocConvert(projectId, sourcePath, 'preview.typ', args);
  if (template) await writeProjectFile(projectId, `${prefix}.tpl.typ`, template.source);
  await writeProjectFile(projectId, typPath, typSource);
  try {
    const { output: pdf } = await renderTypstPdf(projectId, typPath);
    // The page map is a second, query-only Typst pass. Losing it must not
    // lose the PDF: the preview still paints, only the editor's page lines
    // go missing (and the log says why).
    let pageMap = null;
    try {
      pageMap = pageMapFromMarkers(await typstQueryBlocks(projectId, typPath));
    } catch (err) {
      log.warn('page_map_failed', { projectId, path: sourcePath, message: err.message });
    }
    const result = { pdf, pageMap };
    cachePdf(hash, result);
    return result;
  } finally {
    await deleteProjectEntry(projectId, typPath).catch(() => {});
    if (template) await deleteProjectEntry(projectId, `${prefix}.tpl.typ`).catch(() => {});
  }
}

/** STH-57: slide-deck preview — one sandboxed Marp run, straight to PDF. */
async function doRenderMarp(projectId, sourcePath, hash, theme) {
  const { output: pdf } = await renderMarp(projectId, sourcePath, 'pdf', {
    themeName: theme?.name, themeCss: theme?.css,
  });
  const result = { pdf, pageMap: null }; // slides paginate by `---`; no page lines
  cachePdf(hash, result);
  return result;
}

function cachePdf(hash, result) {
  pdfCache.set(hash, result);
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
