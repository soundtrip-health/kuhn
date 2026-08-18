import { validateRuntimeEventSequence } from '../src/agents/provider-runtime/contract.js';
import { createOpenRouterPiRuntime } from '../src/agents/provider-runtime/pi-spike.js';

if (!process.env.OPENROUTER_API_KEY) {
  console.log('[pi-smoke] skipped: OPENROUTER_API_KEY is not configured');
  process.exit(0);
}

const modelId = process.env.KUHN_PI_SMOKE_MODEL || 'openai/gpt-oss-20b:free';
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error('live smoke timed out')), 60_000);
const { runtime } = createOpenRouterPiRuntime({
  modelId,
  systemPrompt: 'Follow the user instruction exactly. Do not add explanation.',
});

const events = [];
try {
  for await (const event of runtime.runTurn({
    input: 'Reply with exactly KUHN_PI_OK',
    signal: controller.signal,
  })) {
    events.push(event);
  }
} finally {
  clearTimeout(timeout);
}

const violations = validateRuntimeEventSequence(events);
const text = events.filter((event) => event.type === 'text').map((event) => event.content).join('\n');
const terminal = events.at(-1);
if (violations.length > 0) throw new Error(`runtime contract violations: ${violations.join('; ')}`);
if (terminal?.type !== 'done') throw new Error(`live smoke failed: ${terminal?.error?.code ?? 'no terminal result'}`);
if (!text.includes('KUHN_PI_OK')) throw new Error('live provider did not return the expected marker');

console.log(JSON.stringify({
  provider: events[0].provider,
  model: events[0].model,
  api: events[0].api,
  streamedDeltas: events.filter((event) => event.type === 'text_delta').length,
  usage: terminal.usage,
  contractViolations: violations,
}, null, 2));
