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
//
// Parallel chats (issue #113 item 2): the panel keeps one chat log PER PROJECT
// and one run PER CHAT (project + agent, see chat-runs.ts). Switching projects
// swaps which log is mounted and leaves every stream open — a run keeps
// rendering into its own project's log, and the composer, Stop and the status
// bar follow the chat in view (the active project's selected agent). A project
// whose runs are all idle is dropped when you switch away again, so returning
// restores its transcript afresh from the server; a project with a live run is
// kept, so returning shows what streamed while you were elsewhere. After a
// reload the server lists the runs it kept alive and the panel re-attaches.

import {
  cancelAgentJob,
  getConversations,
  getLiveRuns,
  getOrCreateChat,
  listJobs,
  listProjectChats,
  patchChat,
  reconnectAgent,
  replyToAgent,
  resetChat,
  resumeJob,
  runAgentTask,
  seedProject,
  type AgentEvent,
  type AgentTaskParams,
  type Chat,
  type Job,
} from './api';
import { agentIdentity } from './agents';
import { allRuns, endRun, getRun, projectRuns, startRun, type ChatRun } from './chat-runs';
import type { FileChange } from './files';
import { icon } from './icons';
import { escapeHtml, renderInlineMarkdown, renderMarkdown } from './markdown';
import { clearPinnedProfile, initModelPicker, pinnedProfile, primeChatPins, refreshModelPicker, resetModelPicker } from './model-picker';
import { QuestionCard } from './question-card';
import { applyStage, completeSeeding, seedingActive, showSeedingPanel } from './seeding';
import { addTokenUsage, notify, setAgentActivity, setAgentModel, setBudget, type ModelChip } from './status';
import { isUnder, selectedDir } from './tree-state';
import * as workspace from './workspace';

const DEFAULT_PLACEHOLDER = 'Ask an agent, or describe an edit…';
const VIEW_ONLY_PLACEHOLDER = 'View only — directing agents needs the editor role';
const ANSWER_PLACEHOLDER = 'Type your answer…';

// jobs.error of a run the token budget paused (issue #110) — the durable
// signal the pause card is rebuilt from after a reload. Mirrors
// agent-backend/src/agents/budget-pause.js.
const BUDGET_EXCEEDED_ERROR = 'token budget exceeded';

/**
 * Everything the panel knows about one project: its log element (mounted
 * while the project is active, kept alive otherwise) and the per-agent state
 * that used to be module-level and wiped on every switch.
 */
interface ProjectChat {
  projectId: number;
  /** The chat log for this project. Exactly one is in the document at a time (id `chat-log`). */
  log: HTMLElement;
  // The user's chats in the project, by agent slug (issue #113): the durable
  // server-side thread. The provider session, the canonical continuation
  // (STH-47), the model pin (issue #134) and the fresh-start hand-off note
  // (STH-55) all live on the row, so a follow-up from any tab or device
  // continues the same conversation. This map is a mirror — loaded on first
  // visit, refreshed after each run; the server is authoritative and the app
  // only names the chat when it sends a message.
  chats: Map<string, Chat>;
  // Agents whose fresh start is still being applied server-side (the reset
  // includes the hand-off scan): a message sent meanwhile would resume the
  // old session, so sends wait for it.
  resetting: Set<string>;
  // Context assessment (issue #43) per agent: what the agent's session
  // carried into its last reply, the once-per-agent "getting long" nudge.
  contextTokens: Map<string, number>;
  contextSuggested: Set<string>;
  /** Last model each agent was routed to (issue #107) — from 'model' events, seeded from job rows on load. */
  agentModels: Map<string, ModelChip>;
  /** The jobs of each agent's last run, for the model chip's tooltip once the run is over. */
  lastRunModels: Map<string, ModelChip[]>;
  // Smart autoscroll (STH-50): the log follows new output only while the
  // user is at (or near) the bottom.
  stickToBottom: boolean;
  /** Whether the project has been seeded/configured (gates the interview greeting). */
  seeded: boolean;
  /** The transcript and chats have been loaded (once per cached project). */
  restored: boolean;
  // The last user-initiated action in this project (a chat turn or the
  // seeding pipeline), so "Try again" on a transient-overload failure re-runs
  // exactly it without the user having to guess what to retype (story 029).
  retryAction: (() => Promise<void>) | null;
  /** main.ts's file-change handler for this project; only called while the project is active. */
  onFileChange: (change: FileChange) => void;
  /** file_change events a background run produced; replayed when the project is next mounted. */
  deferredFileChanges: FileChange[];
  /** Assistant turns the transcript restore rendered, so a re-attached run does not render them again. */
  restoredTexts: Set<string>;
}

const projects = new Map<number, ProjectChat>();
/** The mounted project — the one the composer, filter and status bar address. */
let current: ProjectChat | null = null;

let listenersWired = false;
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

/** The run of the chat in view: the active project's selected agent. */
function viewRun(): ChatRun | null {
  return current ? getRun(current.projectId, selectedAgent()) : null;
}

function inView(run: ChatRun): boolean {
  return current?.projectId === run.projectId && selectedAgent() === run.agent;
}

/**
 * Render the composer for the chat in view: the role (viewers get a disabled
 * box with the view-only hint), answer mode while that chat's run waits on a
 * question, and the send button, which doubles as Stop while the run is in
 * flight and not waiting on an answer (issue #136). Other chats' runs do not
 * touch the composer — their activity shows only on the agent marks.
 */
function renderComposer(): void {
  composerEditable = canUseComposer();
  const run = viewRun();
  const answering = run?.pendingQuestionJobId != null;
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  if (input) {
    input.disabled = !composerEditable;
    input.placeholder = !composerEditable ? VIEW_ONLY_PLACEHOLDER : answering ? ANSWER_PLACEHOLDER : DEFAULT_PLACEHOLDER;
    input.title = composerEditable ? '' : VIEW_ONLY_PLACEHOLDER;
  }
  const send = document.querySelector<HTMLButtonElement>('#chat-form .send-btn');
  if (!send) return;
  const stopMode = run != null && !answering;
  send.classList.toggle('is-stop', stopMode);
  send.type = stopMode ? 'button' : 'submit';
  send.disabled = stopMode ? run.stopping : !composerEditable;
  send.innerHTML = icon(stopMode ? 'stop' : 'send', { size: 15, stroke: 2 });
  const label = stopMode ? (run.stopping ? 'Stopping…' : 'Stop the agent (Esc)') : composerEditable ? 'Send (Enter)' : VIEW_ONLY_PLACEHOLDER;
  send.title = label;
  send.setAttribute('aria-label', stopMode ? 'Stop the agent' : 'Send');
}

/** The status bar, the composer and the model chip all follow the chat in view. */
function renderRunStatus(): void {
  setAgentActivity(viewRun()?.activity ?? '');
  renderComposer();
  updateModelIndicator();
}

/** Change a run's activity text; shown at once when that chat is in view. */
function setRunActivity(run: ChatRun, text: string): void {
  run.activity = text;
  if (inView(run)) setAgentActivity(text);
}

/**
 * Stop a run (issue #136). The server interrupts the agent and everything it
 * dispatched; the run's stream then ends with a `cancelled` event carrying
 * the provider session, so the next message continues from where it stopped.
 * With no addressable job yet — or for the seeding pipeline, which has none —
 * the stream itself is aborted instead.
 */
async function stopRun(run: ChatRun): Promise<void> {
  if (run.stopping) return;
  run.stopping = true;
  setRunActivity(run, 'Stopping…');
  renderComposer();
  const jobId = run.tracker.rootJobId;
  if (jobId != null) {
    try {
      await cancelAgentJob(jobId);
      return; // the stream delivers `cancelled` and ends on its own
    } catch {
      // Not live on the server (already finished, or a restart) — fall through.
    }
  }
  run.abort.abort();
}

function appendStopped(pc: ProjectChat, owner: string, agent: string | null = owner): void {
  const who = agent ? agentLabel(agent) : 'The agent';
  appendSystemLine(pc, `${who} stopped. Say what to do next to continue from here, or start a fresh conversation.`, 'info', owner);
}

