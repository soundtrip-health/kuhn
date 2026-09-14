---
title: Agents and chat
area: agents
keywords: agents, chat, PM, writer, research assistant, advisor, reviewer, analyst, help, agent selector, model, pin, difficulty, stop, question, reconnect, budget, resume, context, fresh start, hand-off, sub-agent, dispatch, slash commands
---

# Agents and chat

The chat panel on the left is where you direct Kuhn's agents. Each agent has its own role, tools and conversation; you pick one, type, and its reply streams in. Directing agents needs the editor role — viewers see the transcript with the composer disabled ("View only — directing agents needs the editor role"). Agents run on real model quota.

## Project Manager (pm)

**What it does.** The coordinator, shown as "PM" and selected by default. It reads `project.json`, keeps `pm/status.md`, asks you clarifying questions, and delegates work to the other agents rather than doing it itself. Default model: `claude-opus-4-8`.

**How to use it.** Ask for anything that spans agents: "What should we do next?", "Get the RA to find sources for the introduction, then have the Writer draft it", "Triage the open comments". It answers with short, decision-oriented replies. Tools: read, search and list project files, move files, `ask_user`, `dispatch_agent`, `save_project_config`, comments (`add_comment`, `list_comments`, `reply_comment`, `resolve_comment`), `list_slide_themes`, `list_typst_templates`.

**Prerequisites.** The editor role.

**Gotchas.** The PM cannot write project files itself; it dispatches the Writer, and it is told never to relay whole documents through chat. It grades each dispatch with a difficulty that steers model routing (see "Models and pins").

## Writer (writer)

**What it does.** The only agent meant to edit `draft/main.md` and the other deliverables under `draft/`; it also keeps `draft/claims.md`, a self-audit of every cited claim. Default model: `claude-opus-4-8`.

**How to use it.** Select "Writer" and ask for a draft or a revision of the open document ("tighten the Methods", "draft the Specific Aims from the notes in seed_docs/"). Its edits under `draft/` arrive as suggestions you accept or reject in the editor (see `editor.md`). Tools: read, search, list, write and edit files, `add_citation` (PubMed), `search_org_knowledge`, `dispatch_agent`, `list_comments`, `reply_comment`, `resolve_comment`, `list_slide_themes`, `list_typst_templates`.

**Prerequisites.** The editor role.

**Gotchas.** The Writer does not file new margin comments; it answers and resolves them. It cannot search the literature itself — it dispatches the Research Assistant.

## Research Assistant (ra)

**What it does.** Literature search and bibliography maintenance, shown as "Research". Default model: `claude-haiku-4-5`, the cheapest tier, for high-volume searching.

**How to use it.** "Find recent trials of X and add them", "verify the references", "add DOI …". Tools: `pubmed_search`, `arxiv_search`, web search (Anthropic models only), `search_org_knowledge`, `add_citation`, `add_reference`, `update_reference`, `remove_reference`, `verify_references`, plus file read, search, list, write and edit. Details in `citations.md`.

**Prerequisites.** The editor role; network access from the backend.

**Gotchas.** It finds and organizes; it does not interpret or decide which sources belong — that is the Advisor's or PM's call.

## Advisor (advisor)

**What it does.** The domain expert ("Domain Expert (Advisor)"): it maintains the project's `guidance/` knowledge base and answers domain, regulatory and style questions with sourced references. Default model: `claude-sonnet-4-6`.

**How to use it.** Select "Advisor" and ask a focused question ("what does ICH E9(R1) require of an estimand statement?"). Tools: `search_org_knowledge`, web search (Anthropic models only), and file read, search, list, write and edit.

**Prerequisites.** The editor role.

**Gotchas.** It searches the organization's knowledge library first; if the library is empty it says so and moves on.

## Reviewer (reviewer)

**What it does.** The "Critical Reviewer": adversarial review of drafts for rigor, consistency and compliance. It files text-anchored findings as margin comments with a severity prefix and writes holistic reports under `review/reports/`. Default model: `claude-sonnet-4-6`.

**How to use it.** Select "Reviewer" with the document open: "review this document", "re-review the Methods". Tools: `add_comment`, `list_comments`, `reply_comment`, `resolve_comment`, `verify_references`, `search_org_knowledge`, file read, search, list, write and edit. See `comments.md`.

**Prerequisites.** The editor role.

**Gotchas.** It does not rewrite text; ask the Writer to act on its findings.

## Analyst (analyst)

**What it does.** Data analysis: tables in `draft/tables/`, figures in `draft/figures/`, code under `analyst/`, run in a sandbox. Default model: `claude-sonnet-4-6`.

**How to use it.** Select "Analyst": "run the cohort summary script", "make a table of baseline characteristics from data/cohort.csv". Tools: `list_scripts`, `list_secrets`, `run_script`, plus file read, search, list, write and edit.

**Prerequisites.** The editor role. `run_script` needs the `kuhn/r-analysis` Docker image; the sandbox is R-only with no network.

**Gotchas.** Missing R packages cannot be installed at run time — they must be added to the image by the operators.

## Kuhn Help (help)

