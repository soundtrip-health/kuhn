---
title: The editor
area: editor
keywords: editor, rich text, block menu, slash, newpage, page break, page lines, page limits, page_limits, template, page layout, front matter, source mode, autosave, saved, history, collaboration, cursors, suggestions, diff, shortcuts
---

# The editor

The centre pane is a rich Markdown editor (Milkdown/Crepe). The file on disk is always plain Markdown; the editor is a view of it. Everything that matters for the PDF — page breaks, page budgets, page layout — is expressed in that Markdown or in its YAML front matter, so agents and exports see exactly what you see.

## Rich text editing

**What it does.** Formats Markdown as you type and shows the result in place: headings, lists, quotes, tables, images, code blocks and KaTeX math. The status bar at the bottom shows the document path, the save state and a live word count ("1,204 words").

**How to use it.** Markdown shortcuts work directly: `#` for a heading, `-` for a list, `**bold**`, `` `code` ``, `$math$`, `---` for a divider. Select text to get the formatting toolbar (bold, italic, strikethrough, inline code, math, link) plus a "Comment" button that starts a margin comment (see `comments.md`). A blank document shows the placeholder `Type "/" for commands` and, underneath, "This document is empty. Start typing, or ask your project manager in the chat to interview you and draft a skeleton from your materials."

**Prerequisites.** The editor role in the organization. Viewers open every document read-only: no toolbar, no block menu, no saves.

**Gotchas.** Files that do not end in `.md` (`.bib`, `.json`, `.txt`, `.csv`) open as raw text with no rich mode. In a slide deck (`marp: true`) a divider is a slide boundary, not a rule.

## Block menu

**What it does.** One menu for inserting block types and for calling agents inline.

**How to use it.** Type `/` at the start of an empty paragraph or heading, or hover a block and click the "+" that appears at its left edge (that inserts a new paragraph below it and opens the menu). Keep typing to filter. The groups are: Text ("Text", "Heading 1" to "Heading 6", "Quote", "Divider", "Page break"), List ("Bullet List", "Ordered List", "Task List"), Advanced ("Image", "Code", "Table", "Math") and "AI commands" ("Cite", "Write", "Research", "Figure", "Review", "Ask", "Status"). Picking an AI command removes the typed `/word` and runs it at the caret; `/cite` opens the cite picker (see `citations.md`), `/write` streams a Writer draft into the document with "Accept", "Reject", "Retry" and "Dismiss" controls. The other commands are listed with their owning agent under "Slash commands" in the "?" help popover and in `agents-and-chat.md`.

**Prerequisites.** Editor role. Read-only documents have no block menu.

**Gotchas.** The `/` trigger only fires when the caret is at the end of the block's text; in the middle of a sentence it is just a slash. Of the AI commands only "Cite" and "Write" do their work inline today; "Research", "Figure", "Review", "Ask" and "Status" show a "Routed to <agent>" notice and nothing more — use the chat panel for those tasks.

## Images, tables, code and math

**What it does.** The "Image" block takes a link; "Table" inserts an editable table; "Code" is a CodeMirror block with syntax highlighting; "Math" is a display-math block and `$...$` is inline math, both rendered with KaTeX and passed to Pandoc as LaTeX math.

**How to use it.** For an image, upload the file with "Upload" in the Files panel first, then paste its project-relative path (for example `figures/fig1.png`) into the image block's "or paste link" field. The render writes its Typst next to the document, so relative paths resolve the same way in the editor, the PDF and the exports.

**Prerequisites.** None.

**Gotchas.** The image block's own "Upload file" button produces a temporary browser URL, not a project file: the picture shows until you reload and never reaches the PDF. Use the Files panel.

## Page breaks (the `\newpage` chip)

**What it does.** A hard page break in the PDF preview and in every export, shown in the editor as a chip labelled "Page break" rather than a bare `\newpage` paragraph.

**How to use it.** Either choose "Page break" from the block menu (Text group, next to "Divider"), or type `\newpage` as the only content of a paragraph and it becomes the chip on the spot; `\pagebreak` and `\clearpage` are accepted too and preserved as typed. The chip is a block: click it to select, drag it, delete it with Backspace. It saves back to Markdown as a line containing exactly the marker you used. At render time a Pandoc filter turns that line into Typst's `#pagebreak()`, a Word page break in `.docx` and a CSS page break in HTML; the LaTeX export keeps the raw `\newpage`.

