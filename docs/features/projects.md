---
title: Projects
area: projects
keywords: project, new project, project browser, setup wizard, seeding, project type, manuscript, grant, protocol, SOP, project.json, rename, switch project, event feed, delete project
---

# Projects

A project is one document effort — a manuscript, a grant, a protocol, an SOP — with its own file workspace, bibliography, chat history and agent runs. Projects belong to an organization; you reach them through the breadcrumb in the top bar.

## Creating a project

**What it does.** Creates an empty project in the active organization and switches to it.

**How to use it.** Click the project segment of the breadcrumb (it reads "Select a project" when none is open). In the "Projects" overlay, type a name into "New project name…", pick a type from the select next to it, and click "Create project". The project opens at once; the first time an editor opens a project with no markdown file, Kuhn writes an empty `draft/main.md` and opens the setup wizard.

**Prerequisites.** Editor or owner role in the active organization (the server refuses with `requires editor role`).

**Gotchas.** Creating a project creates no folders — the workspace fills in as you upload and as agents write. A viewer opening a brand-new project lands on "No document", because writing the draft needs the editor role.

## Project browser

**What it does.** The "Projects" overlay is the dashboard for the active organization: one card per project with a type pill, "Open" on the current one, and per-card rename and setup controls.

**How to use it.** Click a card to switch to it. The pencil button ("Rename project") turns the name into an inline editor — Enter or clicking away commits, Escape cancels. The sparkle button reads "Set up" for an untouched project, "Resume setup" when a wizard draft exists, and "Edit setup" once setup is complete; it opens the wizard prefilled with the saved answers. Escape or a backdrop click closes the overlay; a failed load shows "Could not load projects: …" with "Retry".

**Prerequisites.** Rename and setup need the editor role; anyone can browse and switch.

**Gotchas.** Renaming (`PATCH /api/projects/:id`) changes only the record — the workspace directory is keyed by project id, so no files move. The project name and the document title entered in the wizard (`config.title`) are separate fields.

## Setup wizard

**What it does.** A five-step modal ("Project setup · 1 of 5" …) that collects what the agents need before they research and draft. Answers persist as a resumable draft on every "Next", on "Save & close" and on Escape; the last step saves the configuration and optionally launches seeding.

**How to use it.** It opens automatically once per new project, from "Set up project" in the PM's greeting card in chat, or from the project browser. Each step has a collapsed "What helps here?" disclosure.

1. "What are you writing?" — "Document type", "Project title", and "Page layout": the project's default page-layout template, either "No project default (documents choose their own)" or an available template such as "NIH grant attachment (nih-grant)". "Grant" preselects `nih-grant` and "Manuscript" preselects `manuscript` (each type's default layout comes from the document-type catalog, see `org-admin.md`); a document can override the default with `template:` in its front matter (see `editor.md`).
2. "What is it about?" — "Research question / purpose" (placeholder "What are you trying to establish, and in whom?"), the single most useful thing you provide: the Research Assistant searches from it.
3. "Deliverables & timeline" — a chip list ("Add a deliverable…") and a free-text "Timeline" (placeholder "e.g. Draft by 2026-08-01, submit by 2026-09-15").
4. "Add your materials" — "Drop files here or click to choose". Files upload into `seed_docs/`. The disclosure lists what helps for the chosen type, for example "Key papers you are building on or citing" and "Target journal + author guidelines" for a manuscript, "The funder RFA / PA / solicitation" and "Preliminary data and figures" for a grant, prior protocols and an SAP for an RWE protocol, precedent protocols and ICH/CONSORT/SPIRIT guidance for an RCT protocol, existing SOPs and ISO/GxP standards for an SOP.
5. "Review & launch" — a summary, a nudge if no materials were added, and the choice "Start research & skeleton now" or "Not yet". The primary button reads "Finish & launch" or "Finish" accordingly.

The footer offers "Skip for now" on the first step and "Save & close" afterwards — both keep a draft and launch nothing — plus "Back" and "Next".

**Prerequisites.** Editor role. Step 1 requires a title and step 2 a research question before "Next" works. A template that does not resolve is rejected with `unknown template "…"`.

**Gotchas.** The auto-open happens exactly once per project — it stamps a draft on that first open — so after "Skip for now" you re-enter from the project browser or the chat greeting. Finishing "Edit setup" later re-launches seeding if "Start research & skeleton now" is still selected.

## What seeding does

