// Agent chat panel (story 013, restyled for story 025): send a message to the
// selected agent role, stream the response (token-level text_delta events,
// finalized by per-turn text events), render markdown in replies, and tag
// messages with the agent identity. The design's color discipline applies: an
// agent gets role color (spine, avatar, name, working dot, caret) ONLY while it
// is the one streaming; every settled/idle agent renders neutral ink.
//
// Agents can ask questions mid-task (story 012): a question event renders an
// agent question card (story 025) and switches the input box into answer mode;
// the reply is POSTed back into the running job while its event stream stays
// open. On load the panel restores the recent transcript (story 020), and the
// Seed button runs the seeding pipeline (015), narrated by the seeding panel.

import { marked } from 'marked';

import {
  getConversations,
  getPendingQuestions,
  listJobs,
  reconnectAgent,
  replyToAgent,
  runAgentTask,
  seedProject,
  type AgentEvent,
} from './api';
import { agentIdentity } from './agents';
import type { FileChange } from './files';
import { icon } from './icons';
import { QuestionCard } from './question-card';
import { applyStage, completeSeeding, showSeedingPanel } from './seeding';
import { addTokenUsage, notify, setAgentActivity, setBudget } from './status';
import { isUnder, selectedDir } from './tree-state';
import * as workspace from './workspace';

marked.setOptions({ gfm: true, breaks: false });

const DEFAULT_PLACEHOLDER = 'Ask an agent, or describe an edit…';
const VIEW_ONLY_PLACEHOLDER = 'View only — directing agents needs the editor role';

// SDK session per agent slug, so follow-up messages continue the conversation
const sessions = new Map<string, string>();

let activeProjectId = 0;
// Whether the active project has already been seeded/configured. Gates the
// "Start project interview" greeting so it only shows for brand-new projects.
let projectSeeded = false;
let listenersWired = false;
let running = false;
// The last user-initiated action (a chat turn or the seeding pipeline), so the
// "Try again" affordance on a transient-overload failure re-runs exactly it
// without the user having to guess what to retype (story 029).
let retryAction: (() => Promise<void>) | null = null;
// Job waiting on an ask_user reply; the input box answers it instead of
// starting a new task
let pendingQuestionJobId: number | null = null;
let activeQuestionCard: QuestionCard | null = null;
let onFileChange: (change: FileChange) => void = () => {};
// The greeting CTA opens the setup wizard; main wires this so chat.ts doesn't
// import wizard.ts (which imports startSeeding from here — would be a cycle).
let setupHandler: (projectId: number) => void = () => {};
export function setSetupHandler(fn: (projectId: number) => void): void { setupHandler = fn; }

// ---- Role-aware composer (story 010-003) ------------------------------------

/** Whether the current user may direct agents: agent tasks mutate the project,
 * so viewers — and anyone in a suspended org — get a read-only chat (the
 * transcript stays readable; only the composer is disabled). */
function canUseComposer(): boolean {
  return workspace.canEdit() && !workspace.activeOrgSuspended();
}

/** Snapshot of canUseComposer() at the last chrome render (skip no-op emits). */
let composerEditable: boolean | null = null;

/** Enable/disable the composer to match the role, with the view-only hint. */
function applyComposerRole(): void {
  composerEditable = canUseComposer();
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  if (input) {
    input.disabled = !composerEditable;
    // Answer mode never survives a role flip (viewers can't start tasks), so
    // overwriting the placeholder here is safe.
    input.placeholder = composerEditable ? DEFAULT_PLACEHOLDER : VIEW_ONLY_PLACEHOLDER;
    input.title = composerEditable ? '' : VIEW_ONLY_PLACEHOLDER;
  }
  const send = document.querySelector<HTMLButtonElement>('#chat-form .send-btn');
  if (send) {
    send.disabled = !composerEditable;
    send.title = composerEditable ? 'Send (Enter)' : VIEW_ONLY_PLACEHOLDER;
  }
}

// Conversation filter (issue #45): by default the log shows only the selected
// agent's conversation — agents don't share chat context, so seeing exactly
// what the selected agent saw removes the switch-and-assume confusion. A
// toggle above the log shows the full tagged history instead; the choice
// persists across reloads.
const SHOW_ALL_KEY = 'kuhn-chat-show-all';
let showAllAgents = localStorage.getItem(SHOW_ALL_KEY) === '1';
// The role the in-flight run is addressed to. Everything appended during the
// run — including subagent bubbles and file-change lines — belongs to that
// conversation, not to the event's author agent.
let conversationAgent: string | null = null;

