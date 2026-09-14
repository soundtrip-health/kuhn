---
title: Files
area: files
keywords: file manager, files panel, upload, folder, draft, seed_docs, research, guidance, rename, move, delete, active document, badges, live updates, org library
---

# Files

The "Files" panel on the right is the project workspace: everything you upload, everything agents read and write, and the documents you edit. All access — yours and the agents' — goes through one server-side storage service that keeps every path inside the project's own directory.

## The file manager panel

**What it does.** Shows the project tree, folders first, with a "Project root" row on top and per-file status badges. Clicking a text file opens it in the editor; anything else previews in the preview pane.

**How to use it.** Toggle the panel with "Files" in the top bar. The header holds "New file", "New folder", "Refresh files" and "Upload". Click a folder row to select it — uploads and new files land there ("Uploads and new files/folders land in the selected folder"). Row actions appear on hover or focus and have single-key shortcuts on a focused row: F new file inside, N new folder inside, M "Move to…", R or F2 rename, Delete or Backspace delete, L "Add to org library", S "Promote to org scripts" (script files only).

**Prerequisites.** Viewers can browse, open and preview; every action that changes the workspace needs the editor role, and viewers get an empty action strip.

**Gotchas.** Files that open in the editor have a text extension: md, txt, bib, csv, tsv, json, typ, tex, yaml, yml, toml, xml, log. Collapsed folders are remembered per project in this browser; the selected folder is not — it resets to the root on each project load so an upload never goes to last week's target.

## Project folders

**What it does.** The layout is a convention the agents follow, not something Kuhn pre-creates: a new project has no folders. The first open writes an empty `draft/main.md`, the wizard uploads into `seed_docs/`, and agents create the rest.

