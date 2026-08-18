import { normalizeProviderError, normalizeUsage } from './contract.js';
import { assertContinuation, createContinuation } from './continuation.js';

/**
 * Deterministic, dependency-free AgentRuntime used by provider-neutral tests.
 * Each script entry represents one user turn. It can emit arbitrary normalized
 * events, fail, or stay pending until cancellation.
 *
 * Continuation uses the same canonical Kuhn schema as every real adapter
 * (continuation.js), which is what makes the cross-runtime resume tests
 * meaningful.
 */
export class ScriptedRuntime {
  constructor({ provider = 'scripted', model = 'scripted-1', turns = [] } = {}) {
    this.identity = { provider, model, api: 'scripted' };
    this.turns = [...turns];
    this.messages = [];
    this.requests = [];
  }

  async *runTurn({ input, signal, continuation } = {}) {
    if (continuation) this.messages = structuredClone(assertContinuation(continuation).messages);

    // Same pre-abort contract as real adapters: identity, one terminal
    // cancelled error, and no request is recorded or started.
    if (signal?.aborted) {
      yield { type: 'provider', ...this.identity };
      yield { type: 'error', error: cancelledError(signal) };
      return;
    }

    const turn = this.turns.shift();
    if (!turn) {
      yield { type: 'provider', ...this.identity };
      yield { type: 'error', error: normalizeProviderError(new Error('No scripted turn remains')) };
      return;
    }

    this.messages.push({ role: 'user', content: [{ type: 'text', text: input }] });
    this.requests.push({ input, continuation: structuredClone(this.messages.slice(0, -1)) });
    yield { type: 'provider', ...this.identity };

    if (turn.waitForAbort) {
      await waitForAbort(signal);
      yield { type: 'error', error: cancelledError(signal) };
      return;
    }

    if (turn.error) {
      yield { type: 'error', error: normalizeProviderError(turn.error, { stopReason: turn.stopReason }) };
      return;
    }

    // Assistant/tool state accumulates from the events themselves. A final
    // `text` event is authoritative for its delta run, so text is only added
    // once whether the script streams deltas, emits bare final text, or both.
    let assistantBlocks = [];
    let deltaBuffer = '';
    const flushAssistant = () => {
      if (deltaBuffer) assistantBlocks.push({ type: 'text', text: deltaBuffer });
      deltaBuffer = '';
      if (assistantBlocks.length > 0) this.messages.push({ role: 'assistant', content: assistantBlocks });
      assistantBlocks = [];
    };

    for (const event of turn.events ?? []) {
      if (signal?.aborted) {
        yield { type: 'error', error: cancelledError(signal) };
        return;
      }
      if (event.type === 'text_delta') deltaBuffer += event.content;
      if (event.type === 'text') {
        assistantBlocks.push({ type: 'text', text: event.content });
        deltaBuffer = '';
      }
      if (event.type === 'tool_call') {
        assistantBlocks.push({ type: 'tool_call', id: event.id, name: event.name, arguments: structuredClone(event.arguments ?? {}) });
      }
      if (event.type === 'tool_result') {
        flushAssistant();
        this.messages.push({
          role: 'tool_result',
          toolCallId: event.id,
          toolName: event.name,
          content: structuredClone(event.content ?? []),
          isError: event.isError === true,
        });
      }
      yield structuredClone(event);
    }
    flushAssistant();

    yield {
      type: 'done',
      finishReason: turn.finishReason ?? 'stop',
      usage: normalizeUsage(turn.usage),
      continuation: createContinuation(this.messages),
    };
  }
}

function cancelledError(signal) {
  return normalizeProviderError(
    signal?.reason ?? new DOMException('Aborted', 'AbortError'),
    { stopReason: 'aborted' },
  );
}

function waitForAbort(signal) {
  if (!signal) return Promise.reject(new Error('waitForAbort turn requires an AbortSignal'));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}