**What it does.** Answers questions about Kuhn itself — where a button is, what a setting does, why something did not appear — from this feature guide, and cites the page and section it used ("Source: …"). Default model: `claude-haiku-4-5`. Its only tool is `search_kuhn_guide`; it reads no project or organization data.

**How to use it.** Open the "?" menu ("Help") and choose "Ask about Kuhn", which selects the Help agent and focuses the chat box, or pick "Help" in the agent selector. Type a plain question.

**Prerequisites.** The editor role to send a message. The backend indexes `docs/features/` at startup.

**Gotchas.** It does not write, review or research your documents; for questions about your own project it points you to the PM. When the guide has no entry it says so rather than guessing.

## The chat panel

**What it does.** One transcript per project, tagged by agent; each agent keeps its own conversation context. That context is a server-side chat per agent, project and user, so the same conversation continues from another tab or device instead of forking. Transcripts are restored on reload ("session restored").

**How to use it.** Toggle the panel with "Chat" in the top bar. Type in the box ("Ask an agent, or describe an edit…") and press Enter or the send button ("Send (Enter)"); Shift+Enter inserts a newline. The message goes to the agent shown in the pill at the bottom-left of the composer ("Choose which agent to address"). The bar above the log says "Showing PM only" (or the current agent); its button "All agents" shows the full tagged history, and "PM only" switches back. The choice persists across reloads. Your open document, selection and cursor are sent with every message, so "this document" means the one in the editor.

**Prerequisites.** The editor role to send.

**Gotchas.** Agents do not share chat context: something you told the PM is unknown to the Writer unless the PM dispatched it. Scrolling up parks auto-scroll; a "New messages" pill appears and returns you to the bottom.

## Models and pins

**What it does.** Which model runs an agent is decided at dispatch time from the organization's route for that agent — a ranked list of model profiles, each trusted up to a task difficulty from 0 to 1. Sub-tasks the PM dispatches carry a difficulty; no difficulty means the strongest model. Without a route, the agent's default model above applies.

**How to use it.** When an agent has more than one routed model, a model pill appears beside the agent pill ("Pick which model powers this agent"). Its menu offers "Route default" plus each profile; picking one pins it for that agent in this project; the pin is stored on your chat with that agent on the server, so it follows you to other tabs and devices. The status bar shows the model of the job that is running, e.g. "PM · opus-4-8 · d=1", with a tooltip listing "Models this run:". Owners configure profiles and routes (see `org-admin.md`).

**Prerequisites.** Pinning needs at least two routed models for the agent.

**Gotchas.** As the menu says: "Applies to the agent you are addressing, for this project. Sub-agents it dispatches are routed by task difficulty." If an owner later removes a pinned model from the route, the next message fails once with a route error and the pin is dropped.

## Stopping a run

**What it does.** Interrupts the running agent and every sub-agent it dispatched. The conversation is kept, so your next message continues from where it stopped.

**How to use it.** While a run is in flight the send button becomes a stop button ("Stop the agent (Esc)"); click it or press Esc in the chat box. It reads "Stopping…" until the run ends, then the log says "PM stopped. Say what to do next to continue from here, or start a fresh conversation." A question card offers "Or stop the agent".

**Prerequisites.** The editor role.

**Gotchas.** Files an agent already wrote stay written. Stopping a seeding pipeline aborts the stream rather than a single job.

## Runs that stop on their own

**What it does.** A run also stops without a Stop click in three cases. Each is honoured at the run's next *control point* — before a provider turn, before any tool that changes something (a file write, a citation, a comment), or when an answered question wakes it — so a run never carries on past the point where it should not.

- **Access revoked.** When a super-admin suspends the organization, or an owner removes you from it, every run you have in flight is stopped. The chat shows "This run was stopped because access to the project was revoked." — the same line in every case.
- **Time limit.** A run (the agent you addressed plus everything it dispatched) has a wall-clock limit, 2 hours by default (`AGENT_RUN_MAX_MS` on the backend). Past it the run is paused with a hand-off note, like a budget pause: "This run reached its 2-hour time limit and was paused. Your work is saved; say what to do next to continue from here."
- **Stop from anywhere.** A Stop is recorded on the job before the run is interrupted, so a sub-agent that was still starting stops too.

**How to use it.** Nothing to do: send your next message to continue. After a time limit the conversation resumes where it stopped.

**Prerequisites.** None.

**Gotchas.** The job's stored `cancel_reason` (`user`, `suspended`, `removed`, `deadline`) is visible in the job trace (`GET /api/agent/jobs/:id/trace`) for audit. An org's own token budgets still apply on top of the time limit.

## Questions from agents

**What it does.** An agent (the PM has the `ask_user` tool) can pause to ask you something. A question card appears — "PM needs a decision" — with the text "Type your answer in the chat box below — take your time."

**How to use it.** The chat box switches to answer mode ("Type your answer…"); type and press Enter. The card flips to "Decision recorded · PM" with "You answered: …" and the agent continues on the same run. By default a question waits indefinitely (`AGENT_QUESTION_TIMEOUT_MS` unset).

**Prerequisites.** The editor role.

