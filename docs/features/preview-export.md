---
title: Preview and export
area: preview
keywords: preview, PDF, render, page map, export, Word, docx, LaTeX, tex, pptx, slides, marp, theme, reference document, template, Docker, typst, pandoc, render error, timeout
---

# Preview and export

Markdown is the canonical format; everything else is produced from it on demand. The PDF preview is Markdown → Pandoc → Typst → PDF, Word and LaTeX exports are Pandoc runs, and slide decks go through Marp. All of it executes in sandboxed Docker containers on the backend (no network, project mounted read-only), never in the browser and never in the backend process itself.

## Preview PDF panel

**What it does.** Renders the open document to PDF and paints its pages in a floating pane you can move and resize. The pane also previews stored files opened from the Files panel (PDFs, images, text; anything else as a download link).

**How to use it.** Click "Preview PDF" in the top bar. The first open renders immediately; later opens show the last PDF, and "Render" ("Re-render the PDF") in the pane's toolbar renders again. While it runs the status line says "Rendering…", then "<path> · 12 pages". "Download" ("Save the PDF shown here") saves whatever the pane is showing; the close button hides the pane without discarding the PDF. Drag the toolbar to move the pane and the corner grip ("Drag to resize") to resize it.

**Prerequisites.** A document open in the editor ("No document open" otherwise), and the Docker images below.

**Gotchas.** A render always saves the editor first, so it shows what you see, not the last autosave. Pages are painted as canvases, which is why the preview works on phones and in in-app browsers that have no built-in PDF viewer; use "Download" if you need the browser's own viewer.

## Render pipeline

**What it does.** For a prose document: Pandoc converts the Markdown to Typst with `--standalone`, `--citeproc` against the project bibliography, the page-break filter and the page-map filter; Typst compiles the result to PDF; a second, query-only Typst pass reads the page map. The intermediate `.preview-<hash>.typ` is written beside the source (so relative image paths resolve) and deleted afterwards.

**How to use it.** Nothing to configure. Before every render the backend regenerates `draft/references.bib` from the reference store, so a citation added with `/cite` or by an agent resolves on the next render (see `citations.md`). A `template:` in the front matter or a project default selects the page layout (see `editor.md`).

**Prerequisites.** Docker, `pandoc/core` and a Typst image. Each container runs with 1 CPU, 512 MB and a 60 second limit; captured output is capped at 32 MB.

**Gotchas.** Only `draft/references.bib` is read. A hand-written `.bib` anywhere else is ignored by design. Citations in slide decks are not resolved at all (see below).

## Render cache

**What it does.** Rendered PDFs (with their page maps) are cached in memory on the backend, keyed by a hash of the project, the document path, the document bytes, the bibliography, the template source and, for decks, the theme CSS. Up to 20 PDFs are kept; the oldest is evicted first. Two renders of identical content at the same moment share one run.

**How to use it.** Nothing to do. A repeat render of an unchanged document returns instantly (the response carries `X-Render-Cache: hit`); the "PDF (.pdf)" export and the page map reuse the same entry.

**Prerequisites.** None.

**Gotchas.** Anything that changes the hash re-renders: any edit, a reference added or corrected, an org template or theme re-uploaded under the same name, or switching the project default template. A backend restart empties the cache.

## Page map

**What it does.** A list of where every top-level block starts (page and vertical offset) plus the measured length of every heading named in `page_limits:`. It is what draws the dashed "Page N" lines and the budget badges in the editor, and the "12 pages (last 40% full)" figure in the status bar.

**How to use it.** It is fetched automatically after each successful preview render (`POST /api/projects/:id/page-map`, served from the render cache). To refresh it after editing, render again.

**Prerequisites.** A prose document (slide decks have no page map) and a render that succeeded.

**Gotchas.** The page map comes from a separate Typst query pass. If that pass fails the PDF still appears and only the lines and badges are missing; the backend logs `page_map_failed` with the reason.

## Exporting Word, LaTeX, slides and PDF

**What it does.** Produces a file from the current document: `.docx` via Pandoc with the template's Word reference document, `.tex` via Pandoc, `.pptx` via Marp, or the rendered PDF itself.

**How to use it.** Open the "Export" menu in the top bar and choose "Word (.docx)", "LaTeX (.tex)", "Slides (.pptx)" or "PDF (.pdf)". The editor saves first, then the browser downloads `<document name>.<format>`. The underlying route is `GET /api/projects/:id/export?path=<file>&format=pdf|docx|tex|pptx|html`; `html` (a Marp HTML deck) is available through the API only.

**Prerequisites.** Viewer role or higher; `pandoc/core` for docx and tex, a Typst image for pdf, a Marp image for pptx and html.