/** Activity text for the innermost running job (issue #137); a pending question or a stop in progress keeps its own text. */
function updateRunActivity(run: ChatRun): void {
  if (run.stopping || run.pendingQuestionJobId != null) return;
  const agent = run.tracker.current?.agent ?? run.agent;
  setRunActivity(run, `${agentLabel(agent)} is working…`);
}

/**
 * A run's stream failed. A stop the user asked for is not an error; a drop
 * while the run is still alive on the server re-attaches (STH-48; since
 * issue #113 item 2 every chat run stays alive); anything else is shown.
 */
async function handleRunFailure(pc: ProjectChat, run: ChatRun, err: unknown): Promise<void> {
  if (run.stopping) {
    appendStopped(pc, run.agent);
    return;
  }
  if (!(await resumeAfterStreamDrop(run))) {
    appendSystemLine(pc, (err as Error).message, 'error', run.agent);
  }
}

// Conversation filter (issue #45): by default the log shows only the selected
// agent's conversation — agents don't share chat context, so seeing exactly
// what the selected agent saw removes the switch-and-assume confusion. A
// toggle above the log shows the full tagged history instead; the choice
// persists across reloads.
const SHOW_ALL_KEY = 'kuhn-chat-show-all';
let showAllAgents = localStorage.getItem(SHOW_ALL_KEY) === '1';

const NEAR_BOTTOM_PX = 40;

// Context assessment (issue #43): a run's inputTokens is what the agent's SDK
// session carried into its last reply — a good proxy for the context it will
// carry into the next one. Above the threshold we suggest (once per agent,
// re-armed by a fresh start) clearing between tasks; the user can also clear
// manually any time via the fresh-start button next to the send button.
const CONTEXT_SUGGEST_TOKENS = 100_000;
// Denominator for the context meter (STH-52); refined by live 'context'
// events, which carry the backend's configured window size.
let contextWindow = 200_000;

/** How many idle projects' logs to keep mounted-ready; live runs are never dropped. */
function createProjectChat(projectId: number, seeded: boolean, onFileChange: (change: FileChange) => void): ProjectChat {
  const log = document.createElement('div');
  log.id = 'chat-log';
  const pc: ProjectChat = {
    projectId, log, seeded, onFileChange,
    chats: new Map(), resetting: new Set(), contextTokens: new Map(), contextSuggested: new Set(),
    agentModels: new Map(), lastRunModels: new Map(), stickToBottom: true, restored: false,
    retryAction: null, deferredFileChanges: [], restoredTexts: new Set(),
  };
  // Smart autoscroll (STH-50): park following when the user scrolls up;
  // re-engage when they return to the bottom. Our own programmatic scrolls
  // land at the bottom, so this listener is a no-op for them.
  log.addEventListener('scroll', () => {
    setStickToBottom(pc, log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM_PX);
  });
  return pc;
}

/** Put a project's log in the document in place of whichever one is there. */
function mountLog(pc: ProjectChat): void {
  const mounted = document.getElementById('chat-log');
  if (mounted && mounted !== pc.log) mounted.replaceWith(pc.log);
}

