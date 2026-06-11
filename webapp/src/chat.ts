// Agent chat panel: send a message to the selected agent role, stream the
// response (token-level text_delta events, finalized by per-turn text
// events), render markdown in replies, tag messages with the agent role.

import { marked } from 'marked';

import { runAgentTask, type AgentEvent } from './api';
import { addTokenUsage, notify, setAgentActivity } from './status';

marked.setOptions({ gfm: true, breaks: false });

// SDK session per role, so follow-up messages continue the conversation
const sessions = new Map<string, string>();

let activeProjectId = 0;
let running = false;
let onFileChange: (path: string) => void = () => {};

export function initChat(projectId: number, fileChangeHandler: (path: string) => void): void {
  activeProjectId = projectId;
  onFileChange = fileChangeHandler;

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

async function send(): Promise<void> {
  if (running) return;
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const role = (document.getElementById('chat-role') as HTMLSelectElement).value;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  appendMessage('user', 'you').append(textFragment(text));
  running = true;
  setAgentActivity(`${role} is working…`);

  // One streaming bubble per assistant turn; a new delta after a finalized
  // turn (or from a different agent) starts a new bubble.
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

  const handleEvent = (event: AgentEvent): void => {
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
      case 'done': {
        if (event.sessionId) sessions.set(role, event.sessionId);
        if (event.usage) addTokenUsage(event.usage);
        break;
      }
      case 'error': {
        appendSystemLine(`⚠ ${event.message ?? 'agent error'}`, 'error');
        break;
      }
    }
  };

  try {
    await runAgentTask(
      { role, projectId: activeProjectId, input: text, sessionId: sessions.get(role) },
      handleEvent,
    );
  } catch (err) {
    appendSystemLine(`⚠ ${(err as Error).message}`, 'error');
  } finally {
    running = false;
    setAgentActivity('');
    notify('');
  }
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
