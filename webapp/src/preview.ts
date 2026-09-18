// Member wiring of the PDF preview pane (story 019 / story 014). The pane
// itself — pdf.js painting, stored-file previews, the floating window, the
// page-break feed — lives in preview-pane.ts with its host injected, so the
// external-reviewer shell can host the same pane over /api/review/*
// (issue #172). This module supplies the member host: the project API
// (api.ts) and the member editor (editor.ts), plus the top-bar Export menu.

import { exportUrl, fetchFileBlob, fetchPageMap, fileBlobUrl, renderPdf } from './api';
import { currentDocumentPath, editorView, flushSave } from './editor';
import { createPreviewPane, type PreviewPane } from './preview-pane';

let projectId = 0;
let pane: PreviewPane | null = null;

/**
 * Preview a stored file in the pane (story 014): PDFs through the page
 * painter, images and text in the alternate pane, anything else as a
 * download link. Opens the panel if collapsed.
 */
export async function previewStoredFile(path: string): Promise<void> {
  await pane?.previewStoredFile(path);
}

export function initPreview(activeProjectId: number): void {
  projectId = activeProjectId;
  if (pane) {
    // Per-project reset (story 006): drop a previous project's rendered PDF
    // and collapse the pane so it doesn't show stale content after a switch.
    pane.reset();
    return; // toggle/refresh/export listeners bind once
  }
  pane = createPreviewPane({
    currentPath: () => currentDocumentPath() || null,
    flushSave,
    editorView,
    renderPdf: (path) => renderPdf(projectId, path),
    fetchPageMap: (path) => fetchPageMap(projectId, path),
    exportUrl: (path, format) => exportUrl(projectId, path, format),
    fetchFileBlob: (path) => fetchFileBlob(projectId, path),
    fileUrl: (path) => fileBlobUrl(projectId, path),
  });
  pane.reset();
  const p = pane;
  document.getElementById('export-pdf')!.addEventListener('click', () => void p.download('pdf'));
  document.getElementById('export-docx')!.addEventListener('click', () => void p.download('docx'));
  document.getElementById('export-tex')!.addEventListener('click', () => void p.download('tex'));
  document.getElementById('export-pptx')!.addEventListener('click', () => void p.download('pptx'));
}
