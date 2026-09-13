---
title: Organization admin
area: org-admin
keywords: organization, org admin, members, roles, viewer, editor, owner, invite, invitation, suspended, settings, budgets, token budget, models, model profiles, routing, difficulty, credentials, promotions, knowledge, knowledge library, org library, scripts, run_script, secrets, themes, slide themes, templates, page layout, agent prompts, prompt additions, document types
---

# Organization admin

Every project belongs to an organization, and every member of that organization holds one
role: `viewer` < `editor` < `owner`. Viewers read; editors change projects, files and shared
org content; owners administer the organization. The "Organization admin" overlay is where
owners do that. Open the organization menu in the breadcrumb (the org name at the top left)
and choose "Org admin…". Owners see eleven tabs, in this order: Members, Settings, Budgets,
Models, Promotions, Knowledge, Scripts, Secrets, Themes, Templates, Agents. Non-owner
members open the same overlay through "Org knowledge…" in that menu and see a read-only
subset: Knowledge, Scripts, Secrets, Themes, Templates, Agents (Secrets is editable by
editors). Escape or "Close" dismisses the overlay; if your role is lowered while it is
open, owner-only tabs disappear. Sign-in, switching between organizations and the
platform super-admin console are covered in `accounts.md`.

## Members

**What it does.** Lists the organization's members with their role, lets an owner change a
role or remove a member, and issues invitations, which are the only way into an
organization outside dev mode.