export function initChat(
  projectId: number,
  fileChangeHandler: (change: FileChange) => void,
  seeded = false,
): void {
  // A project you left with nothing running is forgotten now (its transcript
  // comes back fresh from the server next time); one with a live run is kept
  // so its stream keeps a log to render into.
  for (const [id] of projects) {
    if (id !== projectId && projectRuns(id).length === 0) projects.delete(id);
  }
  let pc = projects.get(projectId);
  const fresh = !pc;
  if (!pc) {
    pc = createProjectChat(projectId, seeded, fileChangeHandler);
    projects.set(projectId, pc);
  } else {
    pc.onFileChange = fileChangeHandler;
    pc.seeded = seeded;
  }
  current = pc;
  mountLog(pc);
  // The seeding panel narrates this project's pipeline only.
  const seedingPanel = document.getElementById('seeding-panel');
  if (seedingPanel) seedingPanel.hidden = !(getRun(projectId, 'pm')?.kind === 'seeding' && seedingActive());
  applyChatFilter(pc); // refresh the filter bar for the (possibly new) project
  resetModelPicker(); // the org's routes (and so the pickable models) differ per project
  renderRunStatus(); // the composer, Stop and status bar follow this project's selected chat
  if (fresh) {
    void restore(pc);
  } else {
    // What the project's background runs changed while it was out of view.
    for (const change of pc.deferredFileChanges.splice(0)) pc.onFileChange(change);
    updateContextIndicator();
    scrollLog(pc, true);
  }

  if (listenersWired) {
    void refreshModelPicker();
    return; // the form/input listeners bind once for the page
  }
  listenersWired = true;
  // Which model powers the addressed agent (issue #134): per project + agent.
  initModelPicker({ projectId: () => current?.projectId ?? 0, agent: () => selectedAgent() });
  void refreshModelPicker();

  // Role changes under us (workspace re-fetches orgs on `kuhn:role-refresh`
  // 403s and on org switches) re-render the composer chrome.
  workspace.subscribe(() => {
    if (canUseComposer() !== composerEditable) renderComposer();
  });

  const clearBtn = document.getElementById('chat-clear-btn');
  if (clearBtn) {
    clearBtn.innerHTML = icon('refresh', { size: 13, stroke: 1.8 });
    clearBtn.addEventListener('click', () => { if (current) clearConversation(current, selectedAgent(), { confirm: true }); });
  }
  document.getElementById('chat-filter-toggle')?.addEventListener('click', () => {
    showAllAgents = !showAllAgents;
    localStorage.setItem(SHOW_ALL_KEY, showAllAgents ? '1' : '0');
    if (current) applyChatFilter(current);
  });
  // The agent-selector pill mirrors picks into the hidden select and fires
  // change — re-filter the log for the newly addressed agent, and show that
  // chat's run (if any) in the composer and status bar.
  document.getElementById('chat-role')?.addEventListener('change', () => {
    if (current) applyChatFilter(current);
    renderRunStatus();
    void refreshModelPicker();
  });

  const jump = document.createElement('button');
  jump.type = 'button';
  jump.id = 'chat-jump';
  jump.hidden = true;
  jump.innerHTML = `${icon('chevron-down', { size: 14, stroke: 2 })}<span>New messages</span>`;
  jump.addEventListener('click', () => { if (current) scrollLog(current, true); });
  document.getElementById('chat-form')!.append(jump);

  const form = document.getElementById('chat-form') as HTMLFormElement;
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });
  // Stop (issue #136): the send button while a run is in flight, or Esc in the box.
  form.querySelector('.send-btn')?.addEventListener('click', (e) => {
    if ((e.currentTarget as HTMLElement).classList.contains('is-stop')) {
      e.preventDefault();
      const run = viewRun();
      if (run) void stopRun(run);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape') {
      const run = viewRun();
      if (run && run.pendingQuestionJobId == null) {
        e.preventDefault();
        void stopRun(run);
      }
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
 * event's author agent (callers pass the run's agent as `owner`); untagged
 * elements (dividers, out-of-run errors) show in every view.
 */
function tagConversation(pc: ProjectChat, el: HTMLElement, owner?: string | null): void {
  if (!owner) return;
  el.dataset.agent = owner;
  if (pc === current && !showAllAgents && owner !== selectedAgent()) el.classList.add('chat-filtered-out');
}

/** Re-apply the filter to the whole log and refresh the bar above it. */
function applyChatFilter(pc: ProjectChat): void {
  const log = pc.log;
  const agent = selectedAgent();
  let ownCount = 0;
  for (const el of Array.from(log.children) as HTMLElement[]) {
    const owner = el.dataset.agent;
    if (owner === agent) ownCount++;
    el.classList.toggle('chat-filtered-out', !showAllAgents && !!owner && owner !== agent);
  }

  // Filtered view with nothing to show: say why, so an inadvertent switch
  // reads as "this agent hasn't seen anything" rather than a wiped chat.
  log.querySelector('#chat-filter-empty')?.remove();
  if (!showAllAgents && ownCount === 0) {
    const hint = document.createElement('div');
    hint.id = 'chat-filter-empty';
    hint.className = 'chat-system chat-system-info';
    hint.textContent =
      `No conversation with ${agentLabel(agent)} yet — agents only see messages sent to them. `
      + 'Use “All agents” above to review the full history.';
    log.append(hint);
  }

  if (pc !== current) return;
  const label = document.getElementById('chat-filter-label');
  const toggle = document.getElementById('chat-filter-toggle');
  if (label) label.textContent = showAllAgents ? 'Showing all agents' : `Showing ${agentLabel(agent)} only`;
  if (toggle) {
    toggle.textContent = showAllAgents ? `${agentLabel(agent)} only` : 'All agents';
    toggle.setAttribute('aria-pressed', String(showAllAgents));
  }
  updateContextIndicator();
  updateModelIndicator();
  scrollLog(pc, true);
}

// ---- Context assessment & clearing (issue #43) -----------------------------

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Status-bar model chip (issue #107). During a run it follows the innermost
 * RUNNING job (issue #137) — a dispatched sub-agent's model and difficulty
 * replace the addressed agent's while it works, and the dispatcher's return
 * once it ends — which is the point: seeing what the dispatcher chose. Idle,
 * it shows the selected agent's last known routing; the run's full list
 * stays in the tooltip. Follows the chat in view. */
function updateModelIndicator(): void {
  if (!current) return;
  const agent = selectedAgent();
  const run = viewRun();
  const active = run ? run.tracker.current : null;
  const chip = active ? active.chip : current.agentModels.get(agent) ?? null;
  const history = run ? run.runModels : current.lastRunModels.get(agent) ?? [];
  setAgentModel(chip, history);
}

/** Per-agent context meter (STH-52), bottom of the chat window: how much
 * context the selected agent carries into its next reply, as a share of
 * its model's window. Fed live by 'context' events during a run, by the
 * done event's context field, and on reload from recorded jobs
 * (context_tokens = last-turn context). Hidden until something is known. */
function updateContextIndicator(): void {
  const meter = document.getElementById('chat-context-meter');
  if (!meter || !current) return;
  const tokens = current.contextTokens.get(selectedAgent());
  if (!tokens) {
    meter.hidden = true;
    return;
  }
  const pct = Math.min(100, Math.round((tokens / contextWindow) * 100));
  const fill = document.getElementById('chat-context-fill') as HTMLElement;
  fill.style.width = `${Math.max(pct, 2)}%`;
  document.getElementById('chat-context-text')!.textContent =
    `${compactTokens(tokens)} / ${compactTokens(contextWindow)}`;
  meter.classList.toggle('is-high', tokens >= CONTEXT_SUGGEST_TOKENS);
  meter.title = `${agentLabel(selectedAgent())} carries ~${compactTokens(tokens)} tokens `
    + `(${pct}% of a ${compactTokens(contextWindow)}-token window) into its next reply`;
  meter.hidden = false;
}

/** Record a finished run's context size and suggest a fresh start when it has
 * grown enough that clearing between tasks is worth it. */
function assessContext(pc: ProjectChat, agent: string, inputTokens: number): void {
  pc.contextTokens.set(agent, inputTokens);
  if (pc === current) updateContextIndicator();
  if (inputTokens < CONTEXT_SUGGEST_TOKENS || pc.contextSuggested.has(agent)) return;
  pc.contextSuggested.add(agent); // once per agent; a fresh start re-arms it
  const label = escapeHtml(agentLabel(agent)); // spliced into innerHTML below
  const card = document.createElement('div');
  card.className = 'chat-notice chat-notice-context';
  tagConversation(pc, card, agent);
  card.innerHTML =
    `<div class="notice-title">${icon('clock', { size: 14, stroke: 2 })} This conversation is getting long</div>` +
    `<p>${label} is carrying ~${compactTokens(inputTokens)} tokens of chat context into every reply, which ` +
    `costs more and can bury what matters. If you're between tasks, a fresh start keeps ${label} sharp — ` +
    `your files and drafts are untouched, only the chat context resets.</p>`;
  // STH-55: hand-off capture opt-out — ON by default; read at click time.
  const carry = document.createElement('label');
  carry.className = 'notice-checkbox';
  const carryBox = document.createElement('input');
  carryBox.type = 'checkbox';
  carryBox.checked = true;
  carry.append(carryBox, document.createTextNode(
    ' Carry a short hand-off note (open action items) into the fresh conversation',
  ));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-accent btn-sm notice-action';
  btn.innerHTML = `Start fresh conversation ${icon('arrow-right', { size: 13, stroke: 2 })}`;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    // A refused clear (agent still running) leaves the card — re-arm the
    // button; a successful one removes the card via clearConversation.
    if (!clearConversation(pc, agent, { confirm: false, handoff: carryBox.checked })) btn.disabled = false;
  });
  card.append(carry, btn);
  pc.log.append(card);
  scrollLog(pc);
}

/**
 * Drop the "getting long" card(s) for an agent once its context IS cleared
 * (STH-46). Leaving the card — with its prominent call-to-action — after the
 * divider announced a fresh start read as "not cleared yet". The divider is
 * the durable record of the break; the suggestion has served its purpose.
 */
function dismissContextNotices(pc: ProjectChat, agent: string): void {
  pc.log
    .querySelectorAll<HTMLElement>(`.chat-notice-context[data-agent="${CSS.escape(agent)}"]`)
    .forEach((card) => card.remove());
}

/**
 * Start a fresh conversation with an agent: the chat is reset server-side
 * (issue #113) so its next message starts a new provider session — from this
 * tab or any other. The transcript stays on screen (server history is
 * untouched); a divider marks the break so the context boundary is visible in
 * the log. Returns whether the reset was started (false when refused or
 * cancelled).
 */
function clearConversation(pc: ProjectChat, agent: string, opts: { confirm: boolean; handoff?: boolean }): boolean {
  const label = agentLabel(agent);
  if (getRun(pc.projectId, agent)) {
    notify(`${label} is still working — wait for the task to finish before clearing`);
    return false;
  }
  if (pc.resetting.has(agent)) return false;
  const chat = pc.chats.get(agent);
  if (!chat?.session_id && !chat?.continuation && !pc.contextTokens.has(agent)) {
    notify(`No conversation context with ${label} to clear`);
    return false;
  }
  // Documented exception (story 005-004): native confirm(), as with delete.
  if (opts.confirm && !window.confirm(
    `Start a fresh conversation with ${label}?\n\nIt will no longer remember this chat. Your files and drafts are unaffected.\nKuhn will scan the recent chat for open action items and carry a short hand-off note forward.`,
  )) return false;
  pc.contextTokens.delete(agent);
  pc.contextSuggested.delete(agent);
  dismissContextNotices(pc, agent);
  // A stale note card must not outlive two clears; the server drops its note too.
  pc.log.querySelectorAll(`.chat-notice-handoff[data-agent="${CSS.escape(agent)}"]`).forEach((el) => el.remove());
  const divider = document.createElement('div');
  divider.className = 'chat-divider';
  divider.textContent = `fresh conversation with ${label} — earlier chat context cleared`;
  tagConversation(pc, divider, agent);
  pc.log.append(divider);
  if (pc === current) updateContextIndicator();
  scrollLog(pc, true);
  void resetChatOnServer(pc, agent, opts.handoff !== false);
  return true;
}

/**
 * The server side of a fresh start (issue #113): reset the chat row — and,
 * unless the user opted out, have the server scan the recorded conversation
 * tail for a clear hand-off (STH-55: open question, agreed next step,
 * hard-won guidance) and park it as a note delivered with the next message.
 * "No hand-off" is a normal outcome and reads as starting clean; a failed
 * scan still resets the chat (the pre-STH-55 behaviour).
 */
async function resetChatOnServer(pc: ProjectChat, agent: string, handoff: boolean): Promise<void> {
  pc.resetting.add(agent);
  if (handoff) appendSystemLine(pc, `scanning the previous conversation with ${agentLabel(agent)} for open action items…`, 'info', agent);
  try {
    const chat = pc.chats.get(agent) ?? await getOrCreateChat(pc.projectId, agent);
    const result = await resetChat(chat.id, { handoff });
    pc.chats.set(agent, result.chat);
    if (result.handoff_error) {
      appendSystemLine(pc, `hand-off scan failed: ${result.handoff_error} — starting clean`, 'error', agent);
    } else if (handoff && !result.handoff) {
      appendSystemLine(pc, 'no open hand-off found — starting clean', 'info', agent);
    } else if (result.handoff) {
      showHandoffCard(pc, agent, result.handoff);
    }
  } catch (err) {
    appendSystemLine(pc, `could not start a fresh conversation with ${agentLabel(agent)}: ${(err as Error).message}`, 'error', agent);
  } finally {
    pc.resetting.delete(agent);
  }
}

/**
 * The hand-off card: the note parked on the chat, shown until the next
 * message to that agent carries it (the server splices it in) or the user
 * discards it. Rendered after a fresh start and again on load while a note
 * is still pending — including one parked from another tab.
 */
function showHandoffCard(pc: ProjectChat, agent: string, note: string): void {
  pc.log.querySelectorAll(`.chat-notice-handoff[data-agent="${CSS.escape(agent)}"]`).forEach((el) => el.remove());
  const card = document.createElement('div');
  card.className = 'chat-notice chat-notice-handoff';
  tagConversation(pc, card, agent);
  card.innerHTML =
    `<div class="notice-title">${icon('arrow-right', { size: 14, stroke: 2 })} Hand-off note — goes out with your next message to ${escapeHtml(agentLabel(agent))}</div>`;
  const body = document.createElement('div');
  body.className = 'handoff-note';
  body.textContent = note;
  card.append(body);
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'btn btn-quiet btn-sm notice-action';
  discard.textContent = 'Discard note';
  discard.addEventListener('click', () => {
    card.remove();
    const chat = pc.chats.get(agent);
    if (!chat) return;
    chat.pending_handoff = null;
    void patchChat(chat.id, { pending_handoff: null }).catch((err: Error) => {
      notify(`Could not discard the hand-off note: ${err.message}`);
    });
  });
  card.append(discard);
  pc.log.append(card);
  scrollLog(pc);
}

// Restore prior state on first visit (story 020): render the recent
// transcript from the conversation log, load the user's chats (issue #113:
// the server holds each agent's session, pin and parked hand-off), seed the
// context meter from recorded jobs, and re-attach to runs the server kept
// alive for this project (issue #113 item 2).
async function restore(pc: ProjectChat): Promise<void> {
  pc.restored = true;
  try {
    await restoreTranscript(pc);
    applyChatFilter(pc); // restored messages carry mixed conversation tags
    const [jobs, chatRows] = await Promise.all([listJobs(pc.projectId), listProjectChats(pc.projectId)]);
    for (const c of chatRows) pc.chats.set(c.agent_slug, c);
    primeChatPins(pc.projectId, chatRows);
    if (pc === current) void refreshModelPicker(); // the pill now knows the pins
    const seen = new Set<string>();
    for (const job of jobs) {
      // Jobs are newest first; the most recent per role speaks for the
      // conversation. Sub-agent dispatch jobs are skipped (STH-52): their
      // token counts describe a dispatched sub-task's context, not this
      // conversation's.
      if (job.parent_job_id != null) continue;
      if (!seen.has(job.role)) {
        seen.add(job.role);
        // context_tokens is the context that session carried into its last
        // reply — seed the meter so it survives a reload (STH-52), but only
        // while that session is still the chat's (a fresh start cleared it).
        // Chats predating #113 have no row: fall back to the job's session.
        // Older job rows predate the column; leave the meter unseeded rather
        // than fall back to cumulative input_tokens, which overstates context.
        const chat = pc.chats.get(job.role);
        const live = chat ? chat.current_job_id === job.id : Boolean(job.session_id);
        if (live && job.context_tokens > 0) pc.contextTokens.set(job.role, job.context_tokens);
      }
      // Newest job per role also says where it ran and why (issue #107), so
      // the chip survives a reload. Rows older than the columns show model
      // and profile only.
      if (!pc.agentModels.has(job.role) && (job.model || job.profile)) {
        pc.agentModels.set(job.role, {
          agent: job.role, label: agentLabel(job.role), model: job.model ?? null, profile: job.profile ?? null,
          source: job.route_source ?? undefined,
          difficulty: job.difficulty ?? undefined,
        });
      }
    }
    if (pc === current) {
      updateContextIndicator();
      updateModelIndicator();
    }
    restorePausedRuns(pc, jobs);
    // A note parked by a fresh start — here or in another tab — still awaits
    // the next message to that agent.
    for (const c of chatRows) if (c.pending_handoff) showHandoffCard(pc, c.agent_slug, c.pending_handoff);
    await reconnectLiveRuns(pc);
  } catch (err) {
    // A fresh project restores an *empty* transcript without erroring, so a
    // rejection here is a real failure — surface it non-blockingly instead of
    // swallowing it (story 005-004). Chat still works; history may be missing.
    notify(`Could not restore chat history: ${(err as Error).message}`);
  }
}

/**
 * Issue #110: a budget pause must survive a reload. The pause card is DOM-only
 * when it streams in, but the paused job row is durable — rebuild the card
 * (hand-off note + Resume) for every role whose MOST RECENT top-level job is
 * a budget pause. A newer job on that role means the pause was already
 * resumed or superseded by a fresh instruction, so no card.
 */
function restorePausedRuns(pc: ProjectChat, jobs: Job[]): void {
  const latestByRole = new Map<string, Job>();
  for (const job of jobs) { // newest first
    if (job.parent_job_id != null) continue;
    if (!latestByRole.has(job.role)) latestByRole.set(job.role, job);
  }
  const paused = [...latestByRole.values()]
    .filter((job) => job.status === 'error' && job.error === BUDGET_EXCEEDED_ERROR)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const job of paused) {
    // The row carries whose budget and when it resets (issue #129 item 3),
    // so the rebuilt card matches the one that streamed in.
    appendBudgetNotice(pc, {
      agent: job.role, jobId: job.id, handoff: job.handoff, isoTime: job.created_at,
      scope: job.pause?.scope ?? 'task', period: job.pause?.period, resetsAt: job.pause?.resetsAt,
    });
  }
}

/**
 * Re-attach to the runs the server kept alive for this project (issue #113
 * item 2; story 027 for the parked-on-a-question case): a reload or a
 * project switch in another tab left them streaming with nobody attached.
 * Each becomes a run in the registry; the server re-emits a pending
 * question, then what buffered meanwhile, then the live events.
 */
async function reconnectLiveRuns(pc: ProjectChat, attempt = 0): Promise<void> {
  const live = await getLiveRuns(pc.projectId);
  // A run still attached elsewhere is another tab's to stream — unless it is
  // this tab's own stream from before a reload, which the server notices a
  // moment after the page went away: look once more.
  if (attempt === 0 && live.some((r) => r.attached && !getRun(pc.projectId, r.role))) {
    setTimeout(() => { if (projects.get(pc.projectId) === pc) void reconnectLiveRuns(pc, 1); }, 1500);
  }
  for (const r of live) {
    if (r.attached || getRun(pc.projectId, r.role)) continue;
    const waiting = r.status === 'waiting_for_user';
    const run = startRun({
      projectId: pc.projectId, agent: r.role, kind: 'reconnect',
      activity: waiting ? `${agentLabel(r.agent)} is waiting for your answer…` : `${agentLabel(r.role)} is working…`,
    });
    run.tracker.reset(r.jobId);
    run.onEvent = createEventHandler(pc, run);
    renderRunStatus();
    void (async () => {
      try {
        await reconnectAgent(r.jobId, run.onEvent, run.abort.signal);
      } catch (err) {
        await handleRunFailure(pc, run, err);
      } finally {
        finishRun(pc, run);
      }
    })();
  }
}

async function restoreTranscript(pc: ProjectChat): Promise<void> {
  const conversations = await getConversations(pc.projectId);
  // Newest conversation first from the API; render oldest → newest
  const messages = conversations
    .reverse()
    .flatMap((c) => c.messages.map((m) => ({ ...m, agent: c.agent_slug })));
  if (messages.length === 0) {
    // Greet only on a brand-new, unseeded project. An already-configured project
    // with an empty transcript (its seeding ran before chat logging, or its
    // history was cleared) must not re-offer the interview. Also skip if seeding
    // has already auto-started on open — the live pipeline is the greeting then.
    if (!getRun(pc.projectId, 'pm') && !pc.seeded) appendGreeting(pc);
    return;
  }

  appendDivider(pc, 'session restored', messages[0].created_at);
  for (const message of messages) {
    if (message.role === 'user') {
      appendUserMessage(pc, message.content, message.agent);
    } else {
      const { body } = appendAgentMessage(pc, message.agent, message.created_at);
      renderAgentBody(body, message.agent, message.content);
      pc.restoredTexts.add(`${message.agent}\n${message.content}`);
    }
  }
}

/**
 * Handle a streamed AgentEvent for one run, shared by chat sends, re-attached
 * runs and the seeding pipeline. Keeps one streaming bubble per assistant
 * turn; a new delta after a finalized turn (or from a different agent) starts
 * a new bubble. Renders into the run's own project log, whether or not that
 * project is in view; the status bar and composer are updated only when the
 * run's chat is the one in view.
 */
function createEventHandler(pc: ProjectChat, run: ChatRun): (event: AgentEvent) => void {
  let wrapper: HTMLElement | null = null;
  let body: HTMLElement | null = null;
  let bubbleAgent = '';
  let streamed = '';
  const owner = run.agent;

  const ensureBubble = (agent: string): HTMLElement => {
    if (!body || bubbleAgent !== agent) {
      const created = appendAgentMessage(pc, agent, new Date().toISOString(), owner);
      wrapper = created.wrapper;
      body = created.body;
      bubbleAgent = agent;
      streamed = '';
      setActive(wrapper, true); // it's streaming → role color
    }
    return body;
  };

  const finalize = (): void => {
    if (wrapper) setActive(wrapper, false);
    wrapper = null;
    body = null;
  };

  // A file change from a background run waits for the project to be mounted
  // again: main.ts's handler drives the files panel and editor of the ACTIVE
  // project only.
  const deliverFileChange = (change: FileChange): void => {
    if (pc === current) pc.onFileChange(change);
    else pc.deferredFileChanges.push(change);
  };

  return (event: AgentEvent): void => {
    switch (event.type) {
      case 'text_delta': {
        const node = ensureBubble(event.agent);
        streamed += event.content ?? '';
        node.textContent = streamed;
        scrollLog(pc);
        break;
      }
      case 'text': {
        // A re-attached run replays the turns that buffered while nobody was
        // attached; the ones that also made it into the restored transcript
        // are already on screen.
        if (run.kind === 'reconnect' && !body && pc.restoredTexts.has(`${event.agent}\n${event.content ?? ''}`)) break;
        // Final turn text: replace accumulated deltas with rendered markdown
        const node = ensureBubble(event.agent);
        renderAgentBody(node, event.agent, event.content ?? '');
        finalize();
        scrollLog(pc);
        break;
      }
      case 'file_change': {
        // A move is one line, "moved A → B" (story 012-002) — never a
        // delete+create pair. `from` must ride along on the change too: this
        // channel is live exactly when the project feed is down, and without
        // it the open editor can't retarget and its next autosave resurrects
        // the old path.
        const from = event.kind === 'moved' ? event.meta?.from : undefined;
        appendSystemLine(pc, from
          ? `${event.agent} moved ${from} → ${event.path}`
          : `${event.agent} ${event.kind ?? 'changed'} ${event.path}`, 'info', owner);
        if (event.path) {
          deliverFileChange({ path: event.path, kind: event.kind, agent: event.agent, from });
        }
        break;
      }
      case 'citation': {
        appendSystemLine(pc, `${event.agent} added citation [@${event.key}]`, 'info', owner);
        if (event.path) deliverFileChange({ path: event.path, kind: 'update', agent: event.agent });
        break;
      }
      case 'question': {
        // The agent is blocked waiting for an answer: render the question card
        // and switch the input box into answer mode (when this chat is in view).
        finalize();
        run.questionCard = new QuestionCard(event.agent, event.content ?? '', { onStop: () => void stopRun(run) });
        tagConversation(pc, run.questionCard.element, owner);
        pc.log.append(run.questionCard.element);
        run.pendingQuestionJobId = event.jobId ?? null;
        setRunActivity(run, `${agentLabel(event.agent)} is waiting for your answer…`);
        renderComposer(); // answer mode: the button sends the reply again
        if (inView(run)) (document.getElementById('chat-input') as HTMLTextAreaElement).focus();
        scrollLog(pc);
        break;
      }
      case 'question_expired': {
        if (run.pendingQuestionJobId === event.jobId) {
          run.questionCard?.markExpired();
          run.questionCard = null;
          exitAnswerMode(run);
        }
        updateRunActivity(run);
        break;
      }
      case 'stage': {
        // Seeding pipeline progress (story 015) → the seeding panel.
        if (!applyStage(event)) {
          const label = STAGE_LABELS[event.stage ?? ''] ?? event.stage;
          if (event.status === 'error') appendSystemLine(pc, `${label} failed${event.detail ? `: ${event.detail}` : ''}`, 'error', owner);
        }
        if (event.status === 'start') setRunActivity(run, `seeding: ${STAGE_LABELS[event.stage ?? ''] ?? event.stage}…`);
        break;
      }
      case 'notice': {
        // Transient model-provider error: the runtime is backing off and will
        // retry automatically. Show a visible "retrying…" status so the wait
        // isn't an ambiguous silent spinner (story 029).
        if (event.reason === 'provider_overloaded') {
          const secs = event.nextRetryMs ? Math.round(event.nextRetryMs / 1000) : 0;
          setRunActivity(run,
            `${agentLabel(event.agent)} paused — model provider busy, retrying${secs ? ` in ${secs}s` : ''}`
            + ` (${event.attempt}/${event.maxAttempts})…`,
          );
          if (inView(run)) notify('Model provider is busy — retrying automatically…');
        } else if (event.reason === 'session_reconstructed') {
          // The provider dropped the session we asked to resume (issue #109
          // — typically after a budget stop); the runtime continues in a
          // fresh one seeded from Kuhn's transcript. The `done` event
          // carries the new session id, which replaces the dead one.
          appendSystemLine(pc, event.message ?? 'Previous session unavailable — continuing in a fresh session.', 'info', owner);
        } else if (event.reason === 'budget_reached') {
          // The budget stopped the run; the pause card follows once the
          // hand-off note is written (issue #110) — name the wait.
          setRunActivity(run, `${agentLabel(event.agent)} reached its token budget — writing a hand-off note…`);
        }
        break;
      }
      case 'model': {
        // Which model this job (the addressed agent's, or a dispatched
        // sub-agent's) was routed to, and at what difficulty (issue #107).
        // It is also the first event a job emits: the job is now running.
        if (event.model) {
          const chip: ModelChip = { agent: event.agent, label: agentLabel(event.agent), ...event.model };
          run.runModels.push(chip);
          if (!event.depth) pc.agentModels.set(event.agent, chip);
          run.tracker.start({ jobId: event.jobId ?? null, agent: event.agent, depth: event.depth ?? 0, chip });
          updateRunActivity(run);
          if (inView(run)) updateModelIndicator();
        }
        break;
      }
      case 'job': {
        // A dispatched sub-agent's job ended (issue #137) — its own 'done' is
        // not forwarded. The indicators fall back to the dispatcher.
        if (event.status && event.status !== 'started') {
          run.tracker.end(event.jobId, { agent: event.agent, depth: event.depth ?? 1 });
          updateRunActivity(run);
          if (inView(run)) updateModelIndicator();
        }
        break;
      }
      case 'cancelled': {
        // The user stopped the run (issue #136). The chat row keeps the
        // session, so the next message picks up exactly where the agent stopped.
        finalize();
        if (event.budget) setBudget(event.budget.used, event.budget.limit);
        run.tracker.end(event.jobId);
        if (!event.depth) appendStopped(pc, owner, event.agent);
        if (inView(run)) updateModelIndicator();
        break;
      }
      case 'context': {
        // Live context-window state (STH-52). Sub-agent 'context' events
        // (forwarded by dispatch under the child's slug) describe their own
        // fresh sessions — only the addressed agent's belongs on the meter.
        if (event.context) {
          if (event.context.window) contextWindow = event.context.window;
          if (event.agent === owner) {
            pc.contextTokens.set(event.agent, event.context.tokens);
            if (pc === current) updateContextIndicator();
          }
        }
        break;
      }
      case 'done': {
        if (event.usage) addTokenUsage(event.usage);
        // The done event fires for the addressed role's job (issue #43).
        // Assess on the LAST TURN's context (what the session actually
        // carries forward), never usage.inputTokens — that one accumulates
        // across turns (cache reads re-counted every turn) and overstates
        // context wildly on tool-heavy runs.
        if (event.context?.tokens) {
          assessContext(pc, owner, event.context.tokens);
        }
        if (event.budget) setBudget(event.budget.used, event.budget.limit);
        if (event.jobId != null) {
          // A seeding stage's job (or the addressed agent's) ended.
          run.tracker.end(event.jobId);
          updateRunActivity(run);
          if (inView(run)) updateModelIndicator();
        }
        break;
      }
      case 'error': {
        finalize();
        if (event.budget) setBudget(event.budget.used, event.budget.limit);
        if (event.jobId != null) {
          run.tracker.end(event.jobId);
          updateRunActivity(run);
          if (inView(run)) updateModelIndicator();
        }
        if (event.reason === 'budget_exceeded') {
          // The chat row keeps the session, so a follow-up resumes this exact conversation.
          // The pause card belongs to the user's own run. A dispatched
          // sub-agent's cutoff (forwarded under the child's slug) is a
          // line — the parent's own cutoff, with the hand-off note, follows.
          if (event.jobId != null && event.agent === owner) {
            appendBudgetNotice(pc, {
              agent: event.agent, jobId: event.jobId, handoff: event.handoff ?? null,
              scope: event.budget?.scope ?? 'task', period: event.period, resetsAt: event.resetsAt,
            });
          } else {
            appendSystemLine(pc, `${agentLabel(event.agent)} reached the token budget.`, 'error', owner);
          }
        } else if (event.reason === 'budget_exhausted') {
          // An org budget (the user's or the project's) is already used up,
          // so no run started (issue #110): explain, no Resume to offer.
          appendBudgetExhaustedNotice(pc, event, owner);
        } else if (event.reason === 'provider_overloaded') {
          // Transient upstream failure that outlasted the runtime's retries —
          // the chat row keeps the session so a chat "Try again" resumes it;
          // offer a one-click retry of the original action (story 029).
          appendOverloadNotice(pc, owner);
        } else if (event.reason === 'route_invalid') {
          // The pinned model is no longer on this agent's route (issue #134)
          // — drop the pin so the next message falls back to the route.
          if (event.profile && pinnedProfile(pc.projectId, owner) === event.profile) {
            clearPinnedProfile(pc.projectId, owner);
          }
          appendSystemLine(pc, event.message ?? 'agent error', 'error', owner);
        } else {
          appendSystemLine(pc, event.message ?? 'agent error', 'error', owner);
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
  const pc = current;
  if (!pc || !canUseComposer()) return; // view-only chrome; the server 403s too
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const role = selectedAgent();
  const text = input.value.trim();
  if (!text) return;

  // Answer mode: route the input to the job waiting on ask_user. The reply
  // unblocks the agent; its events keep arriving on the original stream.
  const run = getRun(pc.projectId, role);
  if (run?.pendingQuestionJobId != null) {
    const jobId = run.pendingQuestionJobId;
    exitAnswerMode(run);
    input.value = '';
    autoGrow(input);
    appendUserMessage(pc, text, role);
    run.questionCard?.markAnswered(text);
    run.questionCard = null;
    setRunActivity(run, `${agentLabel(role)} is working…`);
    try {
      await replyToAgent(jobId, text);
    } catch (err) {
      // 409: the question is gone (timed out or its task ended) — story 020
      const message = (err as Error).message;
      if (/no pending question/i.test(message)) {
        appendSystemLine(pc, 'that question is no longer waiting for an answer (it may have timed out) — your reply was not delivered', 'error', role);
        setRunActivity(run, '');
      } else {
        appendSystemLine(pc, message, 'error', role);
      }
    }
    return;
  }

  if (run) return; // this chat is busy: the button is Stop
  if (pc.resetting.has(role)) {
    notify(`${agentLabel(role)}'s fresh start is still being set up — one moment`);
    return;
  }
  input.value = '';
  autoGrow(input);

  appendUserMessage(pc, text, role);
  // STH-55: a parked hand-off note goes out with this message — the server
  // splices it ahead of the input (issue #113) — so retire the card's
  // discard button here.
  const chat = pc.chats.get(role);
  if (chat?.pending_handoff) {
    chat.pending_handoff = null;
    pc.log.querySelector(`.chat-notice-handoff[data-agent="${CSS.escape(role)}"] .notice-action`)?.remove();
  }
  pc.retryAction = () => dispatchTask(pc, role, text);
  await dispatchTask(pc, role, text);
}

/**
 * The folder selected in the file panel, as agent context — but ONLY when it
 * sits inside `draft/` (story 012-001).
 *
 * Why the restriction: `isProposable` (agent-backend/src/pending-edits.js)
 * gates the suggestion/review loop: a NEW file is a reviewable proposal only
 * under `draft/`; anywhere else it lands on disk immediately (existing files
 * are proposals everywhere outside agent-private folders — STH-44). So hinting
 * an agent toward a non-draft folder for new files would silently downgrade a
 * reviewable proposal into a direct write — a change to the trust loop
 * disguised as a convenience.
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
 * Editor context sent with every chat turn (STH-43): the document the user
 * has open, so "do a full pass on the doc" resolves to what they are looking
 * at rather than draft/main.md by default — plus the draft-folder hint above.
 * The backend relays the open document to any sub-agent the PM dispatches.
 */
function taskContext(): AgentTaskParams['context'] {
  const activeDocument = workspace.activeDocPath() || undefined;
  const dir = draftTargetContext();
  if (!activeDocument && !dir) return undefined;
  return { ...dir, activeDocument };
}

/**
 * Run a single chat turn. Separated from send() so the user message is appended
 * once but the run itself can be re-invoked by "Try again" after a transient
 * overload (story 029). The server resolves the chat from role + project and
 * resumes the session recorded on it (issue #113). The run belongs to its
 * project's log and keeps streaming if the user switches projects meanwhile.
 */
async function dispatchTask(pc: ProjectChat, role: string, text: string): Promise<void> {
  if (getRun(pc.projectId, role)) return;
  const run = startRun({ projectId: pc.projectId, agent: role, kind: 'chat', activity: `${agentLabel(role)} is working…` });
  run.onEvent = createEventHandler(pc, run);
  renderRunStatus();
  // The user steered the paused agent with their own instruction (issue
  // #110): that supersedes the pause — retire its Resume affordance.
  retireBudgetCards(pc, role, 'superseded by your instruction');

  try {
    await runAgentTask(
      {
        role,
        projectId: pc.projectId,
        input: text,
        context: taskContext(),
        // The user's pick for this agent (issue #134); absent → the route decides.
        profile: pinnedProfile(pc.projectId, role) ?? undefined,
      },
      run.onEvent,
      run.abort.signal,
    );
  } catch (err) {
    // STH-48: a dropped stream must not surface as an error while the run is
    // still alive on the server (parked on a question, or — since issue #113
    // item 2 — any chat turn): re-attach to it instead.
    await handleRunFailure(pc, run, err);
  } finally {
    finishRun(pc, run);
  }
}

/** Run the seeding pipeline (story 015) for the active project, narrated by the seeding panel. */
export async function startSeeding(): Promise<void> {
  if (current) await startSeedingFor(current);
}

async function startSeedingFor(pc: ProjectChat): Promise<void> {
  if (getRun(pc.projectId, 'pm')) return;
  if (seedingActive()) {
    // The seeding panel narrates one pipeline at a time.
    notify('Another project is still seeding — wait for it to finish');
    return;
  }
  if (!canUseComposer()) {
    notify('View only — seeding a project needs the editor role');
    return;
  }
  // "Try again" after a transient overload re-runs the whole seeding pipeline —
  // the correct retry for a new-doc request, which is not a resumable chat turn.
  pc.retryAction = () => startSeedingFor(pc);
  // Seeding is the PM-led interview conversation.
  const run = startRun({ projectId: pc.projectId, agent: 'pm', kind: 'seeding', activity: 'seeding…' });
  run.onEvent = createEventHandler(pc, run);
  // The interview is starting — drop the empty-state greeting card so its
  // "Start project interview" CTA doesn't linger alongside the live pipeline.
  pc.log.querySelector('.chat-msg.is-greeting')?.remove();
  showSeedingPanel();
  renderRunStatus();

  try {
    await seedProject(pc.projectId, run.onEvent, run.abort.signal);
  } catch (err) {
    // Stop during seeding aborts the stream (the pipeline has no addressable
    // job); the server tears the stage down on disconnect.
    if (run.stopping) appendStopped(pc, 'pm');
    else appendSystemLine(pc, (err as Error).message, 'error', 'pm');
  } finally {
    completeSeeding();
    finishRun(pc, run);
  }
}

/**
 * STH-48: recover from a dropped event stream while the run is still alive on
 * the server.
 *
 * The ask_user wait is indefinite by design, but the SSE response carrying it
 * can die (idle timeouts, network blips). The run itself survives on the
 * server — a detachable run parked on a question is left alive (story 027),
 * and since issue #113 item 2 so is every chat turn — so the right response
 * is to re-attach, not to render the question card as expired and print
 * `network error`. Re-attaching keeps the original session (and its context).
 *
 * Retries with backoff — the server may not have noticed the disconnect yet,
 * so reconnect can 409 until it does. Returns true when the run was
 * re-attached and its stream ran to completion; false when the run is truly
 * gone and the caller should surface the original error.
 */
async function resumeAfterStreamDrop(run: ChatRun): Promise<boolean> {
  const jobId = run.pendingQuestionJobId ?? run.tracker.rootJobId;
  if (jobId == null || run.kind === 'seeding') return false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (run.abort.signal.aborted) return false;
    setRunActivity(run, 'Connection lost — reconnecting…');
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15_000)));
    try {
      await reconnectAgent(jobId, run.onEvent, run.abort.signal);
      return true; // re-attached; the stream ran to completion
    } catch (err) {
      const message = (err as Error).message;
      // 404 "no live run": the run has actually ended — nothing to resume.
      // 403: it is not ours to attach to.
      if (/no live run|not your run/i.test(message)) return false;
      // 409 (previous consumer not yet detached) or transient failure: retry.
    }
  }
  return false;
}

function finishRun(pc: ProjectChat, run: ChatRun): void {
  endRun(run);
  run.stopping = false;
  run.activity = '';
  pc.lastRunModels.set(run.agent, run.runModels);
  void refreshChats(pc);
  // The task is over — an unanswered question can no longer be replied to
  if (run.pendingQuestionJobId != null) {
    run.questionCard?.markExpired();
    run.questionCard = null;
    run.pendingQuestionJobId = null;
  }
  renderRunStatus();
  if (pc === current) {
    // The owner may have changed the routes meanwhile (issue #134).
    void refreshModelPicker({ fresh: true });
    notify('');
  }
}

function exitAnswerMode(run: ChatRun): void {
  run.pendingQuestionJobId = null;
  renderComposer(); // restores the role-appropriate placeholder + state
}

// ---- Rendering ------------------------------------------------------------

/** Re-read the project's chat rows (after a run: the server created or
 * advanced the addressed agent's chat). Failures are silent — the mirror only
 * gates the fresh-start button and names chat ids; the server stays right. */
async function refreshChats(pc: ProjectChat): Promise<void> {
  try {
    const rows = await listProjectChats(pc.projectId);
    for (const c of rows) pc.chats.set(c.agent_slug, c);
    primeChatPins(pc.projectId, rows);
  } catch {
    // see above
  }
}

function agentLabel(slug: string): string {
  return agentIdentity(slug).label || slug;
}

interface AgentBubble {
  wrapper: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
}

function appendAgentMessage(pc: ProjectChat, slug: string, isoTime: string, owner: string = slug): AgentBubble {
  const id = agentIdentity(slug);

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-agent';
  wrapper.style.setProperty('--role', `var(${id.colorVar})`);
  tagConversation(pc, wrapper, owner);

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
  pc.log.append(wrapper);
  scrollLog(pc);
  return { wrapper, head, body };
}

function appendUserMessage(pc: ProjectChat, text: string, owner?: string): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-user';
  tagConversation(pc, wrapper, owner);
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
  pc.log.append(wrapper);
  scrollLog(pc, true);
}

