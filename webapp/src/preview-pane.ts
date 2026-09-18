// The floating PDF preview pane (story 019, extended into a general file
// preview pane in story 014), with its host injected (issue #172). The pane
// knows how to paint a PDF's pages with pdf.js, show images/text/download
// links for stored files, drag and resize itself, and feed the editor's
// page-break lines from a page map — but not WHERE the document lives or how
// it is fetched. The member app (preview.ts) hosts it over the project API
// and the member editor; the external-reviewer shell (review/main.ts) hosts
// the same pane over /api/review/* and the reviewer's editor. Nothing here
// may import a member-only module: the review bundle rides on this file.
//
// Why pdf.js, not `<iframe src="blob:…">` (the original design): an iframe
// hands the PDF to the browser's native viewer, and there isn't one on
// Android Chrome, in in-app browsers (a magic link opened from a mail
// client), or on desktop Chrome with "download PDFs instead" switched on.
// Those users got a bare file placeholder — a PDF icon, the blob's UUID and
// an "Open" button that did nothing (bug report, 2026-09-04). Canvases paint
// everywhere; the Download button covers saving the file.
//
// DOM contract (index.html and review.html carry the same markup):
// #toggle-preview (opener, outside the pane), #preview-panel, #preview-toolbar,
// #preview-refresh, #preview-download, #preview-close, #preview-status,
// #preview-pages, #preview-alt, #preview-resize.

import type { EditorView } from '@milkdown/kit/prose/view';

import type { ExportFormat } from './api';
import { applyPageMap, clearPageMap, type PageMap } from './page-breaks';

type PdfJs = typeof import('pdfjs-dist');
type PdfTask = import('pdfjs-dist').PDFDocumentLoadingTask;

/** What the pane needs from whoever hosts it. */
export interface PreviewHost {
  /** Path of the open document, or null when nothing is open. */
  currentPath(): string | null;
  /** Save what the user sees before rendering (a no-op for read-only hosts). */
  flushSave(): Promise<void>;
  /** The live ProseMirror view for the page-break lines — null when none. */
  editorView(): EditorView | null;
  /** Render the document at `path` to PDF; rejects with the backend's readable error. */
  renderPdf(path: string): Promise<Blob>;
  /** The page map of the last render (null for slide decks / a failed page query). */
  fetchPageMap(path: string): Promise<PageMap | null>;
  /** Attachment URL of a document export — the Download button's target. */
  exportUrl(path: string, format: ExportFormat): string;
  /** Stored-file previews (the member Files panel); absent for hosts without a file API. */
  fetchFileBlob?(path: string): Promise<Blob>;
  fileUrl?(path: string): string;
}

export interface PreviewPane {
  /** Render the host's current document and show it (saves first). */
  render(): Promise<void>;
  /** Preview a stored file (story 014); opens the pane. Needs host.fetchFileBlob. */
  previewStoredFile(path: string): Promise<void>;
  /** Trigger a document export download (saves first). */
  download(format: ExportFormat): Promise<void>;
  /** Drop the shown document and collapse the pane (project switch). */
  reset(): void;
}

const PAGE_GUTTER = 12;
/** Cap the canvas backing scale — a 3× phone screen would make a 40-page deck heavy. */
const MAX_DPR = 2;

// STH-16: SVG is active content — the backend serves it as a download
// (application/octet-stream + attachment), so it never renders here and the
// preview pane offers a download link instead.
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const TEXT_EXTS = ['txt', 'bib', 'csv', 'json', 'typ', 'tex', 'md', 'yaml', 'yml', 'log'];

let pdfjsPromise: Promise<PdfJs> | null = null;

/** pdf.js is ~1 MB — loaded on first use, never on app boot. Shared by every pane. */
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

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Create the pane over the page's #preview-panel markup and wire its buttons.
 * Call once per page; a host that switches documents keeps the pane and
 * calls reset().
 */
