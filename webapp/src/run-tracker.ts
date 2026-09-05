// Which jobs a chat run has in flight (issues #136, #137). A run is the
// addressed agent's job plus whatever it dispatches; the status bar follows
// the INNERMOST running job — the sub-agent that is actually producing
// output — and falls back to its dispatcher when it ends. The root job id
// is what a Stop request addresses (POST /api/agent/jobs/:id/cancel).
//
// Fed by the run's events: a 'model' event opens a job (it is the first
// event a job emits and carries the routed model); a 'job' marker from
// dispatch_agent, or a terminal 'done' / 'error' / 'cancelled' carrying a
// job id, closes one. Pure state, no DOM — chat.ts renders from it.

import type { ModelChip } from './status';

export interface ActiveJob {
  jobId: number | null;
  agent: string;
  /** Dispatch depth: 0 for the addressed agent (or a seeding stage), 1+ for sub-agents. */
  depth: number;
  chip: ModelChip;
}

export class RunTracker {
  private stack: ActiveJob[] = [];
  /** The top-level job of the run — the one a Stop request names. */
  rootJobId: number | null = null;

  /** Forget everything; optionally seed the root (a reconnected run). */
  reset(rootJobId: number | null = null): void {
    this.stack = [];
    this.rootJobId = rootJobId;
  }

  /** A job started (its 'model' event arrived). */
  start(job: ActiveJob): void {
    if (job.depth === 0 && job.jobId != null && this.rootJobId == null) this.rootJobId = job.jobId;
    this.stack.push(job);
  }

  /**
   * A job ended. Closes it and any still-open job it dispatched (entries
   * opened after it at a greater depth); siblings at the same depth — the
   * seeding pipeline runs two research stages in parallel — are kept.
   * `fallback` closes the innermost job with that agent and depth when the
   * marker has no job id (a sub-agent refused before a job existed).
   * @returns false when nothing matched
   */
  end(jobId: number | null | undefined, fallback?: { agent: string; depth: number }): boolean {
    let i = jobId != null ? this.stack.findIndex((j) => j.jobId === jobId) : -1;
    if (i < 0 && fallback) {
      for (let k = this.stack.length - 1; k >= 0; k--) {
        if (this.stack[k].agent === fallback.agent && this.stack[k].depth === fallback.depth) { i = k; break; }
      }
    }
    if (i < 0) return false;
    const ended = this.stack[i];
    this.stack = this.stack.filter((j, k) => k < i || (k > i && j.depth <= ended.depth));
    return true;
  }

  /** The innermost running job, or null when nothing is open. */
  get current(): ActiveJob | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  get size(): number {
    return this.stack.length;
  }
}