/** Toggle the single-active-agent color treatment on a message. */
function setActive(wrapper: HTMLElement, on: boolean): void {
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
  body.innerHTML = renderMarkdown(markdown);
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
    (item.querySelector('span:last-child') as HTMLElement).innerHTML = renderInlineMarkdown(b);
    list.append(item);
  }
  card.append(head, list);
  body.append(card);
}

/** Empty-state PM welcome (story 025 screen 3): invites the user to seed. */
function appendGreeting(pc: ProjectChat): void {
  const id = agentIdentity('pm');
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-agent is-greeting';
  wrapper.style.setProperty('--role', `var(${id.colorVar})`);
  tagConversation(pc, wrapper, 'pm');

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
  cta.addEventListener('click', () => setupHandler(pc.projectId));
  body.append(cta);

  main.append(head, body);
  wrapper.append(avatar, main);
  pc.log.append(wrapper);
}

function appendDivider(pc: ProjectChat, label: string, isoTime?: string): void {
  const div = document.createElement('div');
  div.className = 'chat-divider';
  const time = isoTime ? `<span class="mono">${clockOf(isoTime)}</span> · ` : '';
  div.innerHTML = `${time}${label}`;
  pc.log.append(div);
  scrollLog(pc);
}

function appendSystemLine(pc: ProjectChat, text: string, variant: 'info' | 'error' = 'info', owner?: string | null): void {
  const line = document.createElement('div');
  line.className = `chat-system chat-system-${variant}`;
  line.textContent = text;
  tagConversation(pc, line, owner); // owned by the conversation it belongs to, if any
  pc.log.append(line);
  scrollLog(pc);
}

