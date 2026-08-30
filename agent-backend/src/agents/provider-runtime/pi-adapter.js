import { Agent } from '@earendil-works/pi-agent-core';
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxProvider,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

import { EventChannel } from '../events.js';
import { addUsage, normalizeProviderError, normalizeUsage } from './contract.js';
import { assertContinuation, createContinuation } from './continuation.js';

/**
 * Production Pi adapter (STH-8). Implements the provider-neutral
 * `AgentRuntime` contract (contract.js): normalized streaming events, tool
 * call/result lifecycle, normalized usage, exactly one terminal event, and
 * canonical Kuhn continuation in and out.
 *
 * Server-mode safety invariants (verified by pi-adapter.test.js):
 *
 * - Only tools explicitly passed by Kuhn reach the model. The Pi `Agent`
 *   receives `tools` exclusively from this constructor; pi-agent-core's
 *   coding-agent tool factories (read/write/edit/bash, harness, skills)
 *   are export-only in the package and are never instantiated here.
 * - The system prompt sent with each request is exactly Kuhn's
 *   `systemPrompt` — Pi reads no AGENTS.md/CLAUDE.md, project context, or
 *   personal configuration; the core agent loop performs no filesystem
 *   access.
 * - Credentials come only from explicitly named environment variables
 *   (or the faux provider's no-op auth). No personal Pi auth store, OAuth
 *   profile, or ambient credential file is consulted; a missing key fails
 *   the turn with a normalized `provider_error` instead of silently
 *   borrowing another credential.
 * - Pi's transport-level request retry is left at its default of zero, so
 *   provider failures surface as exactly one terminal `error` event. Any
 *   retry policy stays above the runtime seam.
 * - Kuhn tool failures are encoded in the result envelope (`isError: true`,
 *   never thrown); Pi's tool contract derives `isError` from a throw. The
 *   adapter translates a failure envelope into a throw carrying the
 *   model-facing text, so the `tool_result` event and the model both see
 *   the failure.
 * - `kind: 'provider_builtin'` descriptors (execute is null — provider-
 *   native capabilities Pi cannot supply, e.g. web_search/web_fetch) and
 *   tools without an execute function are omitted when the Agent is built,
 *   mirroring the Claude adapter's own filter.
 * - `cancel()` interrupts the in-flight turn (product teardown / budget
 *   cutoff); the turn still yields its one terminal `error` with code
 *   'cancelled'.
 * - `error` terminals carry the cumulative `usage` and the partial canonical
 *   `continuation` (the transcript so far), so a retried attempt keeps the
 *   record complete; a pre-abort turn yields the identity event and a
 *   cancelled `error` terminal only.
 *
 * Request-scoped state: every `runTurn` constructs its own Pi `Agent`
 * seeded only from the canonical continuation passed in for that turn. The
 * adapter instance holds configuration only, so one instance can serve
 * independent concurrent turns and many instances can run concurrently.
 *
 * Pi message objects never cross the runtime boundary: continuation is
 * converted to and from the canonical Kuhn schema (continuation.js) here,
 * at the boundary.
 */
export class PiAgentRuntime {
  /**
   * @param {object} options
   * @param {import('@earendil-works/pi-ai').Models} options.models pi-ai Models collection
   * @param {import('@earendil-works/pi-ai').Model} options.model the explicit model to run
   * @param {string} [options.systemPrompt] Kuhn-owned system instructions
   * @param {Array<object>} [options.tools] neutral Kuhn tools (contract.js RuntimeTool); provider_builtin descriptors and tools without execute are omitted
   * @param {{version: 1, messages: Array<object>}} [options.continuation]
   *   initial canonical Kuhn continuation (continuation.js); a turn may
   *   override it with its own `continuation`
   * @param {string} [options.thinkingLevel] defaults to 'medium' for reasoning
   *   models and 'off' otherwise
   */
  constructor({ models, model, systemPrompt = '', tools = [], continuation, thinkingLevel } = {}) {
    if (!models || typeof models.streamSimple !== 'function') {
      throw new Error('PiAgentRuntime requires a pi-ai Models collection');
    }
    if (!model || !model.provider || !model.id) {
      throw new Error('PiAgentRuntime requires an explicit model with provider and id');
    }
    if (typeof systemPrompt !== 'string') {
      throw new Error('systemPrompt must be a string');
    }
    this.models = models;
    this.model = model;
    this.systemPrompt = systemPrompt;
    // Kuhn's neutral tools and Pi's AgentTool agree on the execute
    // signature (toolCallId, args, signal), so the passthrough is safe as-is.
    // Two translations are required:
    //
    // 1. Pi derives a tool result's isError from a THROW; Kuhn tools instead
    //    encode failure in the result envelope ({ content, isError: true })
    //    and never throw. A failure envelope is translated into a throw
    //    carrying the model-facing text, so both the tool_result event and
    //    the model see the failure.
    // 2. kind: 'provider_builtin' descriptors (execute is null — provider-
    //    native capabilities Pi cannot supply, e.g. web_search/web_fetch)
    //    and tools without an execute function are omitted, mirroring the
    //    Claude adapter's own filter (buildClaudeToolSet).
    //
    // Pi's AgentTool type also carries a display-only `label`; the neutral
    // contract does not, so synthesize one when absent.
    this.tools = tools
      .filter((tool) => tool.kind !== 'provider_builtin' && typeof tool.execute === 'function')
      .map((tool) => ({
        ...tool,
        label: tool.label ?? tool.name,
        execute: async (toolCallId, args, signal, onUpdate) => {
          const result = await tool.execute(toolCallId, args, signal, onUpdate);
          if (result?.isError === true) {
            const text = (result.content ?? [])
              .filter((block) => block?.type === 'text')
              .map((block) => block.text)
              .join('\n');
            throw new Error(text || 'Tool execution failed');
          }
          return { content: result?.content ?? [], details: result?.details };
        },
      }));
    if (continuation) assertContinuation(continuation);
    this.initialMessages = continuation ? piMessagesFromContinuation(continuation, model) : [];
    this.thinkingLevel = thinkingLevel ?? (model.reasoning ? 'medium' : 'off');
  }