**Gotchas.** `\newpage` chips survive every format: Word gets a real page break, LaTeX keeps `\newpage`. Word and LaTeX exports run citeproc like the preview, so references come out as formatted text, not as `\cite` commands. "Slides (.pptx)" converts any Markdown, but only a `marp: true` deck paginates sensibly.

## Word reference documents and the project default template

**What it does.** Each Typst template can carry a Word reference document (`.docx`) whose page setup and styles Pandoc applies to Word exports, so the `.docx` paginates like the PDF. Kuhn ships one for `nih-grant` and one for `manuscript`; `default` has none and gets Pandoc's stock styles.

**How to use it.** Set `template:` in the document's front matter or a project default in the setup wizard's "Page layout" select; the Word export picks the matching reference document by itself. Organization owners can attach a reference document to an uploaded org template on the "Templates" tab of the organization admin ("A .docx whose page setup and styles Word exports of this template should use"); an active org template shadows a Kuhn template of the same name for both PDF and Word (see `org-admin.md`).

**Prerequisites.** The owner role to upload or attach; reference documents are capped at 4 MB.

**Gotchas.** A template with no reference document degrades quietly to Pandoc's stock `.docx` styling. An unknown template name fails the Word export the same way it fails the preview.

## Marp slide decks

**What it does.** A document whose front matter contains `marp: true` renders as slides instead of pages: the preview is a Marp PDF, one page per slide, and "Slides (.pptx)" gives a PowerPoint file.

**How to use it.** Start the file with:

```yaml
---
marp: true
theme: kuhn
---
```

and separate slides with `---`. `theme:` accepts Marp's built-in `default`, `gaia` and `uncover`, Kuhn's `kuhn` (warm paper ground, serif body) and `kuhn-dark` (the same on a slate ground), or a theme uploaded by your organization, which shadows a Kuhn theme of the same name (see `org-admin.md`). Other Marp directives in the block pass through to Marp unchanged. Images from the project are read directly from the project folder.

**Prerequisites.** A Marp image (see below). Decks get 1 GB and 120 seconds per render, more than prose.

**Gotchas.** Decks skip citeproc, so `/cite` chips are not resolved; cite informally. Decks have no page map, so no "Page N" lines and no `page_limits:` badges. `\newpage` has no meaning in a deck. The `.pptx` export first tries an editable deck (real text boxes) and, if the image lacks LibreOffice, falls back to one image per slide without reporting the difference. An unknown theme name is left to Marp, which fails the render.

## Docker images

**What it does.** Every render and export runs inside one of four container images chosen by the backend configuration.

**How to use it.** Pull or build them once on the machine that runs the backend: `docker pull pandoc/core:latest` (all prose previews, Word and LaTeX exports); `docker build -t kuhn/typst:latest docker/typst` (PDF compilation; the official Typst image plus the Liberation, Nimbus, Carlito and Caladea fonts the `nih-grant` and `manuscript` templates name); `docker build -t kuhn/marp:latest docker/marp` (slide decks; the official Marp CLI image plus LibreOffice for editable `.pptx`). `minidocks/poppler:latest` is used only for organization-library PDF ingestion, not for preview or export. The image names can be overridden with `SANDBOX_PANDOC_IMAGE`, `SANDBOX_TYPST_IMAGE` and `SANDBOX_MARP_IMAGE`; the stock `ghcr.io/typst/typst` and `marpteam/marp-cli` images work with the losses described above.

**Prerequisites.** Docker installed and reachable by the backend user. Changing an image variable needs a backend restart.

**Gotchas.** With the stock Typst image every document still renders, but Typst substitutes Libertinus for Arial and Times, so page counts and `page_limits:` badges no longer match what Word or a funder's checker would show.

## Render errors

**What it does.** A failed render or export never produces a silent blank: the message comes back to the preview pane's status line in red, verbatim, and the backend writes a `render_failed` line to its log.

**How to use it.** Read the status line. A Typst or Pandoc failure reads `Render failed (exit 1): …` followed by up to 4,000 characters of the tool's own output, which names the line or the missing image. `Sandbox timed out after 60000ms` means the 60 second limit was hit (120 seconds for decks). `Output exceeds 33554432 bytes` means the PDF was over 32 MB. `Failed to start sandbox: …` means Docker itself could not be launched; a missing image also surfaces as `Render failed` with Docker's message. `Unknown template "x" — see the template list (front matter `template:`)` is a `template:` typo or a disabled org template. If the PDF rendered but the browser could not paint it, the pane offers "Download <name>.pdf" instead.

**Prerequisites.** None.

**Gotchas.** Exports triggered from the "Export" menu download as files, so an export failure shows up as a failed download rather than in the preview pane; render the preview to see the message, since it runs the same pipeline.
