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

/**
 * Isolated Pi-core spike. It intentionally does not import storage, jobs,
 * questions, pending edits, or any other Kuhn domain module. Those remain the
 * responsibility of runAgentTask() and the future Kuhn-owned tool registry.
 */
export class PiRuntimeSpike {
  constructor({ models, model, systemPrompt = '', tools = [], continuation, thinkingLevel } = {}) {
    if (!models || !model) throw new Error('PiRuntimeSpike requires a models collection and model');
    this.models = models;
    this.model = model;
    this.agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: thinkingLevel ?? (model.reasoning ? 'medium' : 'off'),
        tools: [...tools],
        messages: structuredClone(continuation?.messages ?? []),
      },
      streamFn: models.streamSimple.bind(models),
      toolExecution: 'sequential',
    });
    this.running = false;
  }

  /** @returns {AsyncGenerator<object>} normalized provider-runtime events */
  async *runTurn({ input, signal, continuation } = {}) {
    if (this.running) throw new Error('PiRuntimeSpike does not allow concurrent turns');
    if (typeof input !== 'string' || input.length === 0) throw new Error('runTurn input must be a non-empty string');
    if (continuation) this.agent.state.messages = structuredClone(continuation.messages);

    this.running = true;
    const channel = new EventChannel();
    let usage = normalizeUsage();
    let terminal = false;

    const finish = (event) => {
      if (terminal) return;
      terminal = true;
      channel.push(event);
    };

    const unsubscribe = this.agent.subscribe((event) => {
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
        usage = addUsage(usage, event.message.usage);
        const text = event.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (text) channel.push({ type: 'text', content: text });
        return;
      }
      if (event.type !== 'agent_end') return;

      const lastAssistant = [...event.messages].reverse().find((message) => message.role === 'assistant');
      if (lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted') {
        finish({
          type: 'error',
          error: normalizeProviderError(
            new Error(lastAssistant.errorMessage ?? `Provider stopped with ${lastAssistant.stopReason}`),
            { stopReason: lastAssistant.stopReason },
          ),
          usage,
        });
        return;
      }

      finish({
        type: 'done',
        finishReason: lastAssistant?.stopReason ?? 'stop',
        usage,
        continuation: { version: 1, messages: structuredClone(this.agent.state.messages) },
      });
    });

    const onAbort = () => this.agent.abort();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    channel.push({
      type: 'provider',
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
    });

    const pump = this.agent.prompt(input)
      .catch((error) => finish({ type: 'error', error: normalizeProviderError(error), usage }))
      .finally(() => {
        if (!terminal) {
          finish({
            type: 'error',
            error: normalizeProviderError(new Error('Pi agent ended without a terminal event')),
            usage,
          });
        }
        channel.end();
      });

    try {
      yield* channel;
    } finally {
      if (!terminal) this.agent.abort();
      await pump;
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      this.running = false;
    }
  }
}

/** Deterministic Pi model path for tests; no credentials or network. */
export function createFauxPiRuntime({
  responses = [], tools = [], systemPrompt = '', provider = 'kuhn-faux', continuation, tokensPerSecond,
} = {}) {
  const faux = fauxProvider({ provider, tokenSize: { min: 2, max: 2 }, tokensPerSecond });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiRuntimeSpike({
    models,
    model: faux.getModel(),
    systemPrompt,
    tools,
    continuation,
  });
  return { runtime, faux, models };
}

/**
 * Configurable OpenAI-compatible path (vLLM/Ollama/LiteLLM/etc.). Credentials
 * are resolved from a named environment variable; they never enter model
 * metadata or continuation state.
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
  const models = createModels();
  models.setProvider(provider);
  return {
    runtime: new PiRuntimeSpike({ models, model, tools, systemPrompt, continuation }),
    models,
    model,
    provider,
  };
}

/** Real, non-Anthropic OpenAI path used by the optional live smoke. */
export function createOpenAIPiRuntime({ modelId = 'gpt-5-mini', tools = [], systemPrompt = '', continuation } = {}) {
  const provider = openaiProvider();
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel('openai', modelId);
  if (!model) throw new Error(`Unknown OpenAI model: ${modelId}`);
  return {
    runtime: new PiRuntimeSpike({ models, model, tools, systemPrompt, continuation }),
    models,
    model,
    provider,
  };
}

/** Real non-Anthropic model path through OpenRouter for the optional live smoke. */
export function createOpenRouterPiRuntime({
  modelId = 'openai/gpt-oss-20b:free', tools = [], systemPrompt = '', continuation,
} = {}) {
  const provider = openrouterProvider();
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel('openrouter', modelId);
  if (!model) throw new Error(`Unknown OpenRouter model: ${modelId}`);
  return {
    runtime: new PiRuntimeSpike({ models, model, tools, systemPrompt, continuation }),
    models,
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