  /**
   * Normalized provider/model identity (the same payload as the opening
   * `provider` event).
   */
  get identity() {
    return {
      provider: this.model.provider,
      model: this.model.id,
      api: this.model.api,
      endpoint: this.model.baseUrl,
      capabilities: {
        reasoning: this.model.reasoning,
        input: [...this.model.input],
        contextWindow: this.model.contextWindow,
        maxTokens: this.model.maxTokens,
      },
    };
  }

  /**
   * Interrupt the in-flight turn (product teardown / budget cutoff). No-op
   * when no turn is in flight; the interrupted turn still yields exactly one
   * terminal `error` event with code 'cancelled'.
   */
  cancel() {
    if (this.activeAgent) {
      this.cancelRequested = true;
      this.activeAgent.abort();
    }
  }

  /**
   * @param {{ input: string, signal?: AbortSignal,
   *   continuation?: {version: number, messages: Array<object>},
   *   systemPrompt?: string, resume?: string|null }} turn
   * @returns {AsyncGenerator<object>} normalized provider-runtime events
   */
  async *runTurn({ input, signal, continuation, systemPrompt, resume = null } = {}) {
    if (typeof input !== 'string' || input.length === 0) {
      throw new Error('runTurn input must be a non-empty string');
    }
    const history = continuation
      ? piMessagesFromContinuation(assertContinuation(continuation), this.model)
      : this.initialMessages;
    const prompt = systemPrompt ?? this.systemPrompt;
    if (typeof prompt !== 'string') throw new Error('systemPrompt must be a string');
    if (resume !== null && typeof resume !== 'string') throw new Error('resume must be a string or null');

    // Agent.abort() only cancels an active run, so it cannot neutralize a
    // signal that was aborted before prompt(). Refuse the turn up front:
    // identity still opens the transcript, then exactly one terminal
    // cancelled error, and no provider request or tool ever starts.
    if (signal?.aborted) {
      yield this.identityEvent(resume);
      yield {
        type: 'error',
        error: normalizeProviderError(
          signal.reason ?? new DOMException('This operation was aborted', 'AbortError'),
          { stopReason: 'aborted' },
        ),
      };
      return;
    }

    // Request-scoped agent: fresh transcript, queues, and abort state per
    // turn; nothing is shared between concurrent runs.
    const agent = new Agent({
      initialState: {
        systemPrompt: prompt,
        model: this.model,
        thinkingLevel: this.thinkingLevel,
        tools: this.tools,
        messages: history,
      },
      // Opaque caller-side session token (the contract's `resume`), forwarded
      // to the provider for prompt-cache session correlation. Pi never
      // invents a session id on its own.
      ...(resume ? { sessionId: resume } : {}),
      streamFn: this.models.streamSimple.bind(this.models),
      toolExecution: 'sequential',
    });

    this.activeAgent = agent;
    this.cancelRequested = false;

    const channel = new EventChannel();
    let usage = normalizeUsage();
    let terminal = false;

    const finish = (event) => {
      if (terminal) return;
      terminal = true;
      channel.push(event);
    };

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        channel.push({ type: 'text_delta', content: event.assistantMessageEvent.delta });
        return;
      }
      if (event.type === 'tool_execution_start') {
        channel.push({
          type: 'tool_call',
          id: event.toolCallId,
          name: event.toolName,
          arguments: structuredClone(event.args),
        });
        return;
      }
      if (event.type === 'tool_execution_end') {
        channel.push({
          type: 'tool_result',
          id: event.toolCallId,
          name: event.toolName,
          content: structuredClone(event.result?.content ?? []),
          details: structuredClone(event.result?.details),
          isError: event.isError,
        });
        return;
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const messageUsage = normalizeUsage(event.message.usage);
        const text = event.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (text) channel.push({ type: 'text', content: text });
        usage = addUsage(usage, messageUsage);
        channel.push({ type: 'usage', usage: messageUsage });
        return;
      }
      if (event.type !== 'agent_end') return;

