---
title: Margin comments
area: comments
keywords: comments, margin comments, thread, reply, resolve, reopen, orphaned, anchor, quote, reviewer, external reviewer, add_comment, list_comments
---

# Margin comments

Margin comments are threads anchored to a passage of a document. People and agents file them, the panel beside the editor lists them in document order, and a thread is resolved once addressed. They are the channel through which review feedback reaches the text, and agents can read, answer and close them.

## Filing a comment on a selection

**What it does.** Attaches a new thread to the text you select. The selection becomes the thread's anchor quote and is highlighted in the document.

**How to use it.** Select text in the rich editor and choose "Comment" in the selection toolbar. The comments panel opens with the quote shown above a box with the placeholder "Comment on the selected text…"; type and press "Comment" (or "Cancel"). The toast "Comment added" confirms it. The "Comments" button in the document header opens and closes the panel and carries the open count, e.g. "Comments (3)"; the panel's empty state says "No comments yet. Select text in the document to comment on it."

**Prerequisites.** The editor role in the project. The document must be open in rich-text mode: the "Source" view only marks commented lines in its gutter ("This line has margin comments (switch to rich text to read them)").

**Gotchas.** Both the selection and the comment text must be non-empty. The panel shows only the open document's threads; the Files panel badges each file with its number of unresolved threads.

## Threads, replies and navigation

**What it does.** A thread is a root comment plus replies, shown as a card with author, time, the quoted anchor (truncated to 120 characters) and the bodies. Open threads are ordered by position in the document; resolved ones are collapsed under "Resolved (N)".

**How to use it.** Click a highlighted range in the document to open the panel on its thread; click a card to scroll the document to its text. "Reply" opens a box with the placeholder "Reply…" and a "Reply" button (toast "Reply added"). "Delete" removes a comment you authored after the confirmation "Delete this comment and its N replies? This cannot be undone." (toast "Comment deleted").

**Prerequisites.** The editor role to reply or delete.

**Gotchas.** You can delete only your own comments, plus comments left by external reviewers; deleting a root removes its replies. Replies always attach to the root — there is no nesting. Author names come from members' display names; agent authors show the agent's name (e.g. "Reviewer"), external reviewers show as "Name · external reviewer".

## Resolving and reopening

**What it does.** Resolving marks a thread as addressed: its highlight leaves the margin and the card moves into "Resolved (N)". Reopening brings it back.

**How to use it.** "Resolve" on an open card (toast "Thread resolved"); "Reopen" on a resolved card (toast "Thread reopened"). Any editor can resolve or reopen any thread; who resolved it is recorded.

**Prerequisites.** The editor role.

**Gotchas.** Resolving deletes nothing and does not touch the document. When an agent resolves a thread it first posts a closing note as a reply, so the resolution is traceable.

## Who can comment

**What it does.** Comment permissions follow project roles. Members with the editor role (or above) create, reply, resolve, reopen and delete; members with the viewer role read threads only (their panel says "No comments on this document yet." and offers no composer). External reviewers invited through a review link act according to the link's mode.

**How to use it.** Organization owners assign roles (see `org-admin.md`). For people outside the organization, "Share" in the document header creates a review link: a "comment" or "edit" link lets them file, reply, resolve, reopen and delete their own comments; a "view" link is read-only.

**Prerequisites.** Membership in the project's organization, or a review link.

**Gotchas.** Reviewers on comment-only links cannot update anchors; a member's open tab does that maintenance for them.

## Agent comments

**What it does.** Agents file margin comments through an `add_comment` tool that quotes the target passage verbatim; the thread appears in the panel attributed to the agent, in its role colour. In agents' own listings, agent authors are written as "reviewer (agent)" and external reviewers as "Name (external reviewer)".

**How to use it.** Ask the Reviewer to review a document: its prompt files every text-anchored finding as a comment with a severity prefix (`**Major:** …`), puts findings with no single anchor in a report under `review/reports/`, and ends with a short chat summary. The PM can file comments of its own. Which agents have which tools:

- File new comments (`add_comment`): Reviewer, PM.
- List, reply and resolve (`list_comments`, `reply_comment`, `resolve_comment`): Reviewer, PM, Writer.
- The Advisor, Analyst and Research Assistant have no comment tools.

**Prerequisites.** The editor role to direct agents. The agent's quote must match the current file; otherwise the tool fails ("the quote was not found") and the agent re-reads and retries.

**Gotchas.** Agent quotes are taken from the saved markdown, so they may contain markup (`**bold**`, `[@key]`); the editor still matches them to the rendered text and, on first anchoring, rewrites the stored quote to the rendered form. Agents act on your behalf when resolving — the closing reply is what carries their attribution.

## Asking an agent to address open comments

**What it does.** The Writer, PM and Reviewer can list a document's open threads, act on them, and close the loop in-thread.

**How to use it.** Open the document and ask the Writer, e.g. "Address the open comments on this document". It runs `list_comments`, edits the text for each thread it acts on, then resolves each with a note saying what changed; the note lands as a reply in the thread. Where a comment asks a question that needs no edit, it replies instead. Ask the Reviewer for a re-review and it checks its own earlier threads, resolving fixed ones and replying on those still open. The PM triages: it answers questions in-thread, dispatches actionable feedback to the right agent, and is told never to resolve a thread that is waiting on your answer.

**Prerequisites.** The editor role. Writer edits under `draft/` arrive as suggestions you accept or reject in the editor (see `editor.md`).

**Gotchas.** Agents are instructed to resolve only threads they actually addressed; if you disagree, "Reopen". Resolved threads are hidden from agents' listings unless they ask for them.

## Anchors and orphaned comments

**What it does.** A thread's anchor is the exact quoted text plus offset hints. On open, Kuhn finds the quote in the document — exact match first, then ignoring whitespace differences, then ignoring markdown syntax — and highlights it. While you edit, the highlight moves with the text, and edits inside the range update the stored quote. If the quoted text is deleted entirely, the thread becomes *orphaned*.

**How to use it.** Nothing, in the normal case. An orphaned open thread stays in the panel with the tag "Original text was removed" and no highlight; clicking it shows the toast "The quoted text is no longer in the document". Restoring the text (undo, a version restore, retyping it) re-anchors the thread and clears the flag automatically.

**Prerequisites.** None.

**Gotchas.** Orphaned threads are never deleted automatically; resolve or delete them yourself. The flag is shared: once one tab detects it, other tabs and agents' listings show "(orphaned — the quoted text no longer exists)". A document replaced from outside the editor (an interchange import) has its anchors re-checked at import time.