/**
 * Budget-pause card (issue #110): the hand-off note the pause wrote, what
 * resuming does, and a one-click Resume. Rendered live from the
 * `budget_exceeded` error event and rebuilt from the paused job row after a
 * reload (restorePausedRuns), so the pause and its affordance survive.
 */
const PERIOD_ADJECTIVE: Record<string, string> = { day: 'daily', week: 'weekly', month: 'monthly' };

function resetWhen(iso: string | undefined): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'at the start of the next period';
}

function appendBudgetNotice(pc: ProjectChat, { agent, jobId, handoff, isoTime, scope = 'task', period, resetsAt }: {
  agent: string; jobId: number; handoff: string | null; isoTime?: string;
  scope?: 'task' | 'user' | 'project'; period?: string; resetsAt?: string;
}): void {
  const label = escapeHtml(agentLabel(agent)); // spliced into innerHTML below
  const card = document.createElement('div');
  card.className = 'chat-notice chat-notice-budget';
  card.dataset.jobId = String(jobId);
  tagConversation(pc, card, agent);
  const when = isoTime ? ` <span class="notice-time mono">${clockOf(isoTime)}</span>` : '';
  const note = handoff
    ? `<div class="notice-subtitle">Hand-off note</div><div class="handoff-note">${renderMarkdown(handoff)}</div>`
    : '<p class="notice-muted">No hand-off note could be written for this pause.</p>';
  // Whose budget: the per-task one (Resume gets a fresh one) or an org
  // budget on the user / project (issue #110 parts 3–4: Resume works once
  // it resets, or an owner resets it).
  const orgScope = scope === 'user' || scope === 'project';
  const title = orgScope
    ? `${scope === 'user' ? 'Your' : 'This project’s'} ${escapeHtml(PERIOD_ADJECTIVE[period ?? ''] ?? '')} token budget is used up — task paused`
    : 'Token budget reached — task paused';
  const resume = orgScope
    ? `<p>The budget resets ${escapeHtml(resetWhen(resetsAt))}; an organization owner can raise or reset it sooner. ` +
      `Resuming before then pauses again at once. When you resume, ${label} gets this note and continues the same ` +
      `conversation — or, if the model provider has since dropped the session, picks up from Kuhn's own transcript of it.</p>`
    : `<p>Resuming starts a new run with a fresh budget: ${label} gets this note and continues the same ` +
      `conversation — or, if the model provider has since dropped the session, picks up from Kuhn's own ` +
      `transcript of it. Or send your own instruction to steer the rest of the work.</p>`;
  card.innerHTML =
    `<div class="notice-title">${icon('clock', { size: 14, stroke: 2 })} ${title}${when}</div>` +
    `<p>Nothing is lost. Any files ${label} already wrote are saved (check the Files panel), and ` +
    `this conversation is preserved.</p>` +
    note +
    resume;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-accent btn-sm notice-action';
  btn.innerHTML = `Resume ${label} ${icon('arrow-right', { size: 13, stroke: 2 })}`;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void continueAfterBudget(pc, agent, jobId);
  });
  card.append(btn);
  pc.log.append(card);
  scrollLog(pc);
}

