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

marked.setOptions({ gfm: true, breaks: false });

const DEFAULT_PLACEHOLDER = 'Ask an agent, or describe an edit…';

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
  running = false;
  pendingQuestionJobId = null;
  activeQuestionCard = null;
  document.getElementById('chat-log')!.replaceChildren();
  const seedingPanel = document.getElementById('seeding-panel');
  if (seedingPanel) seedingPanel.hidden = true;
  void restore();

  if (listenersWired) return; // the form/input listeners bind once for the page
  listenersWired = true;

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

// Restore prior state on page load (story 020): render the recent transcript
// from the conversation log, and seed the per-agent session map from recorded
// jobs so each agent continues its prior SDK session instead of starting fresh.
async function restore(): Promise<void> {
  try {
    await restoreTranscript();
    const jobs = await listJobs(activeProjectId);
    for (const job of jobs) {
      // Jobs are newest first; keep the most recent session per role
      if (job.session_id && !sessions.has(job.role)) sessions.set(job.role, job.session_id);
    }
    await reconnectPendingQuestion();
  } catch {
    // No backend or no history yet — start fresh
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
      appendUserMessage(message.content);
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
        appendSystemLine(`${event.agent} ${event.kind ?? 'changed'} ${event.path}`);
        if (event.path) onFileChange({ path: event.path, kind: event.kind, agent: event.agent });
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
        if (event.usage) addTokenUsage(event.usage);
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
    appendUserMessage(text);
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

  appendUserMessage(text);
  retryAction = () => dispatchTask(role, text);
  await dispatchTask(role, text);
}

/**
 * Run a single chat turn. Separated from send() so the user message is appended
 * once but the run itself can be re-invoked by "Try again" after a transient
 * overload (story 029) — resuming the agent's session if one was recorded.
 */
async function dispatchTask(role: string, text: string): Promise<void> {
  if (running) return;
  running = true;
  setAgentActivity(`${agentLabel(role)} is working…`);

  try {
    await runAgentTask(
      { role, projectId: activeProjectId, input: text, sessionId: sessions.get(role) },
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
  // "Try again" after a transient overload re-runs the whole seeding pipeline —
  // the correct retry for a new-doc request, which is not a resumable chat turn.
  retryAction = () => startSeeding();
  running = true;
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
  (document.getElementById('chat-input') as HTMLTextAreaElement).placeholder = DEFAULT_PLACEHOLDER;
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

function appendUserMessage(text: string): void {
  const log = document.getElementById('chat-log')!;
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-user';
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
    `<p>Hi — I'm your project manager. Tell me what you're writing and I'll assemble the ` +
    `team, pull the literature, and draft a working skeleton.</p>` +
    `<p>A short interview gets the best result, but you can also just start typing.</p>`;
  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'btn btn-accent';
  cta.style.marginTop = '4px';
  cta.innerHTML = `Start project interview ${icon('arrow-right', { size: 13, stroke: 2 })}`;
  cta.addEventListener('click', () => void startSeeding());
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
  appendUserMessage(prompt);
  running = true;
  setAgentActivity(`${agentLabel(agent)} is working…`);
  try {
    await runAgentTask(
      { role: agent, projectId: activeProjectId, input: prompt, sessionId: sessions.get(agent) },
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