// Context assessment (issue #43): a run's inputTokens is what the agent's SDK
// session carried into its last reply — a good proxy for the context it will
// carry into the next one. Above the threshold we suggest (once per agent,
// re-armed by a fresh start) clearing between tasks; the user can also clear
// manually any time via the fresh-start button next to the send button.
const CONTEXT_SUGGEST_TOKENS = 100_000;
const contextTokens = new Map<string, number>();
const contextSuggested = new Set<string>();

export function initChat(
  projectId: number,
  fileChangeHandler: (change: FileChange) => void,
  seeded = false,
): void {
  activeProjectId = projectId;
  projectSeeded = seeded;
  onFileChange = fileChangeHandler;

  // Reset per-project conversation state so switching projects (story 006)
  // doesn't carry a previous project's transcript or agent sessions over.
  sessions.clear();
  contextTokens.clear();
  contextSuggested.clear();
  running = false;
  pendingQuestionJobId = null;
  activeQuestionCard = null;
  document.getElementById('chat-log')!.replaceChildren();
  const seedingPanel = document.getElementById('seeding-panel');
  if (seedingPanel) seedingPanel.hidden = true;
  applyChatFilter(); // refresh the filter bar for the (possibly new) project
  applyComposerRole(); // the active org (and so the role) can differ per project
  void restore();

  if (listenersWired) return; // the form/input listeners bind once for the page
  listenersWired = true;

  // Role changes under us (workspace re-fetches orgs on `kuhn:role-refresh`
  // 403s and on org switches) re-render the composer chrome.
  workspace.subscribe(() => {
    if (canUseComposer() !== composerEditable) applyComposerRole();
  });

  const clearBtn = document.getElementById('chat-clear-btn');
  if (clearBtn) {
    clearBtn.innerHTML = icon('refresh', { size: 13, stroke: 1.8 });
    clearBtn.addEventListener('click', () => clearConversation(selectedAgent(), { confirm: true }));
  }
  document.getElementById('chat-filter-toggle')?.addEventListener('click', () => {
    showAllAgents = !showAllAgents;
    localStorage.setItem(SHOW_ALL_KEY, showAllAgents ? '1' : '0');
    applyChatFilter();
  });
  // The agent-selector pill mirrors picks into the hidden select and fires
  // change — re-filter the log for the newly addressed agent.
  document.getElementById('chat-role')?.addEventListener('change', () => applyChatFilter());

  const form = document.getElementById('chat-form') as HTMLFormElement;
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  // Auto-grow the single-line field as the user types
  input.addEventListener('input', () => autoGrow(input));
}

