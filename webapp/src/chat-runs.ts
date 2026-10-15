// Client run registry (issue #113 item 2). One in-flight agent run per chat
// — the user's thread with one agent in one project — instead of the single
// `running` flag the chat panel used to keep. A run holds the stream's abort
// handle, the job tracker the status bar reads (issues #136/#137), and the
// ask_user state of the composer's answer mode. Runs are keyed by project and
// agent, so switching projects leaves every stream open: the run keeps
// rendering into its own project's log and the user finds it where they
// left it. Pure state, no DOM (the question card is held, not rendered).

import type { AgentEvent } from './api';
import type { QuestionCard } from './question-card';
import { RunTracker } from './run-tracker';
import type { ModelChip } from './status';

/** What started the run: a chat turn, the seeding pipeline, a budget resume, or a re-attach after a reload. */
export type RunKind = 'chat' | 'seeding' | 'resume' | 'reconnect';

export interface ChatRun {
  projectId: number;
  /** The addressed agent — the conversation everything the run renders belongs to ('pm' for seeding). */
  agent: string;
  kind: RunKind;
  /** Aborts the event stream: the fallback Stop (no job yet) and the only Stop for seeding. */
  abort: AbortController;
  /** The run's jobs in flight; `rootJobId` is what Stop addresses. */
  tracker: RunTracker;
  /** Every job the run started, in order, for the model chip's tooltip. */
  runModels: ModelChip[];
  /** A Stop request is in flight. */
  stopping: boolean;
  /** The job parked on an ask_user question, while the composer answers it. */
  pendingQuestionJobId: number | null;
  questionCard: QuestionCard | null;
  /** Status-bar text while this run is the one in view. */
  activity: string;
  /** The stream's event handler (kept so a re-attach after a drop reuses it). */
  onEvent: (event: AgentEvent) => void;
}

const runs = new Map<string, ChatRun>();
const key = (projectId: number, agent: string): string => `${projectId}:${agent}`;

/** Register a new run for (project, agent). Throws if one is already in flight — callers check first. */
export function startRun(init: Pick<ChatRun, 'projectId' | 'agent' | 'kind'> & Partial<Pick<ChatRun, 'activity'>>): ChatRun {
  const k = key(init.projectId, init.agent);
  if (runs.has(k)) throw new Error(`a run is already in flight for ${k}`);
  const run: ChatRun = {
    projectId: init.projectId,
    agent: init.agent,
    kind: init.kind,
    abort: new AbortController(),
    tracker: new RunTracker(),
    runModels: [],
    stopping: false,
    pendingQuestionJobId: null,
    questionCard: null,
    activity: init.activity ?? '',
    onEvent: () => {},
  };
  runs.set(k, run);
  return run;
}

/** The run ended (stream closed, however it closed). */
export function endRun(run: ChatRun): void {
  if (runs.get(key(run.projectId, run.agent)) === run) runs.delete(key(run.projectId, run.agent));
}

export function getRun(projectId: number, agent: string): ChatRun | null {
  return runs.get(key(projectId, agent)) ?? null;
}

/** Every run in flight for a project, in start order. */
export function projectRuns(projectId: number): ChatRun[] {
  return [...runs.values()].filter((r) => r.projectId === projectId);
}

/** Every run in flight, any project. */
export function allRuns(): ChatRun[] {
  return [...runs.values()];
}