/**
 * An org budget was already used up when the task was sent (issue #110
 * parts 3–4): nothing ran, so there is nothing to resume — say when it
 * resets and who can reset it.
 */
function appendBudgetExhaustedNotice(pc: ProjectChat, event: AgentEvent, owner: string): void {
  const card = document.createElement('div');
  card.className = 'chat-notice chat-notice-budget';
  tagConversation(pc, card, owner);
  const scope = event.budget?.scope === 'project' ? 'This project’s' : 'Your';
  const used = event.budget ? ` (${Math.round(event.budget.used).toLocaleString()} of ${event.budget.limit.toLocaleString()} tokens)` : '';
  card.innerHTML =
    `<div class="notice-title">${icon('clock', { size: 14, stroke: 2 })} ${scope} ${escapeHtml(PERIOD_ADJECTIVE[event.period ?? ''] ?? '')} token budget is used up</div>` +
    `<p>The task was not started${escapeHtml(used)}. It resets ${escapeHtml(resetWhen(event.resetsAt))}; ` +
    'an organization owner can raise the budget or reset the usage sooner (Organization → Budgets).</p>';
  pc.log.append(card);
  scrollLog(pc);
}

/**
 * Retire the Resume affordance on an agent's pause cards (issue #110): the
 * pause was resumed, or a fresh instruction superseded it. The card itself
 * stays — the hand-off note is still the record of where the run stopped.
 */
