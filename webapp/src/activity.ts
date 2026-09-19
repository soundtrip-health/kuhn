// Chat activity store (issue #113 item 3): what is running or waiting on the
// user across the active organization, from the org activity feed
// (GET /api/orgs/:id/activity). The project browser marks each project, the
// agent pill marks each agent, and the waiting-on-you indicator (item 4)
// reads it too. Server truth only — the local run registry (chat-runs.ts)
// knows this tab's streams, but a run started in another tab or device is
// just as much the user's, and the feed's snapshot is right after a reload.
//
// One subscription per active org, re-opened on an org switch. The feed
// re-sends its snapshot on every (re)connect, so the map is always rebuilt
// from the server rather than patched around a gap.

import { subscribeOrgActivity, type ChatActivity } from './api';
import { agentIdentity } from './agents';
import { currentUser } from './login';
import * as workspace from './workspace';

/** What a mark shows: a ring (running), a filled dot (waiting on the user), or nothing. */
export type Mark = 'running' | 'waiting' | null;

const chats = new Map<number, ChatActivity>();
const listeners = new Set<() => void>();
let closeFeed: (() => void) | null = null;
let feedOrgId: number | null = null;

export function initActivity(): void {
  workspace.subscribe((change) => {
    if (change === 'init' || change === 'orgs' || change === 'projects' || change === 'project') syncFeed();
  });
  syncFeed();
}

function syncFeed(): void {
  const orgId = workspace.activeOrg()?.id ?? null;
  if (orgId === feedOrgId) return;
  closeFeed?.();
  closeFeed = null;
  feedOrgId = orgId;
  chats.clear();
  emit();
  if (orgId == null) return;
  closeFeed = subscribeOrgActivity(orgId, {
    onEvent: (event) => {
      if (event.type === 'snapshot') {
        chats.clear();
        for (const c of event.chats) chats.set(c.chatId, c);
      } else if (event.type === 'chat') {
        if (event.status === 'idle') chats.delete(event.chatId);
        else chats.set(event.chatId, event);
      } else {
        return;
      }
      emit();
    },
  });
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of [...listeners]) fn();
}

/** The user's own chats that are not idle, feed order. */
export function ownActivity(): ChatActivity[] {
  const me = currentUser()?.id;
  return [...chats.values()].filter((c) => c.userId === me);
}

/** The user's chats waiting on them (issue #113 item 4 reads this). */
export function waitingChats(): ChatActivity[] {
  return ownActivity().filter((c) => c.status === 'waiting_for_user');
}

function markOf(list: ChatActivity[]): Mark {
  if (list.some((c) => c.status === 'waiting_for_user')) return 'waiting';
  if (list.some((c) => c.status === 'running')) return 'running';
  return null;
}

/** The mark for a project: waiting beats running; a budget pause shows nothing. */
export function projectMark(projectId: number): Mark {
  return markOf(ownActivity().filter((c) => c.projectId === projectId));
}

/** The mark for one agent's chat in a project. */
export function agentMark(projectId: number, agent: string): Mark {
  return markOf(ownActivity().filter((c) => c.projectId === projectId && c.agent === agent));
}

/**
 * The mark element: a small ring while running, a filled dot while waiting
 * on the user (spec §4: unobtrusive, no counts). `who` names the agents for
 * the tooltip.
 */
export function renderMark(mark: Exclude<Mark, null>, who: string[] = []): HTMLElement {
  const el = document.createElement('span');
  el.className = `chat-mark is-${mark}`;
  const names = who.map((slug) => agentIdentity(slug).label || slug);
  const label = mark === 'waiting'
    ? `Waiting for your answer${names.length ? `: ${names.join(', ')}` : ''}`
    : `Working${names.length ? `: ${names.join(', ')}` : ''}`;
  el.title = label;
  el.setAttribute('aria-label', label);
  el.setAttribute('role', 'img');
  return el;
}

/** Agents of the user's chats in a project with the given mark, for tooltips. */
export function markedAgents(projectId: number, mark: Exclude<Mark, null>): string[] {
  const status = mark === 'waiting' ? 'waiting_for_user' : 'running';
  return ownActivity().filter((c) => c.projectId === projectId && c.status === status).map((c) => c.agent);
}
