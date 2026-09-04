/**
 * Application-behavior conformance scenarios (STH-5) — part 2: interaction
 * and lifecycle behaviors (user questions, detach/reconnect, cancellation,
 * provider retries, error propagation, continuation).
 *
 * Same provider-neutral contract as app-behavior.js: scripted turns, Kuhn
 * tool slugs, domain events + database assertions.
 */

/** 14 — ask_user round-trip: the reply reaches the model as a tool result. */
export const askUserFlow = {
  id: 'ask-user-flow',
  title: 'ask_user parks on a question event; the delivered reply round-trips to the model',
  tasks: [{
    role: 'pm',
    input: 'Interview me about the new grant project.',
    model: {
      attempts: [{
        turns: [
          { toolCalls: [{ tool: 'ask_user', args: { question: 'What funding scheme are we targeting?' } }] },
          {
            toolCalls: [{
              tool: 'save_project_config',
              args: {
                title: 'NEU-R01 Grant',
                project_type: 'grant',
                research_question: 'Does remote monitoring reduce heart-failure readmissions?',
                deliverables: ['Specific Aims'],
                timeline: 'Submission 2026-12-01',
              },
            }],
          },
          { text: 'Configuration saved.', usage: { input: 10, output: 5 } },
        ],
      }],
    },
  }],
  interactions: [
    { when: 'question', match: 'funding scheme', reply: 'An NIH R01 in neurocardiology.' },
  ],
  assert: async (ctx) => {
    const q = ctx.eventsOf('question')[0];
    ctx.check('question event carried the job and the question text',
      q?.jobId == ctx.runs[0].jobId && q.content === 'What funding scheme are we targeting?',
      JSON.stringify(q));
    const job = ctx.job(ctx.runs[0].jobId);
    ctx.check('run completed', job?.status === 'done');
    const toolMsgs = ctx.toolMessages(ctx.conversations().find((c) => c.id === job?.conversation_id)?.id);
    ctx.check('reply round-tripped to the model as the tool result',
      toolMsgs.some((m) => /NIH R01 in neurocardiology/.test(m.content ?? '') && m.is_error === 0),
      JSON.stringify(toolMsgs.map((m) => m.content)));
    const project = ctx.project(ctx.fixture.projectId);
    const cfg = typeof project?.config === 'string' ? JSON.parse(project.config) : project?.config;
    ctx.check('config persisted after the interview', cfg?.project_type === 'grant');
  },
};

/** 15 — Detach and reconnect (story 027): a parked run survives a disconnect. */
export const detachReconnect = {
  id: 'detach-reconnect',
  title: 'Disconnecting while parked on a question leaves the run alive; reconnect re-emits it',
  tasks: [{
    role: 'pm',
    input: 'Set up the project; ask me the first interview question.',
    detachable: true,
    model: {
      attempts: [{
        turns: [
          { toolCalls: [{ tool: 'ask_user', args: { question: 'Who is the PI of record?' } }] },
          { text: 'Noted: PI recorded. Project setup complete.', usage: { input: 9, output: 5 } },
        ],
      }],
    },
  }],
  interactions: [
    { when: 'question', action: 'disconnect' },
  ],
  reconnect: { reply: 'Dr. Ada Lovelace.' },
  assert: async (ctx) => {
    const questions = ctx.eventsOf('question');
    ctx.check('the question was re-emitted on reconnect',
      questions.length >= 2 && questions[1]?.jobId == questions[0]?.jobId,
      JSON.stringify(questions.map((q) => ({ jobId: q.jobId, c: q.content }))));
    const job = ctx.job(ctx.runs[0].jobId);
    ctx.check('run completed after reconnect', job?.status === 'done');
    const text = ctx.lastEventOf('text');
    ctx.check('final text arrived over the reconnected stream',
      /Project setup complete/.test(text?.content ?? ''));
    const toolMsgs = ctx.toolMessages(ctx.conversations().find((c) => c.id === job?.conversation_id)?.id);
    ctx.check('the reply answered the parked question',
      toolMsgs.some((m) => /Dr. Ada Lovelace/.test(m.content ?? '')));
  },
};