function retireBudgetCards(pc: ProjectChat, agent: string, outcome: string, jobId?: number): void {
  const selector = jobId != null
    ? `.chat-notice-budget[data-job-id="${jobId}"]`
    : `.chat-notice-budget[data-agent="${CSS.escape(agent)}"]`;
  for (const card of Array.from(pc.log.querySelectorAll<HTMLElement>(selector))) {
    const btn = card.querySelector('.notice-action');
    if (!btn) continue;
    const done = document.createElement('div');
    done.className = 'notice-muted';
    done.textContent = `Paused run ${outcome}.`;
    btn.replaceWith(done);
  }
}

/**
 * Transient-overload notice (story 029). The model provider returned a 529 (or
 * similar) that outlasted the runtime's automatic retries. The work is safe; the
 * one-click action re-runs the original request — the chat turn (resuming the
 * session) or the seeding pipeline, whichever failed.
 */
function appendOverloadNotice(pc: ProjectChat, owner: string): void {
  const card = document.createElement('div');
  card.className = 'chat-notice chat-notice-overload';
  tagConversation(pc, card, owner);
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
    void retryLast(pc);
  });
  card.append(btn);
  pc.log.append(card);
  scrollLog(pc);
}

/** Re-run the last user-initiated action in the project (chat turn or seeding) — story 029. */
async function retryLast(pc: ProjectChat): Promise<void> {
  if (!pc.retryAction) {
    appendSystemLine(pc, 'Nothing to retry.', 'error');
    return;
  }
  await pc.retryAction();
}