      const lastAssistant = [...agent.state.messages].reverse().find((message) => message.role === 'assistant');
      if (lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted') {
        // When Kuhn's signal aborted (or cancel() interrupted the turn), Pi
        // can surface the abort through internal setup steps (auth
        // resolution, stream start) as an 'error' stop with the abort reason
        // as its message — the abort context is lost at the Pi boundary. The
        // caller's explicit abort is the strong signal the contract
        // requires, so the terminal is classified as cancelled.
        const callerAborted = signal?.aborted || this.cancelRequested;
        const error = callerAborted
          ? normalizeProviderError(
            signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'),
            { stopReason: 'aborted' },
          )
          : normalizeProviderError(
            new Error(lastAssistant.errorMessage ?? `Provider stopped with ${lastAssistant.stopReason}`),
            { stopReason: lastAssistant.stopReason },
          );
        const piMessages = agent.state.messages;
        finish({
          type: 'error',
          error,
          usage,
          continuation: piMessages.length > 0 ? continuationFromPiMessages(piMessages) : null,
        });
        return;
      }

      finish({
        type: 'done',
        finishReason: lastAssistant?.stopReason ?? 'stop',
        usage,
        continuation: continuationFromPiMessages(agent.state.messages),
      });
    });

    const onAbort = () => agent.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    channel.push(this.identityEvent(resume));

    const pump = agent.prompt(input)
      .catch((error) => {
        const piMessages = agent.state.messages;
        finish({
          type: 'error',
          error: (signal?.aborted || this.cancelRequested)
            ? normalizeProviderError(
              signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'),
              { stopReason: 'aborted' },
            )
            : normalizeProviderError(error),
          usage,
          continuation: piMessages.length > 0 ? continuationFromPiMessages(piMessages) : null,
        });
      })
      .finally(() => {
        if (!terminal) {
          const piMessages = agent.state.messages;
          finish({
            type: 'error',
            error: normalizeProviderError(new Error('Pi agent ended without a terminal event')),
            usage,
            continuation: piMessages.length > 0 ? continuationFromPiMessages(piMessages) : null,
          });
        }
        channel.end();
      });

    try {
      yield* channel;
    } finally {
      if (!terminal) agent.abort();
      await pump;
      if (this.activeAgent === agent) this.activeAgent = null;
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
    }
  }

  identityEvent(sessionId) {
    return { type: 'provider', ...this.identity, ...(sessionId ? { sessionId } : {}) };
  }
}

/**
 * Pi transcript → canonical Kuhn continuation. Thinking blocks, images and
 * every provider/framework metadata field (api, provider, model, response
 * ids, usage, stop reasons, timestamps) are deliberately dropped — see
 * continuation.js for the portability rationale.
 */
