/**
 * Conformance scenario definitions (STH-5).
 *
 * A scenario is provider-neutral by construction: it names Kuhn tools by their
 * registry slugs (`write_file`, `add_citation`, `dispatch_agent`, ...), drives
 * the model with a declarative turn script, and asserts against Kuhn domain
 * events and observable state (files, database rows, driver observations).
 *
 * Nothing in a scenario references Claude SDK message shapes, `sdkQuery`, or
 * `mcp__kuhn__*` tool names — those are translation details owned by the
 * per-runtime driver. The same scenario file therefore runs unchanged against
 * the Claude bridge and the Pi bridge.
 *
 * Scenario shape:
 *
 *   {
 *     id: 'kebab-case-id',          // unique, stable
 *     title: 'Human-readable intent',
 *     version: '1.0.0',             // scenario version (default: suite default)
 *     tags: ['suggestions'],        // free-form labels for filtering
 *
 *     fixture: {
 *       orgs:        [{ name, slug, status }],        // default: one active org
 *       users:       [{ id, email, displayName }],    // default: user 7
 *       project:     { name, type },                  // default manuscript project
 *       files:       { 'draft/main.md': '...' },      // pre-created project files
 *       outside:     { '../sibling/secret.md': '...' }, // files OUTSIDE the root
 *       symlinks:    { 'escape-link': '../sibling/secret.md' },
 *       agents:      [{ slug, name, system_prompt, model, tools: [] }],
 *                    // default: the canonical seed matrix (seed-data.js)
 *       orgDocuments:[{ title, filename, chunks: [{ headingPath, text }] }],
 *       literature:  { pmids: { '38450214': {...} },
 *                      searches: { 'query substring': ['38450214'] } },
 *       arxiv:       { 'query substring': [ {...} ] },
 *     },
 *
 *     tasks: [{
 *       role: 'writer',
 *       input: '...',
 *       context: null,              // editor context: selection/cursor/files/dir
 *       compose: false,
 *       seeding: false,
 *       userId: 7,
 *       detachable: false,
 *       sessionId: null,           // or '$last_session': the provider session
 *                                  // id the previous run's done event reported
 *       internal: { budget: { used: 0, limit: 400 } },  // runAgentTask internal
 *       dispatchedBy: 0,            // parent task index (non-root tasks only)
 *       model: {
 *         attempts: [{              // one entry per provider request (retries)
 *           turns: [{
 *             text: '...',          // final assistant text (optional)
 *             deltas: ['Hel', 'lo'],// streamed prefix; concat MUST equal text
 *             toolCalls: [{ tool: 'write_file', args: { ... } }],  // arg values may use '$first_comment_id'
 *             usage: { input: 10, output: 5 },   // declared tokens (default 10/5)
 *             pauseUntilAbort: true, // turn starts only when the run is interrupted
 *           }],
 *           // The provider request fails after the turns above (empty turns:
 *           // fails immediately). code is the normalized provider-runtime
 *           // code; the driver renders it provider-natively and the app's
 *           // production retry policy decides whether the next attempt is
 *           // consumed.
 *           error: { code: 'overloaded' },
 *         }]
 *       }
 *     }],
 *
 *     interactions: [               // fired once each, in order, while consuming
 *       { when: 'question', match: 'What type', reply: 'An NIH R01 grant' },
 *       { when: 'question', action: 'disconnect' },  // consumer drops; if the
 *                                                    // task is detachable the
 *                                                    // harness re-attaches
 *       { when: 'text', action: 'abort' },           // abort the task signal
 *     ],
 *
 *     expectTerminal: 'done',       // 'done' | 'error' | 'none' (per task)
 *     jobStatus: 'done',            // expected final DB job status (default
 *                                   // derived from expectTerminal; 'none' -> 'cancelled')
 *     assert: async (ctx) => {      // provider-neutral assertions; see assertions.js
 *       ctx.check('file written', ctx.exists('draft/main.md'));
 *     },
 *   }
 */
import { canonicalJson, sha256Of } from './result.js';

export const DEFAULT_SCENARIO_VERSION = '1.0.0';

/**
 * Validate one scenario definition at load time. Fails fast on malformed
 * scenarios so a bad scenario can never silently "pass" a runtime.
 */