**Prerequisites.** None.

**Gotchas.** The marker only converts inside a paragraph; in a heading or code block it stays literal text. Do not use it in a slide deck (`marp: true`), where `---` separates slides and `\newpage` has no meaning.

## Page lines ("Page N")

**What it does.** Dashed "Page N" lines in the editor mark where the PDF turned a page, and the status bar shows "12 pages (last 40% full)". They come from the page map of the last render, not from the editor's own layout, so they are exact for the template, fonts and margins that produced the PDF.

**How to use it.** Click "Preview PDF" in the top bar (the first open renders automatically) or "Render" in the preview toolbar. Once the PDF is painted the lines appear before each block that starts a new page. Edit the document and the lines dim (dotted, faded) because they may have moved; click "Render" again to refresh them. A page that starts inside a long paragraph is reported on the next line as "Page 4 · page 3 starts inside the block above".

**Prerequisites.** A successful render of this document since it was opened; the `pandoc/core` and `kuhn/typst` Docker images (see `preview-export.md`).

**Gotchas.** Lines are matched to editor blocks by the first 24 letters and digits of each block's text, so blocks Pandoc adds (the bibliography) or merges are skipped silently. Slide decks get no lines. If the page query fails the PDF still shows but no lines appear, and the backend logs `page_map_failed`.

## Section page budgets (`page_limits:`)

**What it does.** Gives a heading a page budget and shows, after each render, how many pages that section actually occupies, as a badge on the heading: "1.07 / 1 page" or "5.5 / 6 pages". Over-budget badges turn red and the status bar adds "· over limit: Specific Aims 1.07/1".

**How to use it.** Add a `page_limits:` map to the front matter, keyed by the heading text exactly as written (matching ignores case and extra spaces):

```yaml
---
template: nih-grant
page_limits:
  Specific Aims: 1
  Research Strategy: 6
---
```

A section runs from its heading to the next heading of the same or a higher level (or the end of the document) and is measured in fractional pages; 1.07 means it spills 7% of a page past the first. Hovering a badge explains it: `"Specific Aims" runs 1.07 pages against a 1-page limit (page_limits front matter) — from the last render`.

**Prerequisites.** A render since the last edit (badges dim when stale, like page lines). Limits must be numbers greater than zero.

**Gotchas.** The badge measures what Typst laid out with the document's template; without the built `kuhn/typst` image the fonts differ and the numbers drift from what a funder's checker would report.

## Page layout (`template:`)

**What it does.** Chooses the Typst page-layout template the PDF (and the Word export) uses: paper, margins, font, spacing, numbering. Without one, Pandoc's stock layout applies.

