// Agent question card (story 025): the pending → answered | expired states for
// an ask_user decision (stories 012/020). Replaces the old `.chat-question`
// bubble. The real ask_user flow takes a free-text answer typed into the chat
// input, so the card is the visual surface: it shows the question, a 1Hz
// countdown, and a depletion bar; the actual answer/expiry is driven by chat.ts
// against the live job (markAnswered) and the `question_expired` event
// (markExpired). prefers-reduced-motion disables the depletion animation while
// the countdown state logic keeps ticking.

import { agentIdentity } from './agents';
import { icon } from './icons';

// The backend default ask_user timeout (config.agent.questionTimeoutMs); the
// event doesn't carry the deadline, so we mirror the default for the display.
const DEFAULT_SECONDS = 15 * 60;

export class QuestionCard {
  readonly element: HTMLElement;
  private secondsRemaining = DEFAULT_SECONDS;
  private timer: ReturnType<typeof setInterval> | null = null;
  private settled = false;
  private readonly agentLabel: string;
  private readonly questionText: string;

  constructor(agentSlug: string, questionText: string) {
    this.questionText = questionText;
    this.agentLabel = agentIdentity(agentSlug).label || 'Agent';
    this.element = document.createElement('div');
    this.element.className = 'question-card is-pending';
    this.renderPending();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    this.secondsRemaining -= 1;
    if (this.secondsRemaining <= 0) {
      this.markExpired();
      return;
    }
    const pill = this.element.querySelector('.qc-time');
    if (pill) pill.textContent = formatClock(this.secondsRemaining);
  }

  private renderPending(): void {
    const clock = icon('clock', { size: 11, stroke: 2.2 });
    this.element.innerHTML =
      `<div class="qc-inner">` +
        `<div class="qc-head">` +
          `<div class="qc-title"><span class="dot"></span>${escape(this.agentLabel)} needs a decision</div>` +
          `<div class="qc-countdown">${clock}<span class="qc-time">${formatClock(this.secondsRemaining)}</span></div>` +
        `</div>` +
        `<div class="qc-question">${escape(this.questionText)}</div>` +
        `<div class="qc-foot">Type your answer in the chat box below. ` +
          `Defaults if it expires.</div>` +
      `</div>` +
      `<div class="qc-deplete"><div class="qc-deplete-fill" style="animation-duration:${DEFAULT_SECONDS}s"></div></div>`;
  }

  /** Flip to the calm confirmation state after the user answers. */
  markAnswered(answerText: string): void {
    if (this.settled) return;
    this.settle();
    this.element.className = 'question-card is-answered';
    const check = icon('check', { size: 11, stroke: 3 });
    this.element.innerHTML =
      `<div class="qc-resolved-head"><span class="qc-check">${check}</span>` +
        `Decision recorded · ${escape(this.agentLabel)}</div>` +
      `<div class="qc-resolved-body">${escape(this.questionText)}</div>` +
      `<div class="qc-chose">You answered: ${escape(truncate(answerText, 60))}</div>`;
  }

  /** Flip to the neutral auto-resolved state on timeout. */
  markExpired(): void {
    if (this.settled) return;
    this.settle();
    this.element.className = 'question-card is-expired';
    const clock = icon('clock', { size: 14, stroke: 2 });
    this.element.innerHTML =
      `<div class="qc-resolved-head"><span class="qc-expired-clock">${clock}</span>` +
        `Auto-resolved · ${escape(this.agentLabel)}</div>` +
      `<div class="qc-resolved-body">No response in time — ${escape(this.agentLabel)} continued with defaults. ` +
        `You can revisit this later.</div>`;
  }

  private settle(): void {
    this.settled = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  destroy(): void {
    this.settle();
  }
}

function formatClock(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function escape(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