export function continuationFromPiMessages(piMessages) {
  const messages = [];
  for (const message of piMessages) {
    if (message.role === 'user') {
      const content = typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : canonicalTextBlocks(message.content);
      if (content.length > 0) messages.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      const content = [];
      for (const block of message.content) {
        if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
        if (block.type === 'toolCall') {
          content.push({ type: 'tool_call', id: block.id, name: block.name, arguments: structuredClone(block.arguments ?? {}) });
        }
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
    } else if (message.role === 'toolResult') {
      messages.push({
        role: 'tool_result',
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: canonicalTextBlocks(message.content),
        isError: message.isError === true,
      });
    }
  }
  return createContinuation(messages);
}

/**
 * Canonical Kuhn continuation → Pi transcript for the model that will resume
 * the conversation. Pi requires provider/usage/stopReason metadata on replayed
 * assistant messages; it is synthesized here because rehydrated history is
 * context, not accounting — per-turn usage is only ever reported through
 * `done` events.
 */
export function piMessagesFromContinuation(continuation, model) {
  return continuation.messages.map((message) => {
    if (message.role === 'user') {
      return {
        role: 'user',
        content: message.content.map((block) => ({ type: 'text', text: block.text })),
        timestamp: Date.now(),
      };
    }
    if (message.role === 'assistant') {
      const content = message.content.map((block) => (block.type === 'text'
        ? { type: 'text', text: block.text }
        : { type: 'toolCall', id: block.id, name: block.name, arguments: structuredClone(block.arguments) }));
      return {
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyPiUsage(),
        stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
    }
    return {
      role: 'toolResult',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map((block) => ({ type: 'text', text: block.text })),
      isError: message.isError,
      timestamp: Date.now(),
    };
  });
}

function canonicalTextBlocks(content = []) {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => ({ type: 'text', text: block.text }));
}

function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Deterministic faux-provider runtime for tests; no credentials or network.
 * `models`/`modelId` may declare a non-default model (e.g. a reasoning
 * model); by default the faux provider's single `faux-1` text model.
 */
export function createFauxPiRuntime({
  responses = [], tools = [], systemPrompt = '', provider = 'kuhn-faux', models, modelId,
  continuation, tokensPerSecond, thinkingLevel,
} = {}) {
  const fauxOptions = {
    provider,
    tokenSize: { min: 2, max: 2 },
    tokensPerSecond,
  };
  if (models) fauxOptions.models = models;
  const faux = fauxProvider(fauxOptions);
  faux.setResponses(responses);
  const collection = createModels();
  collection.setProvider(faux.provider);
  const model = modelId ? faux.getModel(modelId) : faux.models[0];
  if (!model) throw new Error(`Unknown faux model: ${modelId}`);
  const runtime = new PiAgentRuntime({
    models: collection,
    model,
    systemPrompt,
    tools,
    continuation,
    thinkingLevel,
  });
  return { runtime, faux, models: collection, model };
}

/**
 * Configurable OpenAI-compatible endpoint path (vLLM/Ollama/LiteLLM/etc.).
 * Credentials are resolved from a named environment variable; they never
 * enter model metadata or continuation state.
 */
export function createOpenAICompatiblePiRuntime({
  baseUrl,
  modelId,
  providerId = 'openai-compatible',
  apiKeyEnv = 'OPENAI_COMPATIBLE_API_KEY',
  name = modelId,
  reasoning = false,
  input = ['text'],
  contextWindow = 128_000,
  maxTokens = 16_384,
  compat = {},
  tools = [],
  systemPrompt = '',
  continuation,
} = {}) {
  const endpoint = validateEndpoint(baseUrl);
  if (!modelId) throw new Error('modelId is required');

  const model = {
    id: modelId,
    name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl: endpoint,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat,
  };
  const provider = createProvider({
    id: providerId,
    name: providerId,
    baseUrl: endpoint,
    auth: { apiKey: envApiKeyAuth(`${providerId} API key`, [apiKeyEnv]) },
    models: [model],
    api: openAICompletionsApi(),
  });
  const collection = createModels();
  collection.setProvider(provider);
  return {
    runtime: new PiAgentRuntime({ models: collection, model, tools, systemPrompt, continuation }),
    models: collection,
    model,
    provider,
  };
}

/** Real, non-Anthropic OpenAI path used by the optional live smoke. */
export function createOpenAIPiRuntime({ modelId = 'gpt-5-mini', tools = [], systemPrompt = '', continuation } = {}) {
  const provider = openaiProvider();
  const collection = createModels();
  collection.setProvider(provider);
  const model = collection.getModel('openai', modelId);
  if (!model) throw new Error(`Unknown OpenAI model: ${modelId}`);
  return {
    runtime: new PiAgentRuntime({ models: collection, model, tools, systemPrompt, continuation }),
    models: collection,
    model,
    provider,
  };
}

/** Real non-Anthropic model path through OpenRouter for the optional live smoke. */
export function createOpenRouterPiRuntime({
  modelId = 'openai/gpt-oss-20b', tools = [], systemPrompt = '', continuation,
} = {}) {
  const provider = openrouterProvider();
  const collection = createModels();
  collection.setProvider(provider);
  const model = collection.getModel('openrouter', modelId);
  if (!model) throw new Error(`Unknown OpenRouter model: ${modelId}`);
  return {
    runtime: new PiAgentRuntime({ models: collection, model, tools, systemPrompt, continuation }),
    models: collection,
    model,
    provider,
  };
}

function validateEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('baseUrl must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('baseUrl must use http or https');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('baseUrl must not contain credentials, query parameters, or fragments');
  }
  return endpoint.toString().replace(/\/$/, '');
}
