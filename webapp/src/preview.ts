// PDF preview pane + export buttons (story 019), extended into a general file
// preview pane (story 014). Rendering happens on the backend (markdown → Typst
// → PDF in the story-018 sandbox); this module saves the current document,
// fetches the PDF, and shows it in an iframe. It also previews *stored* files
// on demand — PDFs in the same iframe, images/text in a sibling pane, unknown
// types as a download link. The pane has one owner: opening a file preview
// replaces the render preview and a re-render replaces the file preview (last
// action wins; they don't fight over the surface).

import { exportUrl, fetchFileBlob, fileBlobUrl, renderPdf } from './api';
import { currentDocumentPath, flushSave } from './editor';

let projectId = 0;
let listenersWired = false;
let blobUrl: string | null = null;
let rendering = false;

const panel = () => document.getElementById('preview-panel')!;
const frame = () => document.getElementById('preview-frame') as HTMLIFrameElement;
const alt = () => document.getElementById('preview-alt')!;
const status = () => document.getElementById('preview-status')!;

function setStatus(text: string, isError = false): void {
  status().textContent = text;
  status().classList.toggle('error', isError);
}

/** Drop any live object URL (preview swap or close). */
function revokeBlob(): void {
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
}

/** Show the iframe (PDF) and hide the alternate pane, or vice versa. */
function showFrame(useFrame: boolean): void {
  frame().hidden = !useFrame;
  alt().hidden = useFrame;
  if (useFrame) alt().replaceChildren();
}

function openPanel(): void {
  panel().classList.remove('collapsed');
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
    revokeBlob();
    blobUrl = URL.createObjectURL(pdf);
    frame().src = blobUrl;
    showFrame(true);
    setStatus(path);
  } catch (err) {
    setStatus((err as Error).message, true);
  } finally {
    rendering = false;
  }
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
const TEXT_EXTS = ['txt', 'bib', 'csv', 'json', 'typ', 'tex', 'md', 'yaml', 'yml', 'log'];

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}

/**
 * Preview a stored file in the pane (story 014). PDFs reuse the render iframe;
 * images and text render in the alternate pane; anything else offers a download
 * link. Opens the panel if collapsed. Blob URLs are revoked on the next swap.
 */
export async function previewStoredFile(path: string): Promise<void> {
  openPanel();
  setStatus(`Loading ${path}…`);
  const ext = extOf(path);
  try {
    if (ext === 'pdf') {
      const blob = await fetchFileBlob(projectId, path);
      revokeBlob();
      blobUrl = URL.createObjectURL(blob);
      frame().src = blobUrl;
      showFrame(true);
    } else if (IMAGE_EXTS.includes(ext)) {
      const blob = await fetchFileBlob(projectId, path);
      revokeBlob();
      blobUrl = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.className = 'preview-image';
      img.src = blobUrl;
      img.alt = path;
      alt().replaceChildren(img);
      showFrame(false);
    } else if (TEXT_EXTS.includes(ext)) {
      const blob = await fetchFileBlob(projectId, path);
      revokeBlob();
      const pre = document.createElement('pre');
      pre.className = 'preview-text';
      pre.textContent = await blob.text();
      alt().replaceChildren(pre);
      showFrame(false);
    } else {
      revokeBlob();
      const link = document.createElement('a');
      link.className = 'preview-download';
      link.href = fileBlobUrl(projectId, path);
      link.download = path.split('/').pop() ?? path;
      link.textContent = `Download ${link.download}`;
      alt().replaceChildren(link);
      showFrame(false);
    }
    setStatus(path);
  } catch (err) {
    showFrame(false);
    alt().replaceChildren();
    setStatus((err as Error).message, true);
  }
}

async function download(format: 'docx' | 'tex'): Promise<void> {
  const path = currentDocumentPath();
  if (!path) {
    setStatus('No document open');
    return;
  }
  await flushSave();
  // Content-Disposition: attachment on the endpoint makes this a download
  const a = document.createElement('a');
  a.href = exportUrl(projectId, path, format);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function initPreview(activeProjectId: number): void {
  projectId = activeProjectId;
  // Per-project reset (story 006): drop a previous project's rendered PDF and
  // collapse the pane so it doesn't show stale content after a switch.
  revokeBlob();
  frame().removeAttribute('src');
  showFrame(true);
  setStatus('');
  panel().classList.add('collapsed');

  if (listenersWired) return; // toggle/refresh/export listeners bind once
  listenersWired = true;

  document.getElementById('toggle-preview')!.addEventListener('click', () => {
    const opened = !panel().classList.toggle('collapsed');
    if (opened && !blobUrl) void render();
  });
  document.getElementById('preview-close')!.addEventListener('click', () => panel().classList.add('collapsed'));
  document.getElementById('preview-refresh')!.addEventListener('click', () => void render());
  document.getElementById('export-docx')!.addEventListener('click', () => void download('docx'));
  document.getElementById('export-tex')!.addEventListener('click', () => void download('tex'));
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
