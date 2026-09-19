// Waiting-on-you indicator (issue #113 item 4): a quiet, persistent marker in
// the top bar — a sibling of the save/seeding slot — whenever any of the
// user's chats is waiting for their answer, wherever that chat is. Clicking
// it jumps to that chat and its question card. The document title gains a
// "●" prefix so a background tab shows it, and — behind a per-user setting
// that is off by default — a browser notification says who is waiting.
// Everything renders from the activity store (activity.ts), i.e. the org
// feed: a question asked in another tab or on another device counts too.

import * as activity from './activity';
import { selectAgent } from './agent-selector';
import { agentIdentity } from './agents';
import { revealQuestion } from './chat';
import { currentUser } from './login';
import * as workspace from './workspace';

const NOTIFY_KEY = 'kuhn-notify-waiting';
let baseTitle = 'Kuhn';
// Chats that were waiting at the last render, so a notification fires once
// per newly-waiting chat and never again for the same question.
let known = new Set<number>();

export function initWaitingIndicator(): void {
  baseTitle = document.title || 'Kuhn';
  const node = document.getElementById('topbar-waiting') as HTMLButtonElement | null;
  if (!node) return;
  node.addEventListener('click', () => jumpToWaiting());
  activity.subscribe(render);
  workspace.subscribe((change) => { if (change === 'projects' || change === 'project') render(); });
  render();
}

function projectName(projectId: number): string {
  return workspace.projects().find((p) => p.id === projectId)?.name ?? 'another project';
}

function label(agent: string): string {
  return agentIdentity(agent).label || agent;
}

function render(): void {
  const node = document.getElementById('topbar-waiting') as HTMLButtonElement | null;
  if (!node) return;
  const waiting = activity.waitingChats();
  node.hidden = waiting.length === 0;
  document.title = waiting.length ? `● ${baseTitle}` : baseTitle;
  if (waiting.length) {
    const who = waiting.map((c) => `${label(c.agent)} in ${projectName(c.projectId)}`);
    node.innerHTML = `<span class="chat-mark is-waiting"></span>Waiting for you`;
    node.title = `${who.join('\n')}\nClick to go there`;
    node.setAttribute('aria-label', `Waiting for you: ${who.join(', ')}. Click to go to that chat.`);
  }
  // Notify for chats that just started waiting — not for the ones already
  // known, and not for the one the user is looking at.
  const now = new Set(waiting.map((c) => c.chatId));
  if (notifyWaitingEnabled()) {
    for (const c of waiting) {
      if (!known.has(c.chatId) && !inView(c.projectId, c.agent)) notify(c);
    }
  }
  known = now;
}

function inView(projectId: number, agent: string): boolean {
  if (document.hidden) return false;
  const select = document.getElementById('chat-role') as HTMLSelectElement | null;
  return workspace.activeProject()?.id === projectId && select?.value === agent;
}

/**
 * Go to a waiting chat: the first one that is not already in view. Switches
 * the project (main.ts reacts and mounts that project's chat log), selects
 * the agent, and scrolls its question card into view.
 */
export function jumpToWaiting(chat?: { projectId: number; agent: string }): void {
  const waiting = activity.waitingChats();
  const target = chat ?? waiting.find((c) => !inView(c.projectId, c.agent)) ?? waiting[0];
  if (!target) return;
  if (workspace.activeProject()?.id !== target.projectId) workspace.setActiveProject(target.projectId);
  selectAgent(target.agent);
  revealQuestion(target.projectId, target.agent);
}

// ---- Browser notification (per-user setting, off by default) ---------------

function settingKey(): string {
  return `${NOTIFY_KEY}:${currentUser()?.id ?? 'anon'}`;
}

/** Whether this user asked to be notified in this browser. */
export function notifyWaitingEnabled(): boolean {
  try {
    return localStorage.getItem(settingKey()) === '1';
  } catch {
    return false;
  }
}

/** Whether the browser can show notifications at all. */
export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

/**
 * Turn the notification on (asking the browser for permission first) or off.
 * Resolves to the effective state: on only when permission was granted.
 */
export async function setNotifyWaiting(on: boolean): Promise<boolean> {
  if (!on) {
    try { localStorage.setItem(settingKey(), '0'); } catch { /* private mode */ }
    return false;
  }
  if (!notificationsSupported()) return false;
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  const granted = permission === 'granted';
  try { localStorage.setItem(settingKey(), granted ? '1' : '0'); } catch { /* private mode */ }
  return granted;
}

function notify(c: { chatId: number; projectId: number; agent: string; question: string | null }): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`${label(c.agent)} is waiting for your answer`, {
      body: c.question ?? projectName(c.projectId),
      tag: `kuhn-waiting-${c.chatId}`,
    });
    n.onclick = () => {
      window.focus();
      jumpToWaiting({ projectId: c.projectId, agent: c.agent });
      n.close();
    };
  } catch {
    // A browser that refuses the constructor (e.g. no service worker on
    // Android Chrome) just does without.
  }
}
