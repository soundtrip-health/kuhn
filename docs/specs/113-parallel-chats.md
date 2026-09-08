# Design: Manage multiple projects and chats in parallel (issue #113)

**Status:** design pass — proposed for review, then split into the issues in §7
**Issue:** [#113 — manage multiple projects and chats in parallel](https://github.com/soundtrip-health/kuhn/issues/113)
**Depends on:** [#118 durable jobs](118-durable-agent-jobs.md) stages 1–3 for indicators and
reconnection that survive reloads and restarts; builds on #136 (Stop), #137 (run tracker),
#134 (per-chat model pin), story 027 (detachable runs), story 005-001 (project event feed).

## 1. Goal

A user can have several agents working at once — across projects, and across agents within a
project — see at a glance which ones are running or waiting on them, and switch between them
without losing a run or a question. Parallel *runs* already exist server-side (every SSE
request is an independent run); what is missing is a **chat as a durable, addressable thing**
and a client that manages more than one.

## 2. Today's single-run assumptions

- `webapp/src/chat.ts` keeps one `running` flag, one `conversationAgent`, one event handler,
  and per-agent `sessions` / `continuations` / model pins **in memory, per tab**; `initChat`
  wipes them on a project switch. Switching projects mid-run drops the stream (the run
  continues server-side, unattached), and nothing tells the user it finished or asked
  something.
- The server has no notion of a chat: `conversations` rows are per *job*; the provider session
  id / continuation live on the job row and are handed back by the client with each message.
  Two tabs (or two devices) on the same project therefore fork the conversation.
- Live-run registration (`runs.js`) is per top-level job; `GET /pending` is per project;
  the project feed is per project. There is no per-user or per-org view of "what is running".

## 3. Concepts

**Chat** — one thread between a user and one agent in one project: `chats (id, project_id,
agent_slug, user_id, title, session_id, continuation, pinned_profile, status, current_job_id,
last_message_at)`. `status ∈ idle, running, waiting_for_user, paused` is a *projection* of
the current job's state (#118). The client's `sessions`, `continuations`, and model pins move
here — so a chat continues from any tab or device, and the "fresh start" hand-off (STH-55)
becomes a server-side reset of the chat row. `POST /api/agent/task` takes `chatId` (or
`projectId` + `agent`, creating the chat) and stamps `jobs.chat_id`.

**Pinning a chat to a project** falls out: a chat *is* project-scoped; the project selector
switches which chats are in view, not which conversation exists.

**Run** — a job tree (#118) belonging to a chat. A chat has at most one active run; a project
may have several (different agents / different users). Concurrency is bounded per user and per
org at claim time (#118 §4; T-21).

**Presence of work** — an **org-level lifecycle feed**: `GET /api/orgs/:id/activity` (SSE,
`subscribeOrgEvents` already exists) carrying compact `{ type: 'chat', chatId, projectId, agent,
status, jobId, question? }` records for the user's chats (and, for owners, every chat in the
org). It is fed from the job state transitions of #118, so it is right after a reload or a
restart, and it is what the indicators below render from.

## 4. UI

1. **Projects pop-over**: a small status mark per project — a ring while any of the user's
   chats there is running, a filled dot when one is waiting on them, nothing when idle — from
   the activity feed. Unobtrusive; no counts.
2. **Chat header / agent pill**: the agent pill shows the same mark per agent in the current
   project; the model pill (#134) reads the chat's pinned profile.
3. **Waiting-on-you indicator**: a persistent but quiet marker in the top bar (next to the
   save indicator) whenever any chat of the user is `waiting_for_user`, clicking it jumps to
   that chat; the document title gains a "●" prefix so a background tab shows it. Optional
   browser notification behind a per-user setting (off by default).
4. **Switching projects mid-run keeps the run**: the client keeps one stream handle per active
   chat (a small `ChatRuns` registry replacing `running`/`conversationAgent`) and re-attaches on
   return by cursor (#118 §6); the transcript for the chat you left keeps accumulating
   server-side and renders on return from `conversations` + `job_events`.
5. **Stop** (#136) and the status bar (#137) become per-chat: the status bar follows the chat in
   view; other chats' activity is only in the marks above.

## 5. Global (project-less) admin chat — deferred

The issue floats an admin chat not tied to a project for managing the org. It needs a
different tool set (org-scoped: list projects and members, budgets, routes; no file tools), a
different agent prompt, and a different tenancy path (org role, not project role). None of that
is shared with the work above, so it is **out of this design**; it becomes its own issue once
the org-admin tool surface is designed.

## 6. Security and limits

- A chat is readable by its user and by project editors of the same org; the activity feed
  shows other users' chats only to owners (status and agent, never content).
- Per-user and per-org concurrent-run caps (#118 §4) are the spend control the threat model
  asks for (T-21); the UI shows "N of M runs in use" only when the cap is hit.
- Everything is per org; nothing in the feed crosses tenants (the org hub is already scoped).

## 7. Implementation split (drafted issues)

1. **Chats as durable server-side threads** — `chats` table + migration; `jobs.chat_id`;
   session/continuation/pinned profile move from the client to the chat row; `POST /task` by
   chat; fresh-start becomes a chat reset; `GET /api/projects/:id/chats`. Client reads its
   per-agent state from the chat instead of memory. *(No visible change except that two tabs no
   longer fork a conversation.)*
2. **Client run registry** — one stream per active chat; project switch keeps runs alive;
   re-attach by cursor on return (needs #118 stage 3); Stop and status bar per chat in view.
3. **Org activity feed and status marks** — `GET /api/orgs/:id/activity` from job transitions
   (needs #118 stage 1 states); marks in the projects pop-over and the agent pill.
4. **Waiting-on-you indicator** — top-bar marker, document-title badge, jump-to-chat; optional
   browser notification (setting).
5. **Concurrency caps** — per-user / per-org concurrent runs at claim time with a clear refusal
   message (`AGENT_MAX_CONCURRENT_RUNS_PER_USER`, `…_PER_ORG`); shown in the UI only when hit.
6. **Admin global chat** — design (§5); not scheduled here.

Order: 1 → 3 → 4 can proceed after #118 stage 1; 2 needs #118 stage 3; 5 needs #118 stage 4.