function autoGrow(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

// ---- Conversation filter (issue #45) ---------------------------------------

function selectedAgent(): string {
  return (document.getElementById('chat-role') as HTMLSelectElement).value;
}

/**
 * Tag a log element with its owning conversation and hide it immediately if
 * the filter excludes it. During a run the addressed role wins over the
 * event's author agent; untagged elements (dividers, out-of-run errors) show
 * in every view.
 */
function tagConversation(el: HTMLElement, agent?: string): void {
  const owner = conversationAgent ?? agent;
  if (!owner) return;
  el.dataset.agent = owner;
  if (!showAllAgents && owner !== selectedAgent()) el.classList.add('chat-filtered-out');
}

/** Re-apply the filter to the whole log and refresh the bar above it. */
function applyChatFilter(): void {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const agent = selectedAgent();
  let ownCount = 0;
  for (const el of Array.from(log.children) as HTMLElement[]) {
    const owner = el.dataset.agent;
    if (owner === agent) ownCount++;
    el.classList.toggle('chat-filtered-out', !showAllAgents && !!owner && owner !== agent);
  }

  // Filtered view with nothing to show: say why, so an inadvertent switch
  // reads as "this agent hasn't seen anything" rather than a wiped chat.
  document.getElementById('chat-filter-empty')?.remove();
  if (!showAllAgents && ownCount === 0) {
    const hint = document.createElement('div');
    hint.id = 'chat-filter-empty';
    hint.className = 'chat-system chat-system-info';
    hint.textContent =
      `No conversation with ${agentLabel(agent)} yet — agents only see messages sent to them. `
      + 'Use “All agents” above to review the full history.';
    log.append(hint);
  }

  const label = document.getElementById('chat-filter-label');
  const toggle = document.getElementById('chat-filter-toggle');
  if (label) label.textContent = showAllAgents ? 'Showing all agents' : `Showing ${agentLabel(agent)} only`;
  if (toggle) {
    toggle.textContent = showAllAgents ? `${agentLabel(agent)} only` : 'All agents';
    toggle.setAttribute('aria-pressed', String(showAllAgents));
  }
  updateContextIndicator();
  scrollLog();
}

// ---- Context assessment & clearing (issue #43) -----------------------------

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Show the selected agent's carried context in the filter bar, if known. */
function updateContextIndicator(): void {
  const el = document.getElementById('chat-context-size');
  if (!el) return;
  const tokens = contextTokens.get(selectedAgent());
  el.textContent = tokens ? `context ~${compactTokens(tokens)} tokens` : '';
  el.classList.toggle('is-high', (tokens ?? 0) >= CONTEXT_SUGGEST_TOKENS);
}

/** Record a finished run's context size and suggest a fresh start when it has
 * grown enough that clearing between tasks is worth it. */
function assessContext(agent: string, inputTokens: number): void {
  contextTokens.set(agent, inputTokens);
  updateContextIndicator();
  if (inputTokens < CONTEXT_SUGGEST_TOKENS || contextSuggested.has(agent)) return;
  contextSuggested.add(agent); // once per agent; a fresh start re-arms it
  const label = agentLabel(agent);
  const log = document.getElementById('chat-log')!;
  const card = document.createElement('div');
  card.className = 'chat-notice chat-notice-context';
  tagConversation(card, agent);
  card.innerHTML =
    `<div class="notice-title">${icon('clock', { size: 14, stroke: 2 })} This conversation is getting long</div>` +
    `<p>${label} is carrying ~${compactTokens(inputTokens)} tokens of chat context into every reply, which ` +
    `costs more and can bury what matters. If you're between tasks, a fresh start keeps ${label} sharp — ` +
    `your files and drafts are untouched, only the chat context resets.</p>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-accent btn-sm notice-action';
  btn.innerHTML = `Start fresh conversation ${icon('arrow-right', { size: 13, stroke: 2 })}`;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    clearConversation(agent, { confirm: false });
  });
  card.append(btn);
  log.append(card);
  scrollLog();
}

/**
 * Drop an agent's SDK session so its next message starts a fresh conversation.
 * The transcript stays on screen (server history is untouched); a divider marks
 * the break so the context boundary is visible in the log.
 */
function clearConversation(agent: string, opts: { confirm: boolean }): void {
  const label = agentLabel(agent);
  if (running) {
    notify(`${label} is still working — wait for the task to finish before clearing`);
    return;
  }
  if (!sessions.has(agent) && !contextTokens.has(agent)) {
    notify(`No conversation context with ${label} to clear`);
    return;
  }
  // Documented exception (story 005-004): native confirm(), as with delete.
  if (opts.confirm && !window.confirm(
    `Start a fresh conversation with ${label}?\n\nIt will no longer remember this chat. Your files and drafts are unaffected.`,
  )) return;
  sessions.delete(agent);
  contextTokens.delete(agent);
  contextSuggested.delete(agent);
  const divider = document.createElement('div');
  divider.className = 'chat-divider';
  divider.textContent = `fresh conversation with ${label} — earlier chat context cleared`;
  tagConversation(divider, agent);
  document.getElementById('chat-log')!.append(divider);
  updateContextIndicator();
  scrollLog();
}

// Restore prior state on page load (story 020): render the recent transcript
// from the conversation log, and seed the per-agent session map from recorded
// jobs so each agent continues its prior SDK session instead of starting fresh.
async function restore(): Promise<void> {
  try {
    await restoreTranscript();
    applyChatFilter(); // restored messages carry mixed conversation tags
    const jobs = await listJobs(activeProjectId);
    for (const job of jobs) {
      // Jobs are newest first; keep the most recent session per role
      if (job.session_id && !sessions.has(job.role)) sessions.set(job.role, job.session_id);
    }
    await reconnectPendingQuestion();
  } catch (err) {
    // A fresh project restores an *empty* transcript without erroring, so a
    // rejection here is a real failure — surface it non-blockingly instead of
    // swallowing it (story 005-004). Chat still works; history may be missing.
    notify(`Could not restore chat history: ${(err as Error).message}`);
  }
}

/**
 * Story 027: if a run is still parked on an ask_user question (the browser
 * dropped while waiting), reconnect to it. The server re-emits the question
 * event, which createEventHandler turns back into a card + answer mode, and the
 * reattached stream carries the agent's continuation once the user answers.
 */
async function reconnectPendingQuestion(): Promise<void> {
  if (running) return;
  const pending = await getPendingQuestions(activeProjectId);
  const p = pending[0]; // one parked top-level run at a time in practice
  if (!p) return;
  running = true;
  conversationAgent = p.agent;
  setAgentActivity(`${agentLabel(p.agent)} is waiting for your answer…`);
  try {
    await reconnectAgent(p.jobId, createEventHandler());
  } catch (err) {
    appendSystemLine((err as Error).message, 'error');
  } finally {
    finishRun();
  }
}

async function restoreTranscript(): Promise<void> {
  const conversations = await getConversations(activeProjectId);
  // Newest conversation first from the API; render oldest → newest
  const messages = conversations
    .reverse()
    .flatMap((c) => c.messages.map((m) => ({ ...m, agent: c.agent_slug })));
  if (messages.length === 0) {
    // Greet only on a brand-new, unseeded project. An already-configured project
    // with an empty transcript (its seeding ran before chat logging, or its
    // history was cleared) must not re-offer the interview. Also skip if seeding
    // has already auto-started on open — the live pipeline is the greeting then.
    if (!running && !projectSeeded) appendGreeting();
    return;
  }

  appendDivider('session restored', messages[0].created_at);
  for (const message of messages) {
    if (message.role === 'user') {
      appendUserMessage(message.content, message.agent);
    } else {
      const { body } = appendAgentMessage(message.agent, message.created_at);
      renderAgentBody(body, message.agent, message.content);
    }
  }
}

/**
 * Handle a streamed AgentEvent, shared by chat sends and the seeding
 * pipeline. Keeps one streaming bubble per assistant turn; a new delta after
 * a finalized turn (or from a different agent) starts a new bubble.
 */
function createEventHandler(): (event: AgentEvent) => void {
  let wrapper: HTMLElement | null = null;
  let body: HTMLElement | null = null;
  let bubbleAgent = '';
  let streamed = '';

  const ensureBubble = (agent: string): HTMLElement => {
    if (!body || bubbleAgent !== agent) {
      const created = appendAgentMessage(agent, new Date().toISOString());
      wrapper = created.wrapper;
      body = created.body;
      bubbleAgent = agent;
      streamed = '';
      setActive(wrapper, agent, true); // it's streaming → role color
    }
    return body;
  };

  const finalize = (): void => {
    if (wrapper) setActive(wrapper, bubbleAgent, false);
    wrapper = null;
    body = null;
  };

  return (event: AgentEvent): void => {
    switch (event.type) {
      case 'text_delta': {
        const node = ensureBubble(event.agent);
        streamed += event.content ?? '';
        node.textContent = streamed;
        scrollLog();
        break;
      }
      case 'text': {
        // Final turn text: replace accumulated deltas with rendered markdown
        const node = ensureBubble(event.agent);
        renderAgentBody(node, event.agent, event.content ?? '');
        finalize();
        scrollLog();
        break;
      }
      case 'file_change': {
        // A move is one line, "moved A → B" (story 012-002) — never a
        // delete+create pair. `from` must ride along on the change too: this
        // channel is live exactly when the project feed is down, and without
        // it the open editor can't retarget and its next autosave resurrects
        // the old path.
        const from = event.kind === 'moved' ? event.meta?.from : undefined;
        appendSystemLine(from
          ? `${event.agent} moved ${from} → ${event.path}`
          : `${event.agent} ${event.kind ?? 'changed'} ${event.path}`);
        if (event.path) {
          onFileChange({ path: event.path, kind: event.kind, agent: event.agent, from });
        }
        break;
      }
      case 'citation': {
        appendSystemLine(`${event.agent} added citation [@${event.key}]`);
        if (event.path) onFileChange({ path: event.path, kind: 'update', agent: event.agent });
        break;
      }
      case 'question': {
        // The agent is blocked waiting for an answer: render the question card
        // and switch the input box into answer mode.
        finalize();
        activeQuestionCard = new QuestionCard(event.agent, event.content ?? '');
        tagConversation(activeQuestionCard.element, event.agent);
        document.getElementById('chat-log')!.append(activeQuestionCard.element);
        pendingQuestionJobId = event.jobId ?? null;
        setAgentActivity(`${agentLabel(event.agent)} is waiting for your answer…`);
        const input = document.getElementById('chat-input') as HTMLTextAreaElement;
        input.placeholder = 'Type your answer…';
        input.focus();
        scrollLog();
        break;
      }
      case 'question_expired': {
        if (pendingQuestionJobId === event.jobId) {
          activeQuestionCard?.markExpired();
          activeQuestionCard = null;
          exitAnswerMode();
        }
        setAgentActivity(`${agentLabel(event.agent)} is working…`);
        break;
      }
      case 'stage': {
        // Seeding pipeline progress (story 015) → the seeding panel.
        if (!applyStage(event)) {
          const label = STAGE_LABELS[event.stage ?? ''] ?? event.stage;
          if (event.status === 'error') appendSystemLine(`${label} failed${event.detail ? `: ${event.detail}` : ''}`, 'error');
        }
        if (event.status === 'start') setAgentActivity(`seeding: ${STAGE_LABELS[event.stage ?? ''] ?? event.stage}…`);
        break;
      }
      case 'notice': {
        // Transient model-provider error: the runtime is backing off and will
        // retry automatically. Show a visible "retrying…" status so the wait
        // isn't an ambiguous silent spinner (story 029).
        if (event.reason === 'provider_overloaded') {
          const secs = event.nextRetryMs ? Math.round(event.nextRetryMs / 1000) : 0;
          setAgentActivity(
            `${agentLabel(event.agent)} paused — model provider busy, retrying${secs ? ` in ${secs}s` : ''}`
            + ` (${event.attempt}/${event.maxAttempts})…`,
          );
          notify('Model provider is busy — retrying automatically…');
        }
        break;
      }
      case 'done': {
        if (event.sessionId) sessions.set(event.agent, event.sessionId);
        if (event.usage) {
          addTokenUsage(event.usage);
          // The done event fires for the addressed role's job (issue #43).
          assessContext(conversationAgent ?? event.agent, event.usage.inputTokens);
        }
        if (event.budget) setBudget(event.budget.used, event.budget.limit);
        break;
      }
      case 'error': {
        finalize();
        if (event.budget) setBudget(event.budget.used, event.budget.limit);
        if (event.reason === 'budget_exceeded') {
          // Keep the session so a follow-up resumes this exact conversation.
          if (event.sessionId) sessions.set(event.agent, event.sessionId);
          appendBudgetNotice(event.agent);
        } else if (event.reason === 'provider_overloaded') {
          // Transient upstream failure that outlasted the runtime's retries —
          // keep the session so a chat "Try again" resumes it, and offer a
          // one-click retry of the original action (story 029).
          if (event.sessionId) sessions.set(event.agent, event.sessionId);
          appendOverloadNotice();
        } else {
          appendSystemLine(event.message ?? 'agent error', 'error');
        }
        break;
      }
    }
  };
}

const STAGE_LABELS: Record<string, string> = {
  interview: 'PM interview',
  research: 'background research',
  skeleton: 'skeleton draft',
  seeding: 'project seeding',
};

async function send(): Promise<void> {
  if (!canUseComposer()) return; // view-only chrome; the server 403s too
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const role = (document.getElementById('chat-role') as HTMLSelectElement).value;
  const text = input.value.trim();
  if (!text) return;

  // Answer mode: route the input to the job waiting on ask_user. The reply
  // unblocks the agent; its events keep arriving on the original stream.
  if (pendingQuestionJobId != null) {
    const jobId = pendingQuestionJobId;
    exitAnswerMode();
    input.value = '';
    autoGrow(input);
    appendUserMessage(text, role);
    activeQuestionCard?.markAnswered(text);
    activeQuestionCard = null;
    setAgentActivity(`${agentLabel(role)} is working…`);
    try {
      await replyToAgent(jobId, text);
    } catch (err) {
      // 409: the question is gone (timed out or its task ended) — story 020
      const message = (err as Error).message;
      if (/no pending question/i.test(message)) {
        appendSystemLine('that question is no longer waiting for an answer (it may have timed out) — your reply was not delivered', 'error');
        setAgentActivity('');
      } else {
        appendSystemLine(message, 'error');
      }
    }
    return;
  }

  if (running) return;
  input.value = '';
  autoGrow(input);

  appendUserMessage(text, role);
  retryAction = () => dispatchTask(role, text);
  await dispatchTask(role, text);
}

/**
 * The folder selected in the file panel, as agent context — but ONLY when it
 * sits inside `draft/` (story 012-001).
 *
 * Why the restriction: `isSuggestionPath` (agent-backend/src/pending-edits.js)
 * gates the whole suggestion/review loop on a path's FIRST segment being
 * exactly `draft`. An agent write under `draft/` becomes a pending edit the
 * user reviews; anywhere else it lands on disk immediately. So hinting an agent
 * toward a non-draft folder would silently downgrade a reviewable proposal into
 * a direct write — a change to the trust loop disguised as a convenience.
 *
 * Outside `draft/` (including the project root, the default) we send nothing
 * and the agent uses its own judgement, exactly as before this story. Nothing
 * here enforces anything: the runtime resolves `write_file` paths the same way
 * either way, and the suggestion gate is untouched.
 */
function draftTargetContext(): { dir: string } | undefined {
  const dir = selectedDir();
  return dir && isUnder(dir, 'draft') ? { dir } : undefined;
}

/**
 * Run a single chat turn. Separated from send() so the user message is appended
 * once but the run itself can be re-invoked by "Try again" after a transient
 * overload (story 029) — resuming the agent's session if one was recorded.
 */
async function dispatchTask(role: string, text: string): Promise<void> {
  if (running) return;
  running = true;
  conversationAgent = role;
  setAgentActivity(`${agentLabel(role)} is working…`);

  try {
    await runAgentTask(
      {
        role,
        projectId: activeProjectId,
        input: text,
        sessionId: sessions.get(role),
        context: draftTargetContext(),
      },
      createEventHandler(),
    );
  } catch (err) {
    appendSystemLine((err as Error).message, 'error');
  } finally {
    finishRun();
  }
}

/** Run the seeding pipeline (story 015), narrated by the seeding panel. */
export async function startSeeding(): Promise<void> {
  if (running) return;
  if (!canUseComposer()) {
    notify('View only — seeding a project needs the editor role');
    return;
  }
  // "Try again" after a transient overload re-runs the whole seeding pipeline —
  // the correct retry for a new-doc request, which is not a resumable chat turn.
  retryAction = () => startSeeding();
  running = true;
  conversationAgent = 'pm'; // seeding is the PM-led interview conversation
  // The interview is starting — drop the empty-state greeting card so its
  // "Start project interview" CTA doesn't linger alongside the live pipeline.
  document.querySelector('#chat-log .chat-msg.is-greeting')?.remove();
  showSeedingPanel();
  setAgentActivity('seeding…');

  try {
    await seedProject(activeProjectId, createEventHandler());
  } catch (err) {
    appendSystemLine((err as Error).message, 'error');
  } finally {
    completeSeeding();
    finishRun();
  }
}

function finishRun(): void {
  running = false;
  conversationAgent = null;
  // The task is over — an unanswered question can no longer be replied to
  if (pendingQuestionJobId != null) {
    activeQuestionCard?.markExpired();
    activeQuestionCard = null;
    exitAnswerMode();
  }
  setAgentActivity('');
  notify('');
}

function exitAnswerMode(): void {
  pendingQuestionJobId = null;
  applyComposerRole(); // restores the role-appropriate placeholder + state
}

// ---- Rendering ------------------------------------------------------------

function agentLabel(slug: string): string {
  return agentIdentity(slug).label || slug;
}

interface AgentBubble {
  wrapper: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
}

function appendAgentMessage(slug: string, isoTime: string): AgentBubble {
  const log = document.getElementById('chat-log')!;
  const id = agentIdentity(slug);

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-agent';
  wrapper.style.setProperty('--role', `var(${id.colorVar})`);
  tagConversation(wrapper, slug);

  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = id.initials;

  const main = document.createElement('div');
  main.className = 'chat-main';

  const head = document.createElement('div');
  head.className = 'chat-head';
  const name = document.createElement('span');
  name.className = 'chat-name';
  name.textContent = id.label;
  const time = document.createElement('span');
  time.className = 'chat-time';
  time.textContent = clockOf(isoTime);
  head.append(name, time);

  const body = document.createElement('div');
  body.className = 'chat-body';

  main.append(head, body);
  wrapper.append(avatar, main);
  log.append(wrapper);
  scrollLog();
  return { wrapper, head, body };
}

function appendUserMessage(text: string, agent?: string): void {
  const log = document.getElementById('chat-log')!;
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-user';
  tagConversation(wrapper, agent);
  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = 'You';
  const main = document.createElement('div');
  main.className = 'chat-main';
  const body = document.createElement('div');
  body.className = 'chat-body';
  body.append(textFragment(text));
  main.append(body);
  wrapper.append(avatar, main);
  log.append(wrapper);
  scrollLog();
}

/** Toggle the single-active-agent color treatment on a message. */
function setActive(wrapper: HTMLElement, slug: string, on: boolean): void {
  const head = wrapper.querySelector('.chat-head');
  if (on) {
    wrapper.classList.add('is-active');
    if (head && !head.querySelector('.chat-working')) {
      const working = document.createElement('span');
      working.className = 'chat-working';
      working.innerHTML = `<span class="dot"></span>working`;
      head.append(working);
    }
  } else {
    wrapper.classList.remove('is-active');
    head?.querySelector('.chat-working')?.remove();
  }
  void slug;
}

/**
 * Render an agent message body. Reviewer messages that carry a bulleted
 * critique render as a bordered "report" card (the design's report variant);
 * everything else renders as inline markdown.
 */
function renderAgentBody(body: HTMLElement, slug: string, markdown: string): void {
  if (slug === 'reviewer' && /^[*\-+] |\n[*\-+] /.test(markdown)) {
    renderReportCard(body, markdown);
    return;
  }
  body.innerHTML = marked.parse(markdown, { async: false });
}

function renderReportCard(body: HTMLElement, markdown: string): void {
  const lines = markdown.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[*\-+] /.test(l)).map((l) => l.replace(/^[*\-+] /, ''));
  const headerLines = lines.filter((l) => !/^[*\-+] /.test(l));
  const title = headerLines[0] ?? 'Review';

  body.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'report-card';
  const head = document.createElement('div');
  head.className = 'report-head';
  head.innerHTML = `${icon('file-text', { size: 13, stroke: 1.8 })}<span></span>`;
  (head.querySelector('span') as HTMLElement).textContent = `${title} · ${bullets.length} note${bullets.length === 1 ? '' : 's'}`;
  const list = document.createElement('div');
  list.className = 'report-body';
  for (const b of bullets) {
    const item = document.createElement('div');
    item.className = 'report-item';
    item.innerHTML = `<span class="bullet">•</span><span></span>`;
    (item.querySelector('span:last-child') as HTMLElement).innerHTML = marked.parseInline(b, { async: false });
    list.append(item);
  }
  card.append(head, list);
  body.append(card);
}

/** Empty-state PM welcome (story 025 screen 3): invites the user to seed. */
function appendGreeting(): void {
  const log = document.getElementById('chat-log')!;
  const id = agentIdentity('pm');
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-agent is-greeting';
  wrapper.style.setProperty('--role', `var(${id.colorVar})`);
  tagConversation(wrapper, 'pm');

  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = id.initials;
  const main = document.createElement('div');
  main.className = 'chat-main';
  const head = document.createElement('div');
  head.className = 'chat-head';
  head.innerHTML = `<span class="chat-name">PM</span>`;
  const body = document.createElement('div');
  body.className = 'chat-body';
  body.innerHTML =
    `<p>Hi — I'm your project manager. Once your project is set up, I'll pull the ` +
    `literature and draft a working skeleton from your materials.</p>` +
    `<p>Set up takes a minute — or just start typing and set up later.</p>`;
  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'btn btn-accent';
  cta.style.marginTop = '4px';
  cta.innerHTML = `Set up project ${icon('arrow-right', { size: 13, stroke: 2 })}`;
  cta.addEventListener('click', () => setupHandler(activeProjectId));
  body.append(cta);

  main.append(head, body);
  wrapper.append(avatar, main);
  log.append(wrapper);
}

function appendDivider(label: string, isoTime?: string): void {
  const log = document.getElementById('chat-log')!;
  const div = document.createElement('div');
  div.className = 'chat-divider';
  const time = isoTime ? `<span class="mono">${clockOf(isoTime)}</span> · ` : '';
  div.innerHTML = `${time}${label}`;
  log.append(div);
  scrollLog();
}

function appendSystemLine(text: string, variant: 'info' | 'error' = 'info'): void {
  const log = document.getElementById('chat-log')!;
  const line = document.createElement('div');
  line.className = `chat-system chat-system-${variant}`;
  line.textContent = text;
  tagConversation(line); // owned by the in-flight conversation, if any
  log.append(line);
  scrollLog();
}

/**
 * Budget-reached notice with a one-click clean resume. The task was paused at
 * the budget limit; files already written are on disk and the SDK session is
 * preserved, so resuming continues the same conversation with a fresh budget.
 */
function appendBudgetNotice(agent: string): void {
  const log = document.getElementById('chat-log')!;
  const label = agentLabel(agent);
  const card = document.createElement('div');
  card.className = 'chat-notice chat-notice-budget';
  tagConversation(card, agent);
  card.innerHTML =
    `<div class="notice-title">${icon('clock', { size: 14, stroke: 2 })} Token budget reached — task paused</div>` +
    `<p>Nothing is lost. Any files ${label} already wrote are saved (check the Files panel), and ` +
    `this conversation is preserved.</p>` +
    `<p>Resume and ${label} will recap what's done and what's still left, then keep going with a ` +
    `fresh budget. Or send your own instruction to steer the rest of the work.</p>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-accent btn-sm notice-action';
  btn.innerHTML = `Resume ${label} ${icon('arrow-right', { size: 13, stroke: 2 })}`;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void continueAfterBudget(agent);
  });
  card.append(btn);
  log.append(card);
  scrollLog();
}

