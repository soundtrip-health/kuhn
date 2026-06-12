// PDF preview pane + export buttons (story 019). Rendering happens on the
// backend (markdown → Typst → PDF in the story-018 sandbox); this module
// saves the current document, fetches the PDF, and shows it in an iframe.
// Compile failures arrive as readable JSON errors and are shown verbatim.

import { exportUrl, renderPdf } from './api';
import { currentDocumentPath, flushSave } from './editor';

let projectId = 0;
let blobUrl: string | null = null;
let rendering = false;

const panel = () => document.getElementById('preview-panel')!;
const frame = () => document.getElementById('preview-frame') as HTMLIFrameElement;
const status = () => document.getElementById('preview-status')!;

function setStatus(text: string, isError = false): void {
  status().textContent = text;
  status().classList.toggle('error', isError);
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
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(pdf);
    frame().src = blobUrl;
    setStatus(path);
  } catch (err) {
    setStatus((err as Error).message, true);
  } finally {
    rendering = false;
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
  document.getElementById('toggle-preview')!.addEventListener('click', () => {
    const opened = !panel().classList.toggle('collapsed');
    if (opened && !blobUrl) void render();
  });
  document.getElementById('preview-refresh')!.addEventListener('click', () => void render());
  document.getElementById('export-docx')!.addEventListener('click', () => void download('docx'));
  document.getElementById('export-tex')!.addEventListener('click', () => void download('tex'));
}