**How to use it.** Add `template: <name>` to the front matter. Kuhn ships `default` (Pandoc's stock layout), `nih-grant` (US letter, 0.5 in margins, Arial 11 pt, single-spaced, no page numbers) and `manuscript` (US letter, 1 in margins, Times 12 pt, double-spaced, line and page numbers, title block). A project default is set in the setup wizard's "Page layout" select (preselected as `nih-grant` for grant projects and `manuscript` for manuscript projects; "No project default (documents choose their own)" clears it) and applies to every document without its own `template:` line. Organizations can upload their own templates, which shadow a Kuhn template of the same name (see `org-admin.md`).

**Prerequisites.** The `kuhn/typst` image for metric-compatible fonts; the stock Typst image renders but falls back to Libertinus and page counts change.

**Gotchas.** An unknown name fails the render rather than silently using the default: the preview shows `Unknown template "x" — see the template list (front matter `template:`)`. The same applies to a project default that names a disabled org template.

## Front matter

**What it does.** A YAML block between `---` fences at the very top of the file. Kuhn reads `template:`, `page_limits:`, `marp:` and `theme:` from it; everything else passes through to Pandoc as document metadata.

**How to use it.** The rich editor hides the front matter entirely: it is stripped before the document reaches the editor, and every rich-mode save writes the body only, with the backend re-attaching the block the stored file carries. That holds for external reviewers editing through a share link too, so a reviewer's save keeps your `template:` and `page_limits:`. To read or change the block, click "Source" in the editor sub-header and edit it at the top of the raw Markdown, then "Rich text" to return. Agents can also change it when you ask, since they edit the file directly.

**Prerequisites.** Editor role for changes.

**Gotchas.** Only a block that starts on line 1 counts. A `---` further down is a divider (or, in a Marp deck, a slide break).

## Source mode

**What it does.** Swaps the rich editor for a plain-text CodeMirror view of the exact bytes in storage, with Markdown highlighting and gutter marks on commented lines.

**How to use it.** Click "Source" ("Edit the raw markdown source") in the editor sub-header; the button becomes "Rich text" ("Back to the rich-text editor"). Edits autosave with the same timing as rich mode; Tab indents.

**Prerequisites.** None.

**Gotchas.** Source mode leaves the live-collaboration room: while you are in it you are a single writer straight to storage, and other people's rich-mode edits do not appear until you return. Returning re-opens the rich editor from the stored file.

## Saving and the save indicator

**What it does.** Edits autosave 1.5 seconds after you stop typing. The status bar shows "saved", "saving…", "unsaved changes" or "save failed: <reason>"; the top bar mirrors it as "Saved", "Saving…" or "Save failed".

**How to use it.** Nothing is required for ordinary saves. Press Ctrl+S (Cmd+S on a Mac) to write immediately and record a named version ("Save <path>") in the project history; autosaves are otherwise grouped into one history version at most every two minutes. "History" in the editor sub-header lists versions with "Restore this version"; restoring keeps the current state as a version, so nothing is lost. "Preview PDF", "Render" and every export flush a pending save first, so they always render what you see.

**Prerequisites.** Editor role in an active organization; a suspended organization makes every document read-only.

**Gotchas.** If the open document is moved or deleted underneath you the editor stops saving and says "This document moved — reload to continue editing" or asks you to reload. When an agent changes the open file and you have no unsaved edits, the editor reloads it silently; with unsaved edits it keeps yours and shows "<path> was changed by an agent — reload to pick up the new version".

## Live collaboration

**What it does.** Every `.md` document is a shared Yjs room over the backend's WebSocket. Members who open the same document type into the same live copy; each keystroke reaches the others without a save, and each collaborator's caret is labelled with their display name (or email).

**How to use it.** Open the same document from the same project. External reviewers with a share link appear the same way, and a banner above the document says "External reviewer Jane (comment) is on this document" (see `comments.md` for review links).

**Prerequisites.** A live WebSocket connection to the backend. Viewers join read-only.

**Gotchas.** Only rich mode is collaborative; source mode and non-Markdown files are single-writer. A room lives 30 seconds after its last participant leaves; the next opener seeds it from the saved file. A tab that was asleep or frozen while its room was rebuilt (a backend restart, or everyone else left and someone reopened the document later) reloads the document when it reconnects instead of merging its old copy into the new room; any edit it still had unsaved is written first. If your role is lowered while you are connected your editor reopens read-only within about a minute.

## Agent suggestions and word-level diffs

**What it does.** When an agent proposes an edit, the change appears in the document as struck-through and added text with an accept and a reject control per hunk ("Accept this change", "Reject this change"). Inside a changed paragraph only the changed words are marked; a sentence that was rewritten is struck whole and its replacement shown whole; a paragraph with nothing in common is shown as a full replacement.

**How to use it.** Decide hunk by hunk in place, or open the review dialog ("Review suggested changes") and use "Decide change by change", "Discard suggestion" or "Replace document with proposed".

**Prerequisites.** Editor role; a pending suggestion for the open document.

**Gotchas.** Paragraphs over 400 words are always reviewed as a block.

## Citations and comments

`/cite` inserts a citation chip from the project's reference store and hovering a chip shows its details — see `citations.md`. Select text and use the toolbar's "Comment" button or the "Comments" panel to leave a margin note — see `comments.md`.

## Keyboard shortcuts

**What it does.** The shortcuts the app binds itself, beyond the Markdown typing shortcuts above.

**How to use it.** Ctrl+S / Cmd+S saves now and records a history version. Escape closes the help popover and the dialogs (history, move, share, setup wizard); the "Export" menu closes on a click outside it. Enter sends a chat message ("Send (Enter)"). In source mode, Tab indents and Shift+Tab outdents.

**Prerequisites.** None.