export function createPreviewPane(host: PreviewHost): PreviewPane {
  let rendering = false;
  /** The open pdf.js document (render preview or a stored PDF), if any — via its loading task, which owns teardown. */
  let pdfTask: PdfTask | null = null;
  const pdfDoc = () => pdfTask?.destroyed === false ? pdfTask : null;
  /** Bumped per paint so a superseded pass stops painting stale pages. */
  let paintSeq = 0;
  /** What the Download button saves: the current document's PDF, or a stored file. */
  let downloadTarget: { href: string; name: string } | null = null;
  let resizeTimer: number | undefined;

  const panel = () => document.getElementById('preview-panel')!;
  const pages = () => document.getElementById('preview-pages')!;
  const alt = () => document.getElementById('preview-alt')!;
  const status = () => document.getElementById('preview-status')!;

  function setStatus(text: string, isError = false): void {
    status().textContent = text;
    status().classList.toggle('error', isError);
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

  /** The document's PDF, saved via the export endpoint (attachment download). */
  function documentPdfTarget(path: string): { href: string; name: string } {
    return { href: host.exportUrl(path, 'pdf'), name: baseName(path).replace(/\.[^.]+$/, '') + '.pdf' };
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
    const path = host.currentPath();
    if (!path) {
      setStatus('No document open');
      return;
    }
    rendering = true;
    setStatus('Rendering…');
    try {
      await host.flushSave(); // render what the user sees, not the last debounce
      const pdf = await host.renderPdf(path);
      downloadTarget = documentPdfTarget(path);
      await showPdf(await pdf.arrayBuffer());
      const count = (await pdfDoc()?.promise)?.numPages ?? 0;
      setStatus(`${path} · ${count} page${count === 1 ? '' : 's'}`);
      // Page-break lines in the editor: the map comes from the render cache the
      // PDF just filled. Losing it loses only the lines, never the preview.
      try {
        const map = await host.fetchPageMap(path);
        if (host.currentPath() === path) applyPageMap(host.editorView(), map);
      } catch {
        clearPageMap(host.editorView());
      }
    } catch (err) {
      setStatus((err as Error).message, true);
      // The PDF may be fine and only the painter broken (pdf.js failed to
      // load); the file itself is still one click away.
      if (downloadTarget) offerDownloadLink();
    } finally {
      rendering = false;
    }
  }

  /**
   * Preview a stored file in the pane (story 014). PDFs go through the page
   * painter; images and text render in the alternate pane; anything else
   * offers a download link. Opens the panel if collapsed.
   */
  async function previewStoredFile(path: string): Promise<void> {
    const { fetchFileBlob, fileUrl } = host;
    if (!fetchFileBlob || !fileUrl) return; // a host without a file API (the reviewer shell)
    openPanel();
    setStatus(`Loading ${path}…`);
    const ext = extOf(path);
    try {
      if (ext === 'pdf') {
        const blob = await fetchFileBlob(path);
        downloadTarget = { href: fileUrl(path), name: baseName(path) };
        await showPdf(await blob.arrayBuffer());
      } else if (IMAGE_EXTS.includes(ext)) {
        const blob = await fetchFileBlob(path);
        await closePdf();
        downloadTarget = { href: fileUrl(path), name: baseName(path) };
        const img = document.createElement('img');
        img.className = 'preview-image';
        img.src = URL.createObjectURL(blob);
        img.alt = path;
        img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
        alt().replaceChildren(img);
        showPages(false);
      } else if (TEXT_EXTS.includes(ext)) {
        const blob = await fetchFileBlob(path);
        await closePdf();
        downloadTarget = { href: fileUrl(path), name: baseName(path) };
        const pre = document.createElement('pre');
        pre.className = 'preview-text';
        pre.textContent = await blob.text();
        alt().replaceChildren(pre);
        showPages(false);
      } else {
        await closePdf();
        downloadTarget = { href: fileUrl(path), name: baseName(path) };
        offerDownloadLink();
      }
      setStatus(path);
    } catch (err) {
      showPages(false);
      alt().replaceChildren();
      setStatus((err as Error).message, true);
    }
  }

  async function download(format: ExportFormat): Promise<void> {
    const path = host.currentPath();
    if (!path) {
      setStatus('No document open');
      return;
    }
    await host.flushSave();
    const stem = baseName(path).replace(/\.[^.]+$/, '');
    saveLink(host.exportUrl(path, format), `${stem}.${format}`);
  }

  /** The pane's Download button: whatever is showing — the rendered PDF or the stored file. */
  async function downloadShown(): Promise<void> {
    if (downloadTarget) {
      saveLink(downloadTarget.href, downloadTarget.name);
      return;
    }
    await download('pdf');
  }

  function reset(): void {
    // Per-project reset (story 006): drop a previous project's rendered PDF and
    // collapse the pane so it doesn't show stale content after a switch.
    void closePdf();
    downloadTarget = null;
    showPages(true);
    setStatus('');
    panel().classList.add('collapsed');
  }

  // ---- Floating-window drag + resize ----------------------------------------

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

  // ---- Wiring (once per pane) -----------------------------------------------

  document.getElementById('toggle-preview')!.addEventListener('click', () => {
    const opened = !panel().classList.toggle('collapsed');
    if (opened && !pdfDoc()) void render();
    else if (opened) schedulePaint(); // the pane may have been resized while hidden
  });
  document.getElementById('preview-close')!.addEventListener('click', () => panel().classList.add('collapsed'));
  document.getElementById('preview-refresh')!.addEventListener('click', () => void render());
  document.getElementById('preview-download')!.addEventListener('click', () => void downloadShown());
  new ResizeObserver(schedulePaint).observe(pages());
  wireFloatingWindow();

  return { render, previewStoredFile, download, reset };
}