/**
 * Transient-overload notice (story 029). The model provider returned a 529 (or
 * similar) that outlasted the runtime's automatic retries. The work is safe; the
 * one-click action re-runs the original request — the chat turn (resuming the
 * session) or the seeding pipeline, whichever failed.
 */
function appendOverloadNotice(): void {
  const log = document.getElementById('chat-log')!;
  const card = document.createElement('div');
  card.className = 'chat-notice chat-notice-overload';
  tagConversation(card);
  card.innerHTML =
    `<div class="notice-title">${icon('clock', { size: 14, stroke: 2 })} Model provider is overloaded — task paused</div>` +
    `<p>This is a temporary capacity issue upstream (a 529 from the model provider), ` +
    `not a problem with your project. Any work already done is saved.</p>` +
    `<p>It usually clears within seconds. Try again now, or wait a moment and retry.</p>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-accent btn-sm notice-action';
  btn.innerHTML = `Try again ${icon('arrow-right', { size: 13, stroke: 2 })}`;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void retryLast();
  });
  card.append(btn);
  log.append(card);
  scrollLog();
}

/** Re-run the last user-initiated action (chat turn or seeding) — story 029. */
async function retryLast(): Promise<void> {
  if (running) return;
  if (!retryAction) {
    appendSystemLine('Nothing to retry.', 'error');
    return;
  }
  await retryAction();
}

/** Resume a budget-paused agent: same SDK session, fresh budget. */
async function continueAfterBudget(agent: string): Promise<void> {
  if (running) return;
  const prompt =
    'Continue the previous task from where you left off. First, briefly note what you '
    + 'completed and what still remains, then keep going.';
  appendUserMessage(prompt, agent);
  running = true;
  conversationAgent = agent;
  setAgentActivity(`${agentLabel(agent)} is working…`);
  try {
    await runAgentTask(
      {
        role: agent,
        projectId: activeProjectId,
        input: prompt,
        sessionId: sessions.get(agent),
        context: draftTargetContext(),
      },
      createEventHandler(),
    );
  } catch (err) {
    appendSystemLine((err as Error).message, 'error');
  } finally {
    finishRun();
  }
}

function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function textFragment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  text.split('\n').forEach((line, i) => {
    if (i > 0) fragment.append(document.createElement('br'));
    fragment.append(line);
  });
  return fragment;
}

function scrollLog(): void {
  const log = document.getElementById('chat-log')!;
  log.scrollTop = log.scrollHeight;
}
