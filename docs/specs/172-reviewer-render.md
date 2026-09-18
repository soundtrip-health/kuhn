# Spec 172 — Rendered preview for external reviewers

GitHub issue #172: *Invited commentors/editors can't see rendered docs.*

Now that documents carry page-layout templates, `\newpage` chips, page-break
lines and `page_limits:` budgets, an external reviewer who only sees the rich
editor is missing the thing they were asked to judge. Reviewers on every link
mode (view / comment / edit) must be able to render the linked document to PDF
and see the same "Page N" lines and budget badges members see.

## Scope

In: a `/api/review/*` render surface; the floating PDF preview pane and page
lines in the reviewer shell; the feature guide.

Out: member behaviour changes; exports beyond what the preview already implies
(the pane's Download button); any change to link modes or minting.

## Backend

All three routes live in `agent-backend/src/routes/review.js`, after the
existing session-bearing routes, and use `reviewerAccess` (reviewer session +
suspension gate). They take **no** path/project parameter — the principal's
`projectId`/`path` come from the link row, exactly like `GET /api/review/file`.
All modes are allowed: rendering is a read of bytes the reviewer already holds.

| Route | Mirrors | Response |
|---|---|---|
| `POST /api/review/render` | `POST /api/projects/:id/render` | PDF bytes, `X-Render-Cache` header |
| `POST /api/review/page-map` | `POST /api/projects/:id/page-map` | `{ pageMap }` |
| `GET /api/review/export?format=` | `GET /api/projects/:id/export` | attachment; every `EXPORT_FORMATS` key, same 400 on a bad format |

Error mapping (StorageError / SandboxError / TemplateError → 4xx with the
verbatim message, `render_failed` log line) must be **the same code** as the
member route: extract it from `routes/render.js` into an exported helper
(`sendRenderError(err, res, ctx)` or similar) and reuse it in both routers.
Log lines (`render`, `page_map`, `export`, `render_failed`) carry
`reviewLinkId` in place of `userId` (verbose dev-phase logging is wanted).

`review-matrix.test.js` gains: the three routes succeed in every mode (mock
`../render.js` `renderPdf`/`exportDocument` partially, as `routes/render.test.js`
does); a member session cookie gets 401 on them (the door swings both ways);
the suspension sweep covers them; a bad export format is 400. Keep the deny
sweep intact.

## Webapp

`webapp/src/preview.ts` currently imports the member editor (`./editor`) and
member API directly, so the review bundle cannot use it. Split it:

- `webapp/src/preview-pane.ts` — the pane itself: pdf.js loading and page
  painting, status line, Download target, stored-file display, floating
  drag/resize, `render()` driven by an injected host:
  ```ts
  export interface PreviewHost {
    currentPath(): string | null;            // open document, or null
    flushSave(): Promise<void>;              // render what the user sees
    editorView(): EditorView | null;         // for applyPageMap / clearPageMap
    renderPdf(path: string): Promise<Blob>;
    fetchPageMap(path: string): Promise<PageMap | null>;
    exportUrl(path: string, format: ExportFormat): string;
  }
  ```
  It keeps the existing DOM contract (`#preview-panel`, `#preview-toolbar`,
  `#preview-refresh`, `#preview-download`, `#preview-close`, `#preview-status`,
  `#preview-pages`, `#preview-alt`, `#preview-resize`, `#toggle-preview`).
- `webapp/src/preview.ts` — member wiring only: `initPreview(projectId)` builds
  the host from `./editor` + `./api` and keeps `previewStoredFile` and the
  Export menu buttons. Member behaviour is unchanged.
- `webapp/src/review/review-api.ts` — `renderPdf(): Promise<Blob>`,
  `fetchPageMap(): Promise<PageMap | null>`, `exportUrl(format)`; all under
  `/api/review/*`, 401 raises `kuhn:review-unauthorized` as today.
- `webapp/review.html` — a "Preview PDF" button (`#toggle-preview`) in the top
  bar, the `#preview-panel` aside (same markup as `index.html`), and
  `#editor-pagecount` in the status bar so the page count / over-limit
  summary shows.
- `webapp/src/review/main.ts` — create the pane once at boot with a host
  whose `currentPath` is the context path, `flushSave` flushes the live
  handle in edit mode (no-op otherwise), `editorView` returns the live view
  or null mid-teardown. The `pageBreaksPlugin` is already registered by
  `editor-core`, so lines and badges paint on the reviewer's editor (read-only
  views included). After a remount (move / refresh) the lines are gone until
  the next render — that is fine.

The review bundle's rule stands: it imports nothing member-only (`preview.ts`
stays out; `preview-pane.ts` must not import `./editor`, `./api` functions,
`./files`, `./workspace`, … — type-only imports are fine).

`review.css`: whatever the pane needs that `style.css` does not already give
it in the flex layout (it is `position: fixed`, so likely nothing).

## Feature guide

- `docs/features/preview-export.md`: a section "Preview for external
  reviewers" — the "Preview PDF" button in the review page's top bar, all
  link modes, Download, page lines/badges, that an edit-mode reviewer's
  unsaved text is saved first, and that the same Docker prerequisites apply.
- `docs/features/comments.md` "Who can comment" (or wherever review links are
  described): one sentence that reviewers can render the document.
- Verify labels against the markup you write.

## Acceptance

1. A claimed view/comment/edit reviewer clicks "Preview PDF" and sees the PDF;
   "Page N" lines and `page_limits:` badges appear in their editor; the
   status bar shows the page count.
2. Render failures show verbatim in the pane's status line (same as members).
3. `npm test` in `agent-backend` and `webapp`, and `tsc` for the webapp, pass.
4. The member preview is byte-for-byte the same behaviour (`preview.ts`
   consumers unchanged: `initPreview`, `previewStoredFile`).
