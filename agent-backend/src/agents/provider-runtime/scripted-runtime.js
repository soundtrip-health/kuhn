import { normalizeProviderError, normalizeUsage } from './contract.js';

/**
 * Deterministic, dependency-free AgentRuntime used by provider-neutral tests.
 * Each script entry represents one user turn. It can emit arbitrary normalized
 * events, fail, or stay pending until cancellation.
 */
export class ScriptedRuntime {
  constructor({ provider = 'scripted', model = 'scripted-1', turns = [] } = {}) {
    this.identity = { provider, model, api: 'scripted' };
    this.turns = [...turns];
    this.messages = [];
    this.requests = [];
  }

  async *runTurn({ input, signal, continuation } = {}) {
    if (continuation) this.messages = structuredClone(continuation.messages);
    const turn = this.turns.shift();
    if (!turn) {
      yield { type: 'provider', ...this.identity };
      yield { type: 'error', error: normalizeProviderError(new Error('No scripted turn remains')) };
      return;
    }

    this.messages.push({ role: 'user', content: input });
    this.requests.push({ input, continuation: structuredClone(this.messages.slice(0, -1)) });
    yield { type: 'provider', ...this.identity };

    if (turn.waitForAbort) {
      await waitForAbort(signal);
      yield { type: 'error', error: normalizeProviderError(signal?.reason ?? new DOMException('Aborted', 'AbortError'), { stopReason: 'aborted' }) };
      return;
    }

    if (turn.error) {
      yield { type: 'error', error: normalizeProviderError(turn.error, { stopReason: turn.stopReason }) };
      return;
    }

    let assistantText = '';
    for (const event of turn.events ?? []) {
      if (signal?.aborted) {
        yield { type: 'error', error: normalizeProviderError(signal.reason ?? new DOMException('Aborted', 'AbortError'), { stopReason: 'aborted' }) };
        return;
      }
      if (event.type === 'text_delta') assistantText += event.content;
      yield structuredClone(event);
    }

    if (assistantText) this.messages.push({ role: 'assistant', content: assistantText });
    yield {
      type: 'done',
      finishReason: turn.finishReason ?? 'stop',
      usage: normalizeUsage(turn.usage),
      continuation: { version: 1, messages: structuredClone(this.messages) },
    };
  }
}

function waitForAbort(signal) {
  if (!signal) return Promise.reject(new Error('waitForAbort turn requires an AbortSignal'));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}
