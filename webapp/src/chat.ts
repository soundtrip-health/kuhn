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
  listJobs,
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
import { addTokenUsage, notify, setAgentActivity } from './status';

marked.setOptions({ gfm: true, breaks: false });

const DEFAULT_PLACEHOLDER = 'Ask an agent, or describe an edit…';

// SDK session per agent slug, so follow-up messages continue the conversation
const sessions = new Map<string, string>();

let activeProjectId = 0;
let running = false;
// Job waiting on an ask_user reply; the input box answers it instead of
// starting a new task
let pendingQuestionJobId: number | null = null;
let activeQuestionCard: QuestionCard | null = null;
let onFileChange: (change: FileChange) => void = () => {};

export function initChat(projectId: number, fileChangeHandler: (change: FileChange) => void): void {
  activeProjectId = projectId;
  onFileChange = fileChangeHandler;
  void restore();

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
  } catch {
    // No backend or no history yet — start fresh
  }
}

async function restoreTranscript(): Promise<void> {
  const conversations = await getConversations(activeProjectId);
  // Newest conversation first from the API; render oldest → newest
  const messages = conversations
    .reverse()
    .flatMap((c) => c.messages.map((m) => ({ ...m, agent: c.agent_slug })));
  if (messages.length === 0) {
    appendGreeting();
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
      case 'done': {
        if (event.sessionId) sessions.set(event.agent, event.sessionId);
        if (event.usage) addTokenUsage(event.usage);
        break;
      }
      case 'error': {
        finalize();
        appendSystemLine(event.message ?? 'agent error', 'error');
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
  running = true;
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
