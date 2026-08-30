/**
 * Deliberately broken runtime driver (STH-5 negative proof).
 *
 * Wraps the Claude bridge and breaks the runtime contract in the way an
 * incomplete migration would: the provider query plays its scripted turns but
 * never reports success (the `result` message is dropped). The app then ends
 * the run with no terminal event and the job stuck in 'running' — a runtime
 * that is silently incomplete.
 *
 * The harness MUST report every scenario run through this driver as failed
 * (violations recorded, entry.ok === false). If a broken runtime ever passed,
 * the harness is blind — that is the failure mode this file exists to catch.
 */
import { createClaudeBridge } from '../drivers/claude.js';

function stripResult(gen) {
  const wrapped = (async function* () {
    try {
      for await (const message of gen) {
        if (message.type === 'result') continue; // THE breakage
        yield message;
      }
    } finally {
      gen.return?.();
    }
  })();
  wrapped.interrupt = () => (gen.interrupt ? gen.interrupt() : Promise.resolve());
  return wrapped;
}

export function createBrokenClaudeBridge(scenario) {
  const bridge = createClaudeBridge(scenario);
  bridge.name = 'claude-sdk-broken';
  const innerQuery = bridge.query;
  bridge.query = (args, mockState) => stripResult(innerQuery(args, mockState));
  return bridge;
}