/** 16 — Cancellation: an aborted consumer interrupts the provider and the job is cancelled. */
export const cancelDisconnect = {
  id: 'cancel-disconnect',
  title: 'Aborting the stream mid-run interrupts the provider; the job lands as cancelled',
  expectTerminal: 'none',
  jobStatus: 'cancelled',
  tasks: [{
    role: 'writer',
    input: 'Keep working on the outline; I will tell you to stop.',
    model: {
      attempts: [{
        turns: [
          // A real event first, so the harness has something to observe
          // before it aborts; the trailing park keeps the provider run in
          // flight. The interrupt lands on a text-only turn: the
          // cancellation edge with a finalized-but-unexecuted tool call
          // (the runtime closes it with one synthetic error tool_result
          // before the cancelled terminal) cannot be placed
          // deterministically behind the scripted model's stream, so it is
          // pinned where the stream is controlled — the adapters' abort
          // regressions (provider-runtime/pi-adapter.test.js and
          // claude-runtime.test.js) and the seam's persisted-audit
          // regression (agents/runtime.test.js).
          {
            text: 'Working on the outline…',
            deltas: ['Working on the outline…'],
          },
          { pauseUntilAbort: true },
        ],
      }],
    },
  }],
  interactions: [
    { when: 'text', match: 'Working on the outline', action: 'abort' },
  ],
  assert: async (ctx) => {
    const job = ctx.job(ctx.runs[0].jobId);
    ctx.check('job status is cancelled', job?.status === 'cancelled', JSON.stringify(job));
    ctx.check('no terminal done event', ctx.eventsOf('done').length === 0);
    const obs = ctx.driver.observations[0];
    ctx.check('driver saw the interruption', obs?.interrupted === true);
    const msgs = ctx.messages(ctx.conversations().find((c) => c.id === job?.conversation_id)?.id);
    ctx.check('the partial turn was persisted (audit trail)',
      msgs.some((m) => m.role === 'assistant' && /Working on the outline/.test(m.content ?? '')));
  },
};

/** 17 — Retry: a transient provider failure retries with the session resume. */
export const retryTransient = {
  id: 'retry-transient-error',
  title: 'A 529-overload mid-run narrates a notice and retries the same session',
  tasks: [{
    role: 'writer',
    input: 'Write the first sentence of the draft.',
    model: {
      attempts: [
        {
          turns: [
            {
              text: 'Let me check the workspace first.',
              toolCalls: [{ tool: 'list_files', args: {} }],
            },
          ],
          error: { code: 'overloaded' },
        },
        {
          turns: [
            {
              text: 'Recovered — the draft now opens with the key claim.',
              toolCalls: [{ tool: 'list_files', args: {} }],
            },
            { text: 'Draft updated.', usage: { input: 8, output: 4 } },
          ],
        },
      ],
    },
  }],
  assert: async (ctx) => {
    const notices = ctx.eventsOf('notice');
    ctx.check('exactly one retry notice', notices.length === 1, JSON.stringify(notices));
    ctx.check('notice narrates the retry',
      notices[0]?.reason === 'provider_overloaded' && notices[0]?.attempt === 1 && notices[0]?.maxAttempts === 3,
      JSON.stringify(notices[0]));
    const obs = ctx.driver.observations.filter((o) => o.role === 'writer');
    ctx.check('two provider queries for the same session',
      obs.length === 2 && obs[0]?.sessionId === obs[1]?.sessionId,
      JSON.stringify(obs.map((o) => ({ s: o.sessionId, a: o.attempt }))));
    ctx.check('the retry resumed the session', obs[1]?.resume === obs[0]?.sessionId && obs[0]?.resume == null);
    const job = ctx.job(ctx.runs[0].jobId);
    ctx.check('job done with the resumed session id', job?.status === 'done' && job.session_id === obs[0]?.sessionId);
    const textEvents = ctx.eventsOf('text');
    ctx.check('both the partial and the recovered turn are in the stream',
      textEvents.some((e) => /workspace first/.test(e.content)) && textEvents.some((e) => /Recovered/.test(e.content)),
      JSON.stringify(textEvents.map((e) => e.content)));
  },
};

