// PDF preview pane + export buttons (story 019), extended into a general file
// preview pane (story 014). Rendering happens on the backend (markdown → Typst
// or Marp → PDF in the story-018 sandbox); this module saves the current
// document, fetches the PDF, and paints its pages into canvases with pdf.js.
// It also previews *stored* files on demand — PDFs through the same page
// painter, images/text in a sibling pane, unknown types as a download link.
// The pane has one owner: opening a file preview replaces the render preview
// and a re-render replaces the file preview (last action wins).
//
// Why pdf.js, not `<iframe src="blob:…">` (the original design): an iframe
// hands the PDF to the browser's native viewer, and there isn't one on
// Android Chrome, in in-app browsers (a magic link opened from a mail
// client), or on desktop Chrome with "download PDFs instead" switched on.
// Those users got a bare file placeholder — a PDF icon, the blob's UUID and
// an "Open" button that did nothing (bug report, 2026-09-04). Canvases paint
// everywhere; the Download button covers saving the file.

import { exportUrl, fetchFileBlob, fileBlobUrl, renderPdf, type ExportFormat } from './api';
import { currentDocumentPath, flushSave } from './editor';

type PdfJs = typeof import('pdfjs-dist');
type PdfTask = import('pdfjs-dist').PDFDocumentLoadingTask;

let projectId = 0;
let listenersWired = false;
let rendering = false;
/** The open pdf.js document (render preview or a stored PDF), if any — via its loading task, which owns teardown. */
let pdfTask: PdfTask | null = null;
const pdfDoc = () => pdfTask?.destroyed === false ? pdfTask : null;
/** Bumped per paint so a superseded pass stops painting stale pages. */
let paintSeq = 0;
/** What the Download button saves: the current document's PDF, or a stored file. */
let downloadTarget: { href: string; name: string } | null = null;
let resizeTimer: number | undefined;

const PAGE_GUTTER = 12;
/** Cap the canvas backing scale — a 3× phone screen would make a 40-page deck heavy. */
const MAX_DPR = 2;

const panel = () => document.getElementById('preview-panel')!;
const pages = () => document.getElementById('preview-pages')!;
const alt = () => document.getElementById('preview-alt')!;
const status = () => document.getElementById('preview-status')!;

function setStatus(text: string, isError = false): void {
  status().textContent = text;
  status().classList.toggle('error', isError);
}

let pdfjsPromise: Promise<PdfJs> | null = null;

/** pdf.js is ~1 MB — loaded on first use, never on app boot. */
function loadPdfjs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
    pdfjsPromise.catch(() => { pdfjsPromise = null; }); // retry on the next open
  }
  return pdfjsPromise;
}

/** Drop the open document (preview swap, project switch). */
async function closePdf(): Promise<void> {
  paintSeq++;
  const task = pdfTask;
  pdfTask = null;
  pages().replaceChildren();
  await task?.destroy();
}

/** Show the page pane (PDF) and hide the alternate pane, or vice versa. */
function showPages(usePages: boolean): void {
  pages().hidden = !usePages;
  alt().hidden = usePages;
  if (usePages) alt().replaceChildren();
}

function openPanel(): void {
  panel().classList.remove('collapsed');
}

/** Parse the PDF bytes and paint every page into the pane. */
async function showPdf(data: ArrayBuffer): Promise<void> {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data });
  await task.promise;
  await closePdf();
  pdfTask = task;
  showPages(true);
  await paintPages();
}

/**
 * Paint (or repaint, on resize) the open document, one canvas per page, fit
 * to the pane width at the device pixel ratio. Incremental: page 1 appears
 * as soon as it is ready. A newer paint or a closed document abandons the
 * pass at the next page boundary.
 */
