// Budget pause (issue #110): the vocabulary shared by the runtime (which
// pauses a run at the token budget), the resume route (which picks it up),
// and the DB rows in between. A paused run is an ordinary job row with
// status 'error' and this exact error text — the client and the resume route
// recognise the pause by it, so it is defined once here.

/** jobs.error of a run the token budget stopped. */
export const BUDGET_EXCEEDED_ERROR = 'token budget exceeded';

/** True when this job row is a run the token budget paused. */
export function isBudgetPaused(job) {
  return job?.status === 'error' && job?.error === BUDGET_EXCEEDED_ERROR;
}

/**
 * The prompt a resumed run receives: the hand-off note the pause wrote (when
 * one could be captured) plus what to do with it. Kept short and stable —
 * it is logged as the resume's user message, so it is what the transcript
 * shows after a reload.
 * @param {{ handoff?: string|null }} job - the paused job row
 */
export function renderResumeInput(job) {
  const note = job?.handoff?.trim();
  return [
    '[Resuming after a token-budget pause]',
    'Your previous run on this task was paused when it reached its token budget. This run has a fresh budget.',
    note
      ? `Hand-off note written at the pause:\n\n${note}`
      : 'No hand-off note could be written at the pause; check the project files and the conversation so far before continuing.',
    'Continue from where you left off: say in a sentence or two what is done and what remains, then keep going. Re-read a file before editing it rather than assuming its contents.',
  ].join('\n\n');
}