**How to use it.** The table has columns "Member" and "Role". Change a role with the
select in the row (`viewer`, `editor`, `owner`); it saves immediately. "Remove" asks
"Remove <name> from <org>?" and removes the membership. Under "Invite someone", enter an
address (placeholder `colleague@example.org`), pick a role (prefilled from the Settings
tab's "Default member role") and press "Send invitation"; the invitee gets a sign-in link
by email. Invitations appear under "Invitations" with columns "Invited", "Role", "State"
(`pending`, `accepted`, `revoked`, `expired`) and "Expires"; "Revoke" cancels a pending one.

**Prerequisites.** Owner role. Invitation email needs `KUHN_SMTP_URL` on the server;
without it the link is printed to the backend console.

**Gotchas.** An organization must keep at least one owner: demoting or removing the last
one is refused inline and the select reverts. Inviting an existing member is refused
("already a member of this organization"). Invitations expire after 7 days
(`KUHN_INVITE_TTL_MS`). Suspension is not done here: it is a platform action in the
super-admin console ("Suspend" / "Reactivate"), and a suspended organization refuses every
member everywhere with "organization suspended".

## Settings

**What it does.** The organization's name and the knobs that shape how members join,
how library promotions are handled, and the default token budgets.

**How to use it.** "Organization name" plus "Rename" changes the display name; the line
"Workspace id: <slug> (immutable)" shows the slug, which never changes. "Default member
role" (`viewer` or `editor`) prefills the invitation form. "Offer library seeding" controls
whether the organization set-up flow offers the knowledge-seeding step. "Library promotions"
chooses between "Approval required — owners review suggestions" (the default: an editor's
promotion becomes a request on the Promotions or Scripts tab) and "Direct — editors promote
immediately". Under "Token budgets", "Per-user budget" and "Per-project budget" are
cost-weighted token counts per period (0 = unlimited), and "Budget period" is "Daily (UTC)",
"Weekly (Monday, UTC)" or "Monthly (UTC)". Each control saves on change; a rejected value
shows its error under the control.

**Prerequisites.** Owner role.

**Gotchas.** Owners always promote directly regardless of the promotion policy. Budget
figures are weighted by model cost (an Opus token counts 1, cheaper models less), so a
budget approximates spend, not raw tokens.

## Budgets

**What it does.** Shows what each member and each project has spent in the current
period against its effective limit, lets an owner override the org default for one row,
and resets a row's usage early.

**How to use it.** The intro line states the current period window and the org defaults.
Two tables, "Members" and "Projects", each with "Used this period" (a meter plus
`used / limit · %`, or `used · unlimited`), an "Override" input (placeholder "org default";
enter 0 for unlimited, clear it to fall back to the default) and "Reset usage", which
counts that row's usage from now on. Org defaults and the period are changed on the
Settings tab.

**Prerequisites.** Owner role.

**Gotchas.** A run that crosses a budget is paused, not killed: the chat shows a card
("Token budget reached — task paused", or "Your <period> token budget is used up — task
paused" / "This project's …") with a hand-off note and a "Resume <agent>" button. A
per-task pause (default 2,500,000 root-tier tokens, `AGENT_TOKEN_BUDGET`) resumes with a
fresh budget; a user or project pause resumes only after "Reset usage", a higher limit, or
the next period. If a budget is already used up when a message is sent, no run starts and
the card says when it resets. See `agents-and-chat.md` for the chat side.

## Models

**What it does.** Chooses which model each agent runs on and with whose credential.
A model profile names a provider, a model id, the endpoint the organization's content is
sent to, declared limits, a cost weight and a credential kept as an org secret. Routing
gives each agent a ranked list of profiles by task difficulty.

**How to use it.** Under "Provider credentials", pick a provider, keep the suggested
secret name (for example `openai-api-key` or `gemini-api-key`), paste the key into "API
key (stored write-only)" and press "Save credential". Under "Model profiles", deployment
profiles are listed read-only ("deployment") and org profiles have "Test", "Edit" and
"Delete"; "Add profile" opens the "New profile" form with "Provider" (Anthropic, OpenAI,
OpenRouter, Google Gemini, OpenAI-compatible endpoint), "Model id", "Slug", "Name", "Base
URL" (OpenAI-compatible only), "Credential", "Cost weight", "Model limits" (keep "Use the
provider's published values" or untick to pin "Context window", "Max output", "Reasoning
model (extended thinking)" and "Supports tool calls (required for every Kuhn agent)"),
"Data policy" and "Enabled (routes may use this profile)"; finish with "Create profile" or
"Save changes". Under "Routing", each agent has rows of a profile plus "up to difficulty"
(0 = routine, 1 = hardest) with "Add row", "Remove", "Save", "Discard" and "Revert to
default". A task runs on the first row whose difficulty covers it, else the last; no rows
means the deployment default.

**Prerequisites.** Owner role. A fixed-endpoint provider needs a saved credential first.
An OpenAI-compatible profile on a private or loopback host needs
`KUHN_ALLOW_PRIVATE_MODEL_ENDPOINTS=true` on the server (on by default only in dev auth
mode); public hosts must use `https`.

**Gotchas.** Saving routes that send an agent's content to a new host asks "Saving sends
<agent> content to a new destination: …. Continue?" first. General web search works only on
the Anthropic provider; other routes show a warning. "Test" sends one synthetic turn with no
project content and times out after 30 s. Slugs starting with `deployment-` are reserved,
and deleting a profile drops the routes naming it. Models an operator predeclares with
`KUHN_PLATFORM_MODELS` appear as deployment profiles and, when the entry declares
`routes`, as an agent's "Platform default".

## Promotions

**What it does.** The owner's review queue for files that editors asked to add to the
organization's knowledge library under the "Approval required" policy.

**How to use it.** An editor promotes a project file with the file manager row action
"Add to org library (L)"; under the approval policy the toast reads "Suggested — awaiting
admin approval" and the request lands here (the tab shows a pending count). Each row shows
the path, project, suggester, date and note; "Preview" renders markdown and text inline or
offers "Download to preview" for binaries. "Approve" or "Reject" asks for an optional
note; approval copies the file into the org library and ingests it, after which agents can
search it.

**Prerequisites.** Owner role; the promoting user needs editor role in the project.

**Gotchas.** Nothing is copied until approval, so a rejected file never reaches the
library. Approving a file that was deleted meanwhile fails inline. Script promotions are
reviewed on the Scripts tab, not here.

## Knowledge

**What it does.** The Kuhn knowledge catalog (`guidance-docs/catalog.json`): curated
packages of reporting standards, regulatory guidance and style references such as "General
scientific writing", "Biosciences" with the sub-packages "Clinical trials", "Regulatory
(FDA/ICH/EMA)" and "Drug development", "Machine learning" and "Statistics & reproducible
methods". Enabling an item imports it into the organization's library, where the same
search serves it to agents alongside your own uploads.

**How to use it.** Tick a package's checkbox to enable all of its available items, or
expand it and tick items one by one; each item shows a kind badge ("doc" for a vendored
document, "card" for a Kuhn-authored summary linking to the source), its licence and a
"Source" link. Enabled items show "Importing…", "Processing…", "Searchable" or "Failed —
<reason>"; "Re-import" appears for failed items and for items with an "Update available"
pill after a catalog bump. Your own documents go in through "Org library…" in the
organization menu: drop files on "Add documents" (PDF · DOCX · MD · TXT · HTML) and they
move from "Queued…" to searchable. Agents search the library with `search_org_knowledge`,
granted to the Domain Expert (Advisor), Research Assistant, Critical Reviewer and Writer.

**Prerequisites.** Any member can view; enabling, disabling and re-importing need owner
role. Uploading to the org library needs editor; removing a document needs owner. PDF
ingestion runs in the `minidocks/poppler:latest` image.

**Gotchas.** "Unavailable in this deployment" means the item's content was not shipped
with this install. A catalog update waits for "Re-import"; nothing re-imports on its own.
PDFs over 200 pages (`INGEST_MAX_PDF_PAGES`) fail ingestion. A catalog-imported document
cannot be removed from the Org library panel ("Managed in the org admin Knowledge tab");
disable it here instead. The library is per-organization: uploads never enter the catalog.

## Scripts

**What it does.** The organization's shared, versioned script library for the Analyst's
`run_script` tool: known-good Kuhn scripts from `shared-scripts/catalog.json` ("Summarize
CSV", "GAMM smooth trends", both R) plus scripts promoted from projects.

**How to use it.** Under "Kuhn catalog", "Add to library" imports a catalog script. Under
"Library", each script shows its slug, language, version and chips such as "disabled" or
"update available"; "View code" shows the source and version history, "Update from
catalog" pulls a newer catalog version, and "Disable" / "Enable" controls whether the
Analyst can run it. Editors promote a project `.R` or `.py` file with the file manager row
action "Promote to org scripts (S)"; under the approval policy it appears under "Pending
script promotions (n)", where "Review code" shows the source (a diff for an update), a
slug can be chosen, and "Approve" or "Reject" decides. The Analyst lists scripts with
`list_scripts` and runs one by slug (or a project file by path) with `run_script`.

**Prerequisites.** Any member can view; every write is owner-only. Runs need the built
`kuhn/r-analysis:latest` image (`docker build -t kuhn/r-analysis:latest docker/r-analysis`).

**Gotchas.** The sandbox has no network, so adding an R package means extending that
Dockerfile and rebuilding. Runs default to 300 s, 2 CPUs, 2 GB, 50 output files and 2
concurrent runs (`SCRIPT_*` variables); scripts are capped at 256 KB. Approving a
promotion is refused if the project file changed after you reviewed it.

## Secrets

**What it does.** Named credentials agents use server-side: a database DSN the Analyst's
sandboxed scripts connect with, an `ncbi-api-key` for higher PubMed rate limits, or a
provider API key referenced by a model profile. Values are write-only: they can be
replaced or deleted, never viewed, and they are never shown to agents or models.

**How to use it.** Under "Add or replace a secret", enter a name (placeholder "name (e.g.
nsduh-db)": lowercase letters, digits and dashes, starting with a letter, up to 64
characters), the value ("value (stored write-only)") and an optional description, then
"Save". Saving an existing name asks "Replace the value of "<name>"?" and rotates it;
"Delete" warns that agent runs referencing it will fail. The Analyst discovers names with
`list_secrets` and passes them in `run_script`'s `secrets`; each becomes a
`KUHN_SECRET_<NAME>` environment variable in that run (dashes become underscores) and the
run joins the internal Docker network instead of having none.

**Prerequisites.** Any member can list names; creating, replacing and deleting need
editor role. Secret-enabled runs need the internal Docker network `kuhn-data` (`docker
network create --internal kuhn-data`). Production should set `KUHN_SECRETS_KEY` (64 hex
characters); otherwise the key derives from the session secret.

**Gotchas.** Values are capped at 8 KB. Credentials saved on the Models tab are ordinary
secrets and appear here too.

## Themes

**What it does.** Marp slide themes for decks. Kuhn ships "Kuhn" (`kuhn`) and "Kuhn
Dark" (`kuhn-dark`); an organization can upload its own CSS.

**How to use it.** "Kuhn themes" lists the catalog; "Organization themes" lists uploads
with "Disable" / "Enable". Under "Upload a theme", pick a `.css` file, optionally give a
"Display title (optional)", and press "Upload theme". A deck selects a theme with `theme:
<name>` in its front matter, where the name comes from the file's `/* @theme <name> */`
header. Rendering decks is described in `preview-export.md`.

**Prerequisites.** Any member can view; upload and enable/disable need owner role.
Rendering needs the `kuhn/marp:latest` image.

**Gotchas.** The CSS must contain a `/* @theme <name> */` comment, the name must not be a
Marp built-in (`default`, `gaia`, `uncover`), and the file is capped at 256 KB. Uploading
an existing name replaces it. An active org theme shadows a Kuhn theme of the same name;
disabling it brings the Kuhn theme back. There is no delete, only disable.

## Templates

**What it does.** Typst page-layout templates: paper, margins, font and spacing for PDF
renders, optionally paired with a Word reference `.docx` so Word exports match. Kuhn ships
"Pandoc default" (`default`), "NIH grant attachment" (`nih-grant`) and "Journal
manuscript" (`manuscript`); the last two carry a Word reference.

**How to use it.** "Kuhn templates" lists the catalog, noting "Word reference for docx
export" or "PDF only (docx exports use Pandoc's stock styles)". "Organization templates"
lists uploads with "Disable" / "Enable" and "Attach Word reference" (later "Replace Word
reference" and "Remove Word reference"). Under "Upload a template", pick a `.typ` file that
defines `conf` (start from a Kuhn template in `typst-templates/`), optionally a "Display
title (optional)", and press "Upload template". A document selects a template with
`template: <name>` front matter; documents without one use the project default, chosen in
the setup wizard's "Page layout" select or set with `PUT /api/projects/:id/template`
(editor role; the name must exist). See `editor.md` for the key and `preview-export.md`
for renders and Word exports.

**Prerequisites.** Any member can view; upload, enable/disable and Word-reference changes
need owner role. Faithful fonts need the built `kuhn/typst:latest` image.

**Gotchas.** The source must contain a `// @template <name>` line and `#let conf(`;
templates are capped at 256 KB and Word references at 4 MB and must be real `.docx` files.
Re-uploading a name replaces it, and an active org template shadows a Kuhn template of the
same name. A document naming a template that does not resolve fails to render.

## Agents

**What it does.** Shows each agent's built-in system prompt and lets owners append an
organization-wide addition to it: guardrails such as data-access rules that apply to
every project in the organization.

**How to use it.** Each card shows the agent, its model and description, "View base
prompt" / "Hide base prompt", and "Organization addition". Owners type into the textarea
(placeholder "Org-wide instructions appended to this agent's prompt — e.g. data-access
guardrails.") and press "Save"; "Clear" removes the addition. A counter shows the length
against the limit, and the card records who last updated it and when. Members see
additions read-only.

**Prerequisites.** Any member can view; saving needs owner role. Changing the base prompt
itself is a code change (`agent-backend/src/db/prompts/<slug>.md` plus `npm run db:seed`).

**Gotchas.** Additions are capped at 4,000 characters. They land in a section headed
"Organization guardrails (set by your organization)" after the base prompt and are read
once per task, so a change applies from the next message and also reaches sub-agents the
task dispatches. There is no per-project override.

## Document types

Today the document type of a project (`manuscript`, `grant`, `rwe-protocol`,
`rct-protocol`, `sop`) is chosen from a fixed list in the setup wizard's "Document type"
select (see `projects.md`); the list cannot be changed from the admin overlay. A
"Document types" tab that lets owners add their organization's own types is being added
and is not available yet.