export function validateScenario(scenario) {
  const v = [];
  const need = (cond, msg) => { if (!cond) v.push(msg); };

  need(typeof scenario.id === 'string' && scenario.id.length > 0, 'scenario: id required');
  need(typeof scenario.title === 'string' && scenario.title.length > 0, `${scenario.id}: title required`);
  need(Array.isArray(scenario.tasks) && scenario.tasks.length > 0, `${scenario.id}: tasks required`);
  need(['done', 'error', 'none'].includes(scenario.expectTerminal ?? 'done'),
    `${scenario.id}: expectTerminal must be done|error|none`);

  for (const [ti, task] of (scenario.tasks ?? []).entries()) {
    const where = `${scenario.id}: task ${ti}`;
    need(typeof task.role === 'string', `${where}: role required`);
    need(typeof task.input === 'string' && task.input.length > 0, `${where}: input required`);
    // A task is a root (harness-run, sequential) task unless it declares a
    // parent; dispatched children are consumed by the driver's role queue.
    if ('dispatchedBy' in task) {
      need(typeof task.dispatchedBy === 'number' && task.dispatchedBy < ti,
        `${where}: dispatchedBy must be a number pointing at an earlier task`);
    }
    const model = task.model;
    need(model && Array.isArray(model.attempts) && model.attempts.length > 0,
      `${where}: model.attempts required`);
    for (const [ai, attempt] of (model?.attempts ?? []).entries()) {
      const hasError = attempt?.error != null;
      need(!hasError || typeof attempt.error.code === 'string',
        `${where}: attempt ${ai} error needs a normalized code`);
      // A request that fails before producing anything may have no turns;
      // every other attempt must play at least one turn.
      need(Array.isArray(attempt?.turns) && (!hasError || attempt.turns.length > 0),
        `${where}: attempt ${ai} needs turns (an error-only attempt may have none)`);
      for (const [tj, turn] of (attempt?.turns ?? []).entries()) {
        const tw = `${where}: attempt ${ai} turn ${tj}`;
        if (turn.deltas) {
          need(Array.isArray(turn.deltas) && turn.deltas.every((d) => typeof d === 'string'),
            `${tw}: deltas must be strings`);
          // Contract: the final text closes the delta run and equals it.
          need(typeof turn.text === 'string' && turn.text === turn.deltas.join(''),
            `${tw}: text must equal the concatenation of deltas`);
        }
        if (turn.toolCalls) {
          need(turn.toolCalls.every((c) => typeof c.tool === 'string' && typeof c.args === 'object'),
            `${tw}: toolCalls need { tool, args }`);
        }
        need(!(hasError && turn.pauseUntilAbort), `${tw}: erroring attempts cannot pauseUntilAbort`);
      }
      // Pi-fidelity chaining: one attempt is one provider request, and the
      // Pi agent only makes a follow-up model call after a tool result. A
      // turn that ends the conversation (no tool calls) therefore must be
      // the last turn — and when the attempt then fails, the final turn must
      // end in a tool call so the error response is actually consumed.
      const turns = attempt?.turns ?? [];
      for (let tj = 0; tj < turns.length - 1; tj++) {
        // A pauseUntilAbort follower is the harness's parking turn, not a
        // model call: an interrupted text turn ends the conversation exactly
        // like a final text turn would.
        if (turns[tj + 1].pauseUntilAbort) continue;
        need((turns[tj].toolCalls ?? []).length > 0,
          `${where}: attempt ${ai} turn ${tj} must end in a tool call to chain into the next turn`);
      }
      if (hasError && turns.length > 0) {
        need((turns[turns.length - 1].toolCalls ?? []).length > 0,
          `${where}: attempt ${ai} must end in a tool call before its scripted error`);
      }
      turns.forEach((turn, tj) => {
        if (turn.pauseUntilAbort && tj !== turns.length - 1) {
          need(false, `${where}: attempt ${ai} turn ${tj}: pauseUntilAbort must be the last turn`);
        }
      });
    }
  }
  for (const [ii, interaction] of (scenario.interactions ?? []).entries()) {
    need(typeof interaction.when === 'string', `${scenario.id}: interaction ${ii} needs when`);
    need('reply' in interaction || 'action' in interaction,
      `${scenario.id}: interaction ${ii} needs reply or action`);
    if (interaction.action) {
      need(['disconnect', 'abort'].includes(interaction.action),
        `${scenario.id}: interaction ${ii}: action must be disconnect|abort`);
    }
  }
  return v;
}

/** Hash over the canonical scenario JSON — the fixture hash for results. */
export function scenarioHash(scenario) {
  return sha256Of(canonicalJson(scenario));
}