async function paintPages(): Promise<void> {
  const task = pdfDoc();
  if (!task) return;
  const doc = await task.promise;
  const seq = ++paintSeq;
  const container = pages();
  const width = Math.max(container.clientWidth - 2 * PAGE_GUTTER, 200);
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    if (seq !== paintSeq) return;
    const scale = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.className = 'preview-page';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`);
    await page.render({ canvas, viewport }).promise;
    if (seq !== paintSeq) return;
    if (n === 1) container.replaceChildren(canvas);
    else container.appendChild(canvas);
  }
}

/** Repaint at the new width once the pane stops resizing. */
function schedulePaint(): void {
  if (!pdfDoc() || pages().hidden || panel().classList.contains('collapsed')) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => void paintPages(), 150);
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** The document's PDF, saved via the export endpoint (attachment download). */
function documentPdfTarget(path: string): { href: string; name: string } {
  return { href: exportUrl(projectId, path, 'pdf'), name: baseName(path).replace(/\.[^.]+$/, '') + '.pdf' };
}

/** Offer the current download target as a link in the alternate pane. */
function offerDownloadLink(): void {
  if (!downloadTarget) return;
  const link = document.createElement('a');
  link.className = 'preview-download';
  link.href = downloadTarget.href;
  link.download = downloadTarget.name;
  link.textContent = `Download ${downloadTarget.name}`;
  alt().replaceChildren(link);
  showPages(false);
}

async function render(): Promise<void> {
  if (rendering) return;
  const path = currentDocumentPath();
  if (!path) {
    setStatus('No document open');
    return;
  }
  rendering = true;
  setStatus('Rendering…');
  try {
    await flushSave(); // render what the user sees, not the last debounce
    const pdf = await renderPdf(projectId, path);
    downloadTarget = documentPdfTarget(path);
    await showPdf(await pdf.arrayBuffer());
    const count = (await pdfDoc()?.promise)?.numPages ?? 0;
    setStatus(`${path} · ${count} page${count === 1 ? '' : 's'}`);
  } catch (err) {
    setStatus((err as Error).message, true);
    // The PDF may be fine and only the painter broken (pdf.js failed to
    // load); the file itself is still one click away.
    if (downloadTarget) offerDownloadLink();
  } finally {
    rendering = false;
  }
}

// STH-16: SVG is active content — the backend serves it as a download
// (application/octet-stream + attachment), so it never renders here and the
// preview pane offers a download link instead.
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const TEXT_EXTS = ['txt', 'bib', 'csv', 'json', 'typ', 'tex', 'md', 'yaml', 'yml', 'log'];

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}

/**
 * Preview a stored file in the pane (story 014). PDFs go through the page
 * painter; images and text render in the alternate pane; anything else
 * offers a download link. Opens the panel if collapsed.
 */
export async function previewStoredFile(path: string): Promise<void> {
  openPanel();
  setStatus(`Loading ${path}…`);
  const ext = extOf(path);
  try {
    if (ext === 'pdf') {
      const blob = await fetchFileBlob(projectId, path);
      downloadTarget = { href: fileBlobUrl(projectId, path), name: baseName(path) };
      await showPdf(await blob.arrayBuffer());
    } else if (IMAGE_EXTS.includes(ext)) {
      const blob = await fetchFileBlob(projectId, path);
      await closePdf();
      downloadTarget = { href: fileBlobUrl(projectId, path), name: baseName(path) };
      const img = document.createElement('img');
      img.className = 'preview-image';
      img.src = URL.createObjectURL(blob);
      img.alt = path;
      img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
      alt().replaceChildren(img);
      showPages(false);
    } else if (TEXT_EXTS.includes(ext)) {
      const blob = await fetchFileBlob(projectId, path);
      await closePdf();
      downloadTarget = { href: fileBlobUrl(projectId, path), name: baseName(path) };
      const pre = document.createElement('pre');
      pre.className = 'preview-text';
      pre.textContent = await blob.text();
      alt().replaceChildren(pre);
      showPages(false);
    } else {
      await closePdf();
      downloadTarget = { href: fileBlobUrl(projectId, path), name: baseName(path) };
      offerDownloadLink();
    }
    setStatus(path);
  } catch (err) {
    showPages(false);
    alt().replaceChildren();
    setStatus((err as Error).message, true);
  }
}

/** Save through a same-origin link; the export endpoint answers as an attachment. */
function saveLink(href: string, name: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function download(format: ExportFormat): Promise<void> {
  const path = currentDocumentPath();
  if (!path) {
    setStatus('No document open');
    return;
  }
  await flushSave();
  const stem = baseName(path).replace(/\.[^.]+$/, '');
  saveLink(exportUrl(projectId, path, format), `${stem}.${format}`);
}

/** The pane's Download button: whatever is showing — the rendered PDF or the stored file. */
async function downloadShown(): Promise<void> {
  if (downloadTarget) {
    saveLink(downloadTarget.href, downloadTarget.name);
    return;
  }
  await download('pdf');
}

export function initPreview(activeProjectId: number): void {
  projectId = activeProjectId;
  // Per-project reset (story 006): drop a previous project's rendered PDF and
  // collapse the pane so it doesn't show stale content after a switch.
  void closePdf();
  downloadTarget = null;
  showPages(true);
  setStatus('');
  panel().classList.add('collapsed');

  if (listenersWired) return; // toggle/refresh/export listeners bind once
  listenersWired = true;

  document.getElementById('toggle-preview')!.addEventListener('click', () => {
    const opened = !panel().classList.toggle('collapsed');
    if (opened && !pdfDoc()) void render();
    else if (opened) schedulePaint(); // the pane may have been resized while hidden
  });
  document.getElementById('preview-close')!.addEventListener('click', () => panel().classList.add('collapsed'));
  document.getElementById('preview-refresh')!.addEventListener('click', () => void render());
  document.getElementById('preview-download')!.addEventListener('click', () => void downloadShown());
  document.getElementById('export-pdf')!.addEventListener('click', () => void download('pdf'));
  document.getElementById('export-docx')!.addEventListener('click', () => void download('docx'));
  document.getElementById('export-tex')!.addEventListener('click', () => void download('tex'));
  document.getElementById('export-pptx')!.addEventListener('click', () => void download('pptx'));
  new ResizeObserver(schedulePaint).observe(pages());
  wireFloatingWindow();
}

// ---- Floating-window drag + resize ------------------------------------------

/** Make the preview pane draggable by its toolbar and resizable from the grip. */
function wireFloatingWindow(): void {
  const el = panel();
  const toolbar = document.getElementById('preview-toolbar')!;
  const grip = document.getElementById('preview-resize')!;

  // Drag: anchor to the left edge (drop the default right-anchor) and move.
  toolbar.addEventListener('pointerdown', (e) => {
    // Don't start a drag from the toolbar's buttons.
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    toolbar.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const left = clamp(ev.clientX - offX, 0, window.innerWidth - rect.width);
      const top = clamp(ev.clientY - offY, 0, window.innerHeight - 44);
      el.style.setProperty('--preview-right', 'auto');
      el.style.setProperty('--preview-left', `${left}px`);
      el.style.setProperty('--preview-top', `${top}px`);
    };
    const onUp = () => {
      toolbar.releasePointerCapture(e.pointerId);
      toolbar.removeEventListener('pointermove', onMove);
      toolbar.removeEventListener('pointerup', onUp);
    };
    toolbar.addEventListener('pointermove', onMove);
    toolbar.addEventListener('pointerup', onUp);
  });

  // Resize from the bottom-right grip.
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    // Pin the current left/top so resizing doesn't fight the right-anchor.
    el.style.setProperty('--preview-right', 'auto');
    el.style.setProperty('--preview-left', `${rect.left}px`);
    el.style.setProperty('--preview-top', `${rect.top}px`);
    grip.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const w = clamp(ev.clientX - rect.left, 320, window.innerWidth - rect.left - 8);
      const h = clamp(ev.clientY - rect.top, 240, window.innerHeight - rect.top - 8);
      el.style.setProperty('--preview-width', `${w}px`);
      el.style.setProperty('--preview-height', `${h}px`);
    };
    const onUp = () => {
      grip.releasePointerCapture(e.pointerId);
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