**How to use it.** Expect `project.json` (the saved configuration); `draft/` for the deliverable — `draft/main.md` (the Writer's document), `draft/references.bib` (generated from the reference store), `draft/claims.md`, `draft/tables/`, `draft/figures/`; `seed_docs/` for wizard uploads; `research/` for the Research Assistant (`literature-summary.md`, `reviews/`, `summaries/`); `guidance/` for the Advisor's knowledge tree (`index.md`, source documents under `guidance/<project-type>/src/`); `pm/status.md` from the seeding pipeline; `analyst/` for the Analyst's scripts and `analyst/output/run-<id>/` for run outputs; `review/reports/` for Reviewer reports.

**Prerequisites.** None.

**Gotchas.** `draft/references.bib` is generated: agents are refused when they try to write it, and a hand edit is overwritten at the next regeneration (see `citations.md`). A `.git` path segment is reserved for version history and is never listed or writable.

## Uploading files

**What it does.** Uploads files into the selected folder (`POST /api/projects/:id/files/upload`). Any type is accepted; the empty-tree drop zone ("Upload materials") suggests "PDF · DOCX · TXT · BIB" because agents use those most — the Advisor reads uploads during seeding and agents read PDFs as extracted text.

**How to use it.** Click "Upload", drop files onto the tree, or drop them on the "Upload materials" zone. A toast confirms "Uploaded N files to <folder>"; failures are reported by file name.

**Prerequisites.** Editor role ("View only — uploading needs the editor role").

**Gotchas.** 20 MB per file (`STORAGE_MAX_FILE_BYTES`; the client refuses larger files with "File exceeds the 20 MB limit") and at most 20 files per upload. An upload overwrites a file of the same name, but the prior state is committed to version history first ("Snapshot before upload"), so it is recoverable from "History".

## Creating files and folders

**What it does.** Creates an empty text file or folder inside the selected folder.

**How to use it.** "New file" / "New folder" in the header, the row actions "New file inside (F)" / "New folder inside (N)", or the keys. An inline input appears; Enter creates, Escape cancels. A new text file opens in the editor.

**Prerequisites.** Editor role.

**Gotchas.** An empty folder is not broadcast to other tabs or collaborators (they see it on their next refresh) and is not recorded in version history, because git cannot track an empty directory. A file already sitting where a folder should go is a conflict.

## Renaming, moving and deleting

**What it does.** Rename edits the name in place; "Move to…" relocates a file or folder; Delete removes a file or a folder with everything in it. A move or rename is an identity change, not a delete plus create: margin comments, pending agent suggestions, seen markers and the remembered active document follow the file.

**How to use it.** Row actions "Rename (R)", "Move to… (M)", "Delete (Del or Backspace)". Rename shows an inline input and saves the open document first. "Move to…" opens a dialog of destination folders with "Filter folders…", "Move" and "Cancel"; you can also drag a row onto a folder. Delete asks `Delete "name"?` — "and everything inside it" for folders — and warns when the open document is affected.

**Prerequisites.** Editor role.

**Gotchas.** A move is refused when the destination exists, when a folder would move into itself, or when an agent suggestion is already pending at the destination ("A pending edit already exists at …" — accept or reject it first, see `editor.md`). A moved open document is retargeted, not reopened; collaborators' sessions reopen at the new path. Before a delete Kuhn commits the current state ("Snapshot before deleting …"), so file content is recoverable from "History" — an empty folder is not. Deleting the open document or its folder closes the editor and falls back to `draft/main.md` if it survives.

## The active document

**What it does.** The file open in the editor is the project's active document. Kuhn records it per project (`PUT /api/projects/:id/active-document`) so the project reopens on it, shows it as the last breadcrumb segment, and tells every agent about it.

**How to use it.** Open a file. Clicking the breadcrumb's document segment reveals it in the tree.

**Prerequisites.** None.

**Gotchas.** Agents are told "The user currently has <path> open in the editor" and that "the doc", "this document" or "the draft" means that file — not `draft/main.md` — and to name it explicitly when dispatching to another agent. A request without an open document falls back to the project's recorded one; seeding tasks never use it. When it is genuinely ambiguous, the agent is expected to ask.

## Live updates and badges

**What it does.** Changes by agents, collaborators, uploads and external reviewers arrive over the project event feed (see `projects.md`) and update the tree without a refresh. Per-user badges read "new upload", "new AI changes", "modified since last viewed", "suggested changes awaiting review", "processing" / "processed" for library ingestion, and "external" for review-link edits; a collapsed folder shows a count pill ("N files changed since you last looked").

**How to use it.** Opening a file marks it seen and clears its badge; "Refresh files" re-reads the tree.

**Prerequisites.** None.

**Gotchas.** A clean open document is updated in place when an agent changes it; one with unsaved edits is left alone and the status bar says "… was changed by an agent — reload to pick up the new version". Your own autosaves are not in the feed, so they never badge the file. Badges are per user.

## What agents may write, and where

**What it does.** Agents have six file tools — `read_file`, `search_files`, `list_files`, `move_file`, `write_file`, `edit_file` — and each goes through the same storage service as the UI: workspace-relative paths only, absolute paths and `..` refused, symlinks never followed or listed, the 20 MB cap applied. There is no agent delete tool. Which tools an agent holds is set per agent (see `agents-and-chat.md`).

**How to use it.** Nothing to configure. Where a write lands depends on the path: anything under `draft/` becomes a pending suggestion you review in the editor; an existing file elsewhere (a literature review, a guidance note, a reviewer report) is also proposed; a new file outside `draft/` is written directly and badged "new AI changes"; `pm/` and `analyst/` are agent-private and always written directly. Review is described in `editor.md`.

**Prerequisites.** None.

**Gotchas.** The seeding pipeline bypasses suggestions — its first draft lands directly. `read_file` returns a PDF as extracted text (the first 200 pages, `INGEST_MAX_PDF_PAGES`) and reports a scanned PDF as having no extractable text.

## Project files versus the organization library

**What it does.** Project files belong to one project. The organization's knowledge library is an org-wide store the Advisor searches from every project; the row action "Add to org library (L)" copies a project file into it (confirming `Add "name" to the <org> library?`) or, under a restrictive promotion policy, files a suggestion ("Suggested — awaiting admin approval"). Script files have the parallel "Promote to org scripts (S)". Managing the library, approvals and the script catalog is covered in `org-admin.md`.

**How to use it.** Focus a file row and press L, or use the row action.

**Prerequisites.** Editor role. A copy shows "processing" until ingestion finishes, then "processed".

**Gotchas.** The copy is a snapshot; later edits to the project file do not update the library document.