/** 18 — Non-transient error: context overflow is NOT retried; it terminates. */
export const nonTransientError = {
  id: 'non-transient-error',
  title: 'A context-overflow error is not retried; the run ends with an error terminal',
  expectTerminal: 'error',
  jobStatus: 'error',
  tasks: [{
    role: 'writer',
    input: 'Explain the whole protocol in full detail.',
    model: {
      attempts: [
        {
          turns: [
            { text: 'Starting the explanation.', toolCalls: [{ tool: 'list_files', args: {} }] },
          ],
          error: { code: 'context_overflow' },
        },
      ],
    },
  }],
  assert: async (ctx) => {
    ctx.check('no retry notice was emitted', ctx.eventsOf('notice').length === 0);
    const err = ctx.lastEventOf('error');
    ctx.check('error terminal carries the provider message',
      /context window was exceeded|too long/i.test(err?.message ?? ''), JSON.stringify(err));
    const obs = ctx.driver.observations.filter((o) => o.role === 'writer');
    ctx.check('exactly one provider query (no retry)', obs.length === 1, String(obs.length));
    const job = ctx.job(ctx.runs[0].jobId);
    ctx.check('job row records the error', job?.status === 'error' && /context window/i.test(job?.error ?? ''));
  },
};

/** 19 — Continuation/follow-up: a second root task resumes the provider session. */
export const followUpContinuation = {
  id: 'continuation-follow-up',
  title: 'A follow-up task resumes the prior session instead of starting a new one',
  tasks: [
    {
      role: 'writer',
      input: 'Draft the introduction.',
      model: {
        attempts: [{
          turns: [{ text: 'Introduction drafted.', usage: { input: 10, output: 6 } }],
        }],
      },
    },
    {
      role: 'writer',
      input: 'Now add the methods summary.',
      sessionId: '$last_session',
      model: {
        attempts: [{
          turns: [{ text: 'Methods summary appended.', usage: { input: 12, output: 6 } }],
        }],
      },
    },
  ],
  assert: async (ctx) => {
    const dones = ctx.eventsOf('done');
    ctx.check('both runs completed', dones.length === 2, String(dones.length));
    const isPi = ctx.driver.kind === 'pi';
    if (isPi) {
      ctx.check('the follow-up resumed the canonical record (Pi has no provider session)',
        dones[0]?.continuation != null && dones[1]?.continuation != null
        && JSON.stringify(dones[1].continuation?.messages ?? []).includes('Introduction drafted.'),
        JSON.stringify(dones.map((d) => d.sessionId)));
    } else {
      ctx.check('the follow-up resumed the same session',
        dones[0]?.sessionId != null && dones[1]?.sessionId === dones[0]?.sessionId,
        JSON.stringify(dones.map((d) => d.sessionId)));
    }
    const obs = ctx.driver.observations.filter((o) => o.role === 'writer');
    if (isPi) {
      ctx.check('the driver saw the continuation on the second run',
        obs[0]?.continuation === false && obs[1]?.continuation === true,
        JSON.stringify(obs.map((o) => o.continuation)));
    } else {
      ctx.check('driver saw the resume on the second query',
        obs[1]?.resume === obs[0]?.sessionId, JSON.stringify(obs.map((o) => o.resume)));
    }
    ctx.check('two jobs, two conversations',
      ctx.jobs().length === 2 && ctx.conversations().length === 2);
    const convs = ctx.conversations();
    const first = ctx.messages(convs[0]?.id).filter((m) => m.role === 'assistant');
    const second = ctx.messages(convs[1]?.id).filter((m) => m.role === 'assistant');
    ctx.check('each conversation holds its own assistant text',
      first.some((m) => /Introduction drafted/.test(m.content ?? ''))
      && second.some((m) => /Methods summary appended/.test(m.content ?? '')));
  },
};

/** 20 — Job/conversation state: a failed provider request leaves a consistent
 * error state the client can retry (session id handed back). */
