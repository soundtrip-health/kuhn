/**
 * Role smoke conformance scenario (STH-47 preview slice) — part 3: every
 * agent role must run end to end through the real application seam.
 *
 * Six text-only tasks (one per role): no tools are called, so tool-grant
 * differences cannot mask a failure — what this proves is that each
 * role's system prompt, model wiring, grant filtering, conversation,
 * and job accounting work identically under both drivers.
 */

/** 21 — Six-role smoke: every agent role runs a short turn to done. */
export const roleSmoke = {
  id: 'role-smoke',
  title: 'All six agent roles complete a short turn through the real seam',
  tasks: [
    {
      role: 'pm',
      input: 'Give me a one-line status.',
      model: { attempts: [{ turns: [{ text: 'On track.', usage: { input: 5, output: 3 } }] }] },
    },
    {
      role: 'writer',
      input: 'Write one line of the draft.',
      model: { attempts: [{ turns: [{ text: 'The draft opens with the key claim.', usage: { input: 5, output: 3 } }] }] },
    },
    {
      role: 'ra',
      input: 'Summarize the evidence in one line.',
      model: { attempts: [{ turns: [{ text: 'Evidence supports the hypothesis.', usage: { input: 5, output: 3 } }] }] },
    },
    {
      role: 'advisor',
      input: 'Advise me in one line.',
      model: { attempts: [{ turns: [{ text: 'Prefer the lower-risk design.', usage: { input: 5, output: 3 } }] }] },
    },
    {
      role: 'reviewer',
      input: 'Review one line for me.',
      model: { attempts: [{ turns: [{ text: 'The sentence is clear.', usage: { input: 5, output: 3 } }] }] },
    },
    {
      role: 'analyst',
      input: 'State the result in one line.',
      model: { attempts: [{ turns: [{ text: 'Result: significant effect.', usage: { input: 5, output: 3 } }] }] },
    },
  ],
  assert: async (ctx) => {
    const expected = ['pm', 'writer', 'ra', 'advisor', 'reviewer', 'analyst'];
    ctx.check('six runs, one per role',
      ctx.runs.length === 6 && ctx.runs.every((r, i) => r.terminal === 'done'),
      JSON.stringify(ctx.runs.map((r) => r.terminal)));
    for (let i = 0; i < expected.length; i += 1) {
      const job = ctx.runs[i].jobId != null ? ctx.job(ctx.runs[i].jobId) : null;
      ctx.check(`${expected[i]} job done with role stamped`,
        job?.status === 'done' && job.role === expected[i],
        JSON.stringify(job ?? null));
      const conv = ctx.conversations().find((c) => c.agent_slug === expected[i]);
      const assistant = conv ? ctx.messages(conv.id).find((m) => m.role === 'assistant') : null;
      ctx.check(`${expected[i]} assistant message persisted`, assistant?.content.length > 0,
        JSON.stringify(assistant ?? null));
    }
  },
};
