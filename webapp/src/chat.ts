// Agent chat panel: send a message to the selected agent role, stream the
// response (token-level text_delta events, finalized by per-turn text
// events), render markdown in replies, tag messages with the agent role.
// Agents can ask questions mid-task (story 012): a question event switches
// the input box into answer mode and the reply is POSTed back into the
// running job while its event stream stays open. On load the panel restores
// the recent transcript from the conversation log (story 020), and the Seed
// button runs the seeding pipeline through the same event handling (015).

import { marked } from 'marked';

import {
  getConversations,
  listJobs,
  replyToAgent,
  runAgentTask,
  seedProject,
  type AgentEvent,
} from './api';
import { addTokenUsage, notify, setAgentActivity } from './status';

marked.setOptions({ gfm: true, breaks: false });

const DEFAULT_PLACEHOLDER = 'Ask an agent… (Enter to send, Shift+Enter for newline)';

// SDK session per agent slug, so follow-up messages continue the conversation
const sessions = new Map<string, string>();

let activeProjectId = 0;
let running = false;
// Job waiting on an ask_user reply; the input box answers it instead of
// starting a new task
let pendingQuestionJobId: number | null = null;
let onFileChange: (path: string) => void = () => {};

export function initChat(projectId: number, fileChangeHandler: (path: string) => void): void {
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
    if (sessions.size > 0) {
      appendSystemLine(`↺ resumed session${sessions.size > 1 ? 's' : ''}: ${[...sessions.keys()].join(', ')}`);
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
  if (messages.length === 0) return;

  for (const message of messages) {
    if (message.role === 'user') {
      appendMessage('user', 'you').append(textFragment(message.content));
    } else {
      appendMessage('agent', message.agent).innerHTML = marked.parse(message.content, { async: false });
    }
  }
  appendSystemLine('— restored transcript —');
}

/**
 * Handle a streamed AgentEvent, shared by chat sends and the seeding
 * pipeline. Keeps one streaming bubble per assistant turn; a new delta after
 * a finalized turn (or from a different agent) starts a new bubble.
 */
function createEventHandler(): (event: AgentEvent) => void {
  let bubble: HTMLElement | null = null;
  let bubbleAgent = '';
  let streamed = '';

  const ensureBubble = (agent: string): HTMLElement => {
    if (!bubble || bubbleAgent !== agent) {
      bubble = appendMessage('agent', agent);
      bubbleAgent = agent;
      streamed = '';
    }
    return bubble;
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
        node.innerHTML = marked.parse(event.content ?? '', { async: false });
        bubble = null;
        scrollLog();
        break;
      }
      case 'file_change': {
        appendSystemLine(`✎ ${event.agent} ${event.kind ?? 'changed'} ${event.path}`);
        if (event.path) onFileChange(event.path);
        break;
      }
      case 'question': {
        // The agent is blocked waiting for an answer: render the question and
        // switch the input box into answer mode.
        const node = appendMessage('agent', event.agent);
        node.classList.add('chat-question');
        node.innerHTML = marked.parse(event.content ?? '', { async: false });
        bubble = null;
        pendingQuestionJobId = event.jobId ?? null;
        setAgentActivity(`${event.agent} is waiting for your answer…`);
        const input = document.getElementById('chat-input') as HTMLTextAreaElement;
        input.placeholder = 'Type your answer…';
        input.focus();
        scrollLog();
        break;
      }
      case 'question_expired': {
        // The unanswered question timed out (story 020): leave answer mode
        // visibly instead of swallowing the stale reply box.
        if (pendingQuestionJobId === event.jobId) exitAnswerMode();
        appendSystemLine(`⏱ question timed out — ${event.agent} continues with defaults`);
        setAgentActivity(`${event.agent} is working…`);
        break;
      }
      case 'stage': {
        // Seeding pipeline progress (story 015)
        const label = STAGE_LABELS[event.stage ?? ''] ?? event.stage;
        if (event.status === 'start') {
          appendSystemLine(`▶ ${label}…`);
          setAgentActivity(`seeding: ${label}…`);
        } else if (event.status === 'error') {
          appendSystemLine(`✗ ${label} failed${event.detail ? `: ${event.detail}` : ''}`, 'error');
        } else {
          appendSystemLine(`✓ ${label} done${event.detail ? ` (${event.detail})` : ''}`);
        }
        break;
      }
      case 'done': {
        if (event.sessionId) sessions.set(event.agent, event.sessionId);
        if (event.usage) addTokenUsage(event.usage);
        break;
      }
      case 'error': {
        appendSystemLine(`⚠ ${event.message ?? 'agent error'}`, 'error');
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
    appendMessage('user', 'you').append(textFragment(text));
    setAgentActivity(`${role} is working…`);
    try {
      await replyToAgent(jobId, text);
    } catch (err) {
      // 409: the question is gone (timed out or its task ended) — story 020
      const message = (err as Error).message;
      if (/no pending question/i.test(message)) {
        appendSystemLine('⚠ that question is no longer waiting for an answer (it may have timed out) — your reply was not delivered', 'error');
        setAgentActivity('');
      } else {
        appendSystemLine(`⚠ ${message}`, 'error');
      }
    }
    return;
  }

  if (running) return;
  input.value = '';

  appendMessage('user', 'you').append(textFragment(text));
  running = true;
  setAgentActivity(`${role} is working…`);

  try {
    await runAgentTask(
      { role, projectId: activeProjectId, input: text, sessionId: sessions.get(role) },
      createEventHandler(),
    );
  } catch (err) {
    appendSystemLine(`⚠ ${(err as Error).message}`, 'error');
  } finally {
    finishRun();
  }
}

/** Run the seeding pipeline (story 015), narrating progress into the chat. */
export async function startSeeding(): Promise<void> {
  if (running) return;
  running = true;
  appendSystemLine('🌱 seeding project — the PM will interview you first');
  setAgentActivity('seeding…');

  try {
    await seedProject(activeProjectId, createEventHandler());
  } catch (err) {
    appendSystemLine(`⚠ ${(err as Error).message}`, 'error');
  } finally {
    finishRun();
  }
}

function finishRun(): void {
  running = false;
  // The task is over — an unanswered question can no longer be replied to
  if (pendingQuestionJobId != null) {
    exitAnswerMode();
    appendSystemLine('⏱ the task ended before you answered — the question expired');
  }
  setAgentActivity('');
  notify('');
}

function exitAnswerMode(): void {
  pendingQuestionJobId = null;
  (document.getElementById('chat-input') as HTMLTextAreaElement).placeholder = DEFAULT_PLACEHOLDER;
}

function appendMessage(kind: 'user' | 'agent', tag: string): HTMLElement {
  const log = document.getElementById('chat-log')!;
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message chat-${kind}`;
  const label = document.createElement('span');
  label.className = 'chat-tag';
  label.textContent = tag;
  const body = document.createElement('div');
  body.className = 'chat-body';
  wrapper.append(label, body);
  log.append(wrapper);
  scrollLog();
  return body;
}

function appendSystemLine(text: string, variant: 'info' | 'error' = 'info'): void {
  const log = document.getElementById('chat-log')!;
  const line = document.createElement('div');
  line.className = `chat-system chat-system-${variant}`;
  line.textContent = text;
  log.append(line);
  scrollLog();
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