**What it does.** Seeding (`POST /api/projects/:id/seed`) is a fixed pipeline, not a conversation. Stage one runs the Research Assistant and the Advisor in parallel: the RA searches PubMed, arXiv and the web for the ten to twenty most relevant papers, adds them through the citation tools (which keep `draft/references.bib` in sync) and writes `research/literature-summary.md`; the Advisor summarizes each document in `seed_docs/` under `guidance/` and writes `guidance/index.md`. Stage two has the Writer read `project.json`, the bibliography and both summaries and write `draft/main.md` — a section skeleton with intent sentences, TODO markers and initial citations. The pipeline then writes `pm/status.md` recording each stage's outcome and where things live.

**How to use it.** Choose "Start research & skeleton now" on the wizard's last step. A "Seeding project" panel above the chat shows the rows "Build bibliography" and "Generate skeleton", and the top bar shows a "Seeding · 1/2"-style chip in place of the save indicator. The send button acts as Stop during the run (see `agents-and-chat.md`).

**Prerequisites.** A completed setup — otherwise the pipeline stops with `project is not configured yet — complete project setup first`. Editor role: viewers see "View only — seeding a project needs the editor role". Seeding spends real model quota; each stage has its own token budget.

**Gotchas.** Seeding writes files directly, bypassing the suggestion review later agent edits go through. A failed research branch is recorded in `pm/status.md` but does not stop the skeleton; a failed skeleton ends the pipeline with an error. Running seeding again overwrites `draft/main.md`.

## Project types

**What it does.** The type tunes the team: the wizard's material guidance, the default page layout, and the project description every agent task receives.

**How to use it.** Pick it in the "New project" form or change it in wizard step 1 ("Document type"). The Kuhn catalog ships Manuscript (`manuscript`), RWE protocol (`rwe-protocol`), RCT protocol (`rct-protocol`), Grant (`grant`) and SOP (`sop`); organization owners can add their own types, or replace a catalog type, in Org admin under "Document types" (see `org-admin.md`). Each type sets the layout the wizard preselects, the upload hints it shows, and a guidance section every agent receives for the project. The type shows as a pill on the card and in the breadcrumb.

**Prerequisites.** None.

**Gotchas.** The server rejects a type that is not in the organization's list with `projectType must be one of: …`. A type that was disabled later stays on the projects that already use it.

## Project configuration

**What it does.** The wizard's final save (`PUT /api/projects/:id/config`) stores `title`, `project_type`, `research_question`, `deliverables`, `timeline`, `source_materials`, optional `notes` and `template`, and writes the same fields to `project.json` at the workspace root for agents to read. Draft saves (`draft: true`) keep the answers server-side and write nothing to disk.

**How to use it.** Through the wizard. The default page layout alone can be changed with `PUT /api/projects/:id/template`; the last-open document is recorded with `PUT /api/projects/:id/active-document` whenever you open a file.

**Prerequisites.** Editor role. A final save is refused with `title is required` or `research question is required`.

**Gotchas.** `project.json` is generated — edit the configuration through the wizard, not the file, or the next save overwrites it.

## Switching projects and organizations

**What it does.** The breadcrumb reads organization / project / document. The project segment opens the project browser; the organization segment opens a menu of your organizations plus "Org library…" and "Org admin…" (owners) or "Org knowledge…" (other members).

**How to use it.** Click a card in the project browser. The last organization and project are remembered in this browser and restored on reload; the open document is stored per project on the server, so it reopens too. Switching organization lands on that organization's first project.

**Prerequisites.** None.

**Gotchas.** Projects of a suspended organization are hidden and a banner explains it (see `accounts.md`). Projects list oldest first.

## Project event feed

**What it does.** Each project has an always-on server-sent event stream (`GET /api/projects/:id/events`) carrying every top-level agent and job event — file changes (create, update, delete, moved, proposed), job start, text, questions, done and error, seeding stage markers, comment changes and review-link activity — whichever tab started the work. The app uses it to refresh the file tree and badges, update a clean open document in place, and toast review-link activity.

**How to use it.** Nothing to do; the app subscribes when a project opens and reconnects if the stream drops. `GET /api/projects/:id/files/activity` returns recent file events.

**Prerequisites.** Viewer role.

**Gotchas.** At most 20 concurrent subscribers per project (`PROJECT_EVENTS_MAX_SUBSCRIBERS`); beyond that the request fails with `too many event subscribers for this project`. An open document with unsaved edits is not replaced when an agent changes it — the status bar says "… was changed by an agent — reload to pick up the new version".

## Deleting a project

**What it does.** Deleting a project is not available yet: there is no delete control in the app and no delete route on the backend.

**How to use it.** Not applicable. You can delete a project's files from the file manager (see `files.md`); the project entry itself stays in the browser.

**Prerequisites.** None.

**Gotchas.** Project files live under the server's data directory in a folder named by project id; a rename never touches it.