**Gotchas.** Reloading or closing the tab does not cancel the question — see the next section. If the run ended before you answered, the card shows "No longer active · PM" and a late reply is refused ("that question is no longer waiting for an answer …").

## Reconnecting after a reload

**What it does.** A run parked on a question survives a browser reload or disconnect. On load the app asks the backend for pending questions in the project and re-attaches to the run, re-showing the question card ("PM is waiting for your answer…").

**How to use it.** Nothing; it happens on load.

**Prerequisites.** The backend process that started the run must still be running.

**Gotchas.** Pending runs live in the backend's memory: a backend restart forgets them, and the question is gone. Only runs waiting on a question are reconnectable; a finished run's text is restored from history.

## Budget pause and resume

**What it does.** Every top-level run has a token budget (default 2.5M cost-weighted tokens, `AGENT_TOKEN_BUDGET`, with a 10% grace), shared with its sub-agents; organizations can also cap each member and project per day, week or month. Reaching the per-task budget pauses the run: Kuhn writes a hand-off note from the conversation and shows a card, "Token budget reached — task paused", with the note and a "Resume PM" button. The status bar tracks usage as "budget 480k/2.5M · 19%".

**How to use it.** Press "Resume PM" to start a new run with a fresh budget that receives the note and continues the same conversation; or send your own instruction instead. The card survives a reload.

**Prerequisites.** The editor role. For an organization budget ("Your daily token budget is used up — task paused"), wait for the reset or ask an owner (Organization → Budgets).

**Gotchas.** "Nothing is lost" — files already written are saved. If the organization budget is already used up when you send, nothing starts ("The task was not started") and there is nothing to resume.

## Context meter and fresh start

**What it does.** The meter at the bottom of the composer shows how much context the selected agent carries into its next reply, e.g. "120k / 200k". Past 100k tokens a card says "This conversation is getting long" and offers "Start fresh conversation". A fresh start drops the agent's conversation context; your files and drafts are untouched.

**How to use it.** Click the refresh-style button beside the send button ("Start a fresh conversation with the selected agent (clears its chat context)") and confirm, or use the card's button. A divider marks the break ("fresh conversation with PM — earlier chat context cleared"). The reset happens on the server: the chat's context is cleared and Kuhn scans the recent chat for open action items; if it finds any, the note is parked on the chat and a card "Hand-off note — goes out with your next message to PM" shows it. The note is prepended to your next message to that agent from any tab. "Discard note" drops it. On the long-conversation card, untick "Carry a short hand-off note (open action items) into the fresh conversation" to skip the scan.

**Prerequisites.** The agent must be idle ("PM is still working — wait for the task to finish before clearing").

**Gotchas.** The transcript stays on screen; only the agent's memory resets. "no open hand-off found — starting clean" is a normal outcome. A message sent while the reset is still running waits for it, so it cannot resume the old conversation by accident.

## Sub-agents and dispatch

**What it does.** The PM and Writer can dispatch another agent for a focused task (`dispatch_agent`). The sub-agent's output streams into the same chat under its own name, and its result returns to the dispatcher. Sub-agents inherit your open document and are stopped with their parent.

**How to use it.** Ask the PM for work that needs several agents; it dispatches and relays results. Nesting is limited to `AGENT_MAX_DISPATCH_DEPTH` (default 2): the agent you address is depth 0, and an agent at the limit cannot dispatch further.

**Prerequisites.** None beyond the editor role.

**Gotchas.** Sub-agent conversations are not resumable from the chat and do not count on the context meter.

## Run activity in the status bar

**What it does.** The bottom bar follows the innermost running job: "Research is working…" while a dispatched RA runs, then back to the PM. Beside it: the model chip (previous section), the budget, and the token total for the session ("12,345 tokens").

**How to use it.** Read only. The top bar shows "Saving…"/"Saved" and, during seeding, "Seeding · 2/3".

**Prerequisites.** None.

## Slash commands

**What it does.** Typing `/` at the start of a line opens the editor's block menu; the agent commands sit there next to headings, lists and "Page break". The "?" menu lists the same commands.

**How to use it.** Type `/` and the name, or pick it from the menu. Only `/cite` and `/write` act today; the rest show the toast "Routed to <agent>" and do nothing further — ask that agent in the chat instead.

| Command | Agent | Description | Status |
|---|---|---|---|
| `/cite` | Research | Search PubMed & insert a citation | Implemented — opens the cite picker (see `citations.md`) |
| `/write` | Writer | Writer drafts text right here | Implemented — asks "What should the writer draft?" and streams a suggestion block with "Accept", "Reject", "Retry" and "Dismiss" |
| `/research` | Research | Ask Research a question | Routes only (toast) |
| `/figure` | Analyst | Analyst makes a figure or table | Routes only (toast) |
| `/review` | Reviewer | Reviewer critiques this section | Routes only (toast) |
| `/ask` | PM | Ask any agent inline | Routes only (toast) |
| `/status` | PM | What is the team doing? | Routes only (toast) |

**Prerequisites.** The editor role; slash commands are disabled in read-only documents.

**Gotchas.** `/write` runs the Writer in compose mode: it returns text only and cannot write files, add citations or file comments during that call.