/**
 * Resume a budget-paused run (issue #110). The server builds the prompt from
 * the hand-off note stored on the paused job and resumes its session with a
 * fresh budget; a dead session falls back to Kuhn's transcript (issue #109).
 */
async function continueAfterBudget(pc: ProjectChat, agent: string, jobId: number): Promise<void> {
  if (getRun(pc.projectId, agent)) return;
  retireBudgetCards(pc, agent, 'resumed', jobId);
  appendSystemLine(pc, `Resuming ${agentLabel(agent)} from the hand-off note…`, 'info', agent);
  const run = startRun({ projectId: pc.projectId, agent, kind: 'resume', activity: `${agentLabel(agent)} is working…` });
  run.onEvent = createEventHandler(pc, run);
  renderRunStatus();
  pc.retryAction = () => continueAfterBudget(pc, agent, jobId);
  try {
    await resumeJob(jobId, taskContext(), run.onEvent, run.abort.signal);
  } catch (err) {
    await handleRunFailure(pc, run, err);
  } finally {
    finishRun(pc, run);
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

/**
 * Follow new content to the bottom of the log — unless the user has
 * scrolled back into the history (STH-50). While parked, appended content
 * reveals the “new messages” pill instead. `force` marks user actions
 * (sending, the pill, filter/agent switches, fresh starts) that re-engage
 * following regardless of scroll position. A background project's log
 * scrolls too (it is laid out once mounted); the pill is the mounted one's.
 */
function scrollLog(pc: ProjectChat, force = false): void {
  if (force) setStickToBottom(pc, true);
  if (pc.stickToBottom) {
    pc.log.scrollTop = pc.log.scrollHeight;
  } else if (pc === current) {
    const pill = document.getElementById('chat-jump');
    if (pill) pill.hidden = false;
  }
}

function setStickToBottom(pc: ProjectChat, on: boolean): void {
  pc.stickToBottom = on;
  if (on && pc === current) {
    const pill = document.getElementById('chat-jump');
    if (pill) pill.hidden = true;
  }
}

/** Test/diagnostic hook: every run in flight across projects. */
export function liveRuns(): ChatRun[] {
  return allRuns();
}

/**
 * Bring a chat's pending question into view (issue #113 item 4: the
 * waiting-on-you marker jumps here). The caller has already switched the
 * project and selected the agent; the card may still be on its way — a
 * project visited for the first time restores its transcript and re-attaches
 * to the parked run asynchronously — so this waits for it briefly.
 */
export function revealQuestion(projectId: number, agent: string): void {
  const started = Date.now();
  const attempt = (): void => {
    const pc = projects.get(projectId);
    const run = getRun(projectId, agent);
    const card = run?.questionCard?.element ?? pc?.log.querySelector<HTMLElement>(`.question-card.is-pending[data-agent="${CSS.escape(agent)}"]`) ?? null;
    if (pc && pc === current && card) {
      setStickToBottom(pc, true);
      card.scrollIntoView({ block: 'center' });
      (document.getElementById('chat-input') as HTMLTextAreaElement | null)?.focus();
      return;
    }
    if (Date.now() - started < 8000) setTimeout(attempt, 150);
  };
  attempt();
}