export const jobConversationState = {
  id: 'job-conversation-state',
  title: 'A terminal transient failure hands back the session id; state is consistent for a retry',
  expectTerminal: 'error',
  jobStatus: 'error',
  tasks: [{
    role: 'ra',
    input: 'Search for prior trials of the biomarker.',
    model: {
      attempts: [
        // maxAttempts: 3 means three RETRIES: four provider queries total,
        // three notices, then the fourth failure is the terminal one.
        { turns: [{ text: 'Searching…', toolCalls: [{ tool: 'list_files', args: {} }] }], error: { code: 'overloaded' } },
        { turns: [{ text: 'Still searching…', toolCalls: [{ tool: 'list_files', args: {} }] }], error: { code: 'overloaded' } },
        { turns: [{ text: 'Still trying…', toolCalls: [{ tool: 'list_files', args: {} }] }], error: { code: 'overloaded' } },
        { turns: [{ text: 'One more try…', toolCalls: [{ tool: 'list_files', args: {} }] }], error: { code: 'overloaded' } },
      ],
    },
  }],
  assert: async (ctx) => {
    ctx.check('three retry notices (the full budget)', ctx.eventsOf('notice').length === 3,
      JSON.stringify(ctx.eventsOf('notice').map((n) => n.attempt)));
    const err = ctx.lastEventOf('error');
    const isPi = ctx.driver.kind === 'pi';
    ctx.check(isPi
      ? 'terminal error is tagged provider_overloaded (Pi has no session id to hand back)'
      : 'terminal error is tagged provider_overloaded with the session id',
      isPi
        ? err?.reason === 'provider_overloaded' && err?.sessionId == null
        : err?.reason === 'provider_overloaded' && typeof err?.sessionId === 'string' && err.sessionId.length > 0,
      JSON.stringify(err));
    const job = ctx.job(ctx.runs[0].jobId);
    ctx.check('job errored and retains the session id for a client retry',
      job?.status === 'error' && job.session_id === err?.sessionId);
    const obs = ctx.driver.observations.filter((o) => o.role === 'ra');
    ctx.check('four provider queries, one session', obs.length === 4
      && new Set(obs.map((o) => o.sessionId)).size === 1);
    const conv = ctx.conversations().find((c) => c.id === job?.conversation_id);
    const userMsgs = ctx.messages(conv?.id).filter((m) => m.role === 'user');
    ctx.check('the user turn is recorded once', userMsgs.length === 1);
  },
};

/** 21 — Tool-call attribution (STH-47): the assistant row persists with its
 * own tool calls — the normalized tool_call precedes the message's usage at
 * the seam, so the row written on the usage event already carries the
 * calls — the tool result row follows it, and the next assistant row
 * borrows none of the first's calls. */
export const toolCallAttribution = {
  id: 'tool-call-attribution',
  title: 'The assistant row keeps its own tool call; the tool result row follows it; the next assistant row borrows none',
  tasks: [{
    role: 'writer',
    input: 'Outline the methods section. Check the workspace first.',
    model: {
      attempts: [{
        turns: [
          { text: 'Checking the workspace first.', toolCalls: [{ tool: 'list_files', args: {} }] },
          { text: 'Workspace checked — outline drafted.', usage: { input: 12, output: 8 } },
        ],
      }],
    },
  }],
  assert: async (ctx) => {
    const job = ctx.job(ctx.runs[0].jobId);
    const conv = ctx.conversations().find((c) => c.id === job?.conversation_id);
    const msgs = ctx.messages(conv?.id);
    const assistants = msgs.filter((m) => m.role === 'assistant');
    const [first, second] = assistants;
    ctx.check('one assistant row per scripted turn', assistants.length === 2,
      JSON.stringify(msgs.map((m) => m.role)));
    const firstCalls = first?.tool_calls ? JSON.parse(first.tool_calls) : null;
    ctx.check('the first assistant row carries exactly its own list_files call',
      Array.isArray(firstCalls) && firstCalls.length === 1
      && firstCalls[0]?.name === 'list_files' && firstCalls[0]?.id != null,
      JSON.stringify(firstCalls));
    const toolRows = msgs.filter((m) => m.role === 'tool');
    ctx.check('one tool result row follows the first assistant row',
      toolRows.length === 1 && msgs.indexOf(toolRows[0]) > msgs.indexOf(first),
      JSON.stringify(msgs.map((m) => [m.id, m.role])));
    ctx.check('the tool result row belongs to that call',
      toolRows[0]?.tool_call_id === firstCalls?.[0]?.id && toolRows[0]?.is_error === 0,
      JSON.stringify(toolRows[0] ?? null));
    ctx.check('the tool result content is persisted',
      typeof toolRows[0]?.content === 'string' && toolRows[0].content.length > 0,
      JSON.stringify(toolRows[0]?.content ?? null));
    const secondCalls = second?.tool_calls ? JSON.parse(second.tool_calls) : null;
    ctx.check('the second assistant row borrows no call from the first',
      secondCalls == null,
      JSON.stringify(secondCalls));
    ctx.check('row order: assistant -> tool -> assistant',
      first && toolRows[0] && second
      && first.id < toolRows[0].id && toolRows[0].id < second.id,
      JSON.stringify(msgs.map((m) => [m.id, m.role])));
  },
};
