// Agent question card (story 025; countdown removed): the pending → answered |
// closed states for an ask_user decision. The real ask_user flow takes a
// free-text answer typed into the chat input, so the card is the visual
// surface: it shows the question; the actual answer is driven by chat.ts
// (markAnswered) and, only on task teardown, the `question_expired` event
// (markExpired). There is no countdown — a question waits until answered.

import { agentIdentity } from './agents';
import { icon } from './icons';

export class QuestionCard {
  readonly element: HTMLElement;
  private settled = false;
  private readonly agentLabel: string;
  private readonly questionText: string;

  constructor(agentSlug: string, questionText: string) {
    this.questionText = questionText;
    this.agentLabel = agentIdentity(agentSlug).label || 'Agent';
    this.element = document.createElement('div');
    this.element.className = 'question-card is-pending';
    this.renderPending();
  }

  private renderPending(): void {
    this.element.innerHTML =
      `<div class="qc-inner">` +
        `<div class="qc-head">` +
          `<div class="qc-title"><span class="dot"></span>${escape(this.agentLabel)} needs a decision</div>` +
        `</div>` +
        `<div class="qc-question">${escape(this.questionText)}</div>` +
        `<div class="qc-foot">Type your answer in the chat box below — take your time.</div>` +
      `</div>`;
  }

  /** Flip to the calm confirmation state after the user answers. */
  markAnswered(answerText: string): void {
    if (this.settled) return;
    this.settled = true;
    this.element.className = 'question-card is-answered';
    const check = icon('check', { size: 11, stroke: 3 });
    this.element.innerHTML =
      `<div class="qc-resolved-head"><span class="qc-check">${check}</span>` +
        `Decision recorded · ${escape(this.agentLabel)}</div>` +
      `<div class="qc-resolved-body">${escape(this.questionText)}</div>` +
      `<div class="qc-chose">You answered: ${escape(truncate(answerText, 60))}</div>`;
  }

  /** Flip to the neutral closed state when the task ends without an answer. */
  markExpired(): void {
    if (this.settled) return;
    this.settled = true;
    this.element.className = 'question-card is-expired';
    const clock = icon('clock', { size: 14, stroke: 2 });
    this.element.innerHTML =
      `<div class="qc-resolved-head"><span class="qc-expired-clock">${clock}</span>` +
        `No longer active · ${escape(this.agentLabel)}</div>` +
      `<div class="qc-resolved-body">This question is no longer active. ` +
        `You can pick it back up in the chat anytime.</div>`;
  }

  destroy(): void {
    this.settled = true;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function escape(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
