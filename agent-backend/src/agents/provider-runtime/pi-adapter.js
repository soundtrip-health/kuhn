import { Agent } from '@earendil-works/pi-agent-core';
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxProvider,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';

import { EventChannel } from '../events.js';
import { UNRESOLVED_TOOL_RESULT_TEXT, addUsage, normalizeProviderError, normalizeUsage } from './contract.js';
import { assertContinuation, createContinuation } from './continuation.js';
import { validateArgs } from '../tools/validate.js';

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
 * - Credentials come only from the explicitly named credential
 *   environment variable for the provider path (or the faux provider's
 *   no-op auth): the named variable is the only one consulted — the
 *   provider's default name is never silently consulted as a fallback —
 *   and no personal Pi auth store, OAuth profile, or ambient credential
 *   file is read. A missing key fails the turn with a normalized
 *   `provider_error` instead of borrowing another credential.
 * - Pi's transport-level request retry is left at its default of zero, so
 *   provider failures surface as exactly one terminal `error` event. Any
 *   retry policy stays above the runtime seam.
 * - Kuhn tool failures are encoded in the result envelope (`isError: true`,
 *   never thrown); Pi's tool contract derives `isError` from a throw. The
 *   adapter translates a failure envelope into a throw carrying the
 *   model-facing text, so the `tool_result` event and the model both see
 *   the failure.
 * - Normalized tool-call ordering: an assistant message's `tool_call`
 *   events are emitted from the message's `message_end` — from the final
 *   content's toolCall blocks — BEFORE the message's `usage` event, so the
 *   normalized order per message is `text -> tool_call(s) -> usage ->
 *   tool_result(s)` (identical to the Claude adapter). The product seam
 *   writes the assistant conversation row when the usage arrives, so the
 *   row must already carry its tool calls. `tool_execution_start` no
 *   longer emits the call (it would land after the usage); `tool_result`
 *   still comes from execution completion, and a call the turn ended
 *   before executing is closed in the canonical continuation (never as a
 *   second event), keeping the lifecycle exactly-once.
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
  constructor({ models, model, systemPrompt = '', tools = [], continuation, thinkingLevel, maxTurns = null } = {}) {
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
          // Neutral argument contract (STH-1): Kuhn's validator — not the
          // provider's JSON-schema layer — decides whether a model-supplied
          // argument set is valid, and applies the schema defaults before
          // the handler runs. Claude and Pi therefore agree on validity.
          const validated = validateArgs(tool.parameters, args);
          if (!validated.ok) {
            throw new Error(`Invalid arguments: ${validated.errors.join('; ')}`);
          }
          const result = await tool.execute(toolCallId, validated.value, signal, onUpdate);
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
    if (maxTurns != null && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
      throw new Error('maxTurns must be a positive integer or null');
    }
    this.maxTurns = maxTurns;
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
   *   systemPrompt?: string, resume?: string|null,
   *   retry?: boolean }} turn
   * @returns {AsyncGenerator<object>} normalized provider-runtime events
   */
  async *runTurn({ input, signal, continuation, systemPrompt, resume = null, retry = false } = {}) {
    if (typeof input !== 'string' || input.length === 0) {
      throw new Error('runTurn input must be a non-empty string');
    }
    // One active turn per instance (STH-47): the cancellation state is
    // instance-global and Kuhn's runtime is request/job-scoped, so a second
    // concurrent runTurn on the same instance would share ambiguous
    // state. Refuse it loudly (identity opens the transcript, then exactly
    // one non-retryable error); separate instances run concurrently.
    if (this.activeAgent) {
      yield this.identityEvent(resume);
      yield {
        type: 'error',
        error: {
          code: 'invalid_request',
          message: 'one active turn per runtime instance: a turn is already in flight',
          retryable: false,
          status: null,
        },
      };
      return;
    }
    let history = continuation
      ? piMessagesFromContinuation(assertContinuation(continuation), this.model)
      : this.initialMessages;
    let promptMode = 'prompt';
    if (continuation && retry) {
      // A retry resumes the failed attempt's canonical record, which already
      // carries this logical user input — appending it again would duplicate
      // the turn. Trim the trailing partial assistant message the failure
      // left behind and continue from the record; the record then ends with
      // a user or tool-result message (the continue path's requirement).
      while (history.at(-1)?.role === 'assistant') history.pop();
      promptMode = 'continue';
    }
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
    let assistantTurns = 0;
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
      // Max-turn parity (STH-47): the product's per-run turn cap (Claude's
      // AGENT_MAX_TURNS) stops the loop once the cap is reached and a tool
      // result is pending — the same cutoff the Claude SDK applies.
      ...(this.maxTurns != null
        ? { shouldStopAfterTurn: () => assistantTurns >= this.maxTurns }
        : {}),
    });

    this.activeAgent = agent;
    this.cancelRequested = false;

    const channel = new EventChannel();
    let usage = normalizeUsage();
    let terminal = false;
    // Exactly-once tool lifecycle (STH-47): every normalized tool_call
    // emitted from a message's message_end must be paired with exactly one
    // tool_result before the terminal event. Pi finalizes every call it
    // starts — tool_execution_end always lands for an executed call — but
    // a turn that ends (abort, max-turns cutoff, provider error) before
    // execution begins never reaches it. The normalized contract closes
    // such a call with one synthetic error tool_result — the same closure
    // the canonical continuation carries (UNRESOLVED_TOOL_RESULT_TEXT) —
    // and finish() is the single exactly-once terminal site, so no
    // cancellation path can leave a dangling call in the stream.
    const emittedToolCalls = new Map(); // call id -> name, from message_end
    const resolvedToolCalls = new Set(); // call ids that reached tool_execution_end

    const finish = (event) => {
      if (terminal) return;
      terminal = true;
      for (const [id, name] of emittedToolCalls) {
        if (resolvedToolCalls.has(id)) continue;
        channel.push({
          type: 'tool_result',
          id,
          name,
          content: [{ type: 'text', text: UNRESOLVED_TOOL_RESULT_TEXT }],
          isError: true,
        });
      }
      channel.push(event);
    };

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        channel.push({ type: 'text_delta', content: event.assistantMessageEvent.delta });
        return;
      }
      // The normalized tool_call is emitted from this assistant message's
      // message_end, before the message's usage event (the ordering the
      // product seam persists on: the assistant conversation row is written
      // when the usage arrives and must already carry the message's tool
      // calls). Pi's tool_execution_start is execution bookkeeping only.
      if (event.type === 'tool_execution_end') {
        // This call reached execution: its real result is the exactly-once
        // pairing — the terminal must not synthesize a second one.
        resolvedToolCalls.add(event.toolCallId);
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
        assistantTurns += 1;
        const messageUsage = normalizeUsage(event.message.usage);
        const text = event.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (text) channel.push({ type: 'text', content: text });
        // Ordering contract (STH-47): the tool calls the message requested
        // are part of the message — record them BEFORE the message's usage
        // event, so the normalized order per assistant message is
        // text -> tool_call(s) -> usage -> tool_result(s), the same order
        // the Claude adapter emits from its assistant message. Each
        // toolCall block appears exactly once in the final content, so the
        // tool_call lifecycle stays exactly-once (the duplicate emission
        // from tool_execution_start is gone).
        for (const block of event.message.content) {
          if (block.type !== 'toolCall' || !block.id || !block.name) continue;
          emittedToolCalls.set(block.id, block.name);
          channel.push({
            type: 'tool_call',
            id: block.id,
            name: block.name,
            arguments: structuredClone(block.arguments ?? {}),
          });
        }
        usage = addUsage(usage, messageUsage);
        channel.push({ type: 'usage', usage: messageUsage });
        return;
      }
      if (event.type !== 'agent_end') return;

      const lastAssistant = [...agent.state.messages].reverse().find((message) => message.role === 'assistant');
      // The caller's explicit abort is the strong signal, ahead of the
      // agent's own final stop reason: the product can abort on this very
      // turn's usage event (budget cutoff) or the moment the consumer
      // disconnects — the agent loop may then finish its final message
      // naturally before the abort lands. In that case the terminal is a
      // cancelled error, not done: the product already stamped the job's
      // abort status, and a done terminal would overwrite it.
      if (signal?.aborted || this.cancelRequested) {
        finish({
          type: 'error',
          error: normalizeProviderError(
            signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'),
            { stopReason: 'aborted' },
          ),
          usage,
          continuation: agent.state.messages.length > 0 ? continuationFromPiMessages(agent.state.messages) : null,
        });
        return;
      }
      // Max-turn parity (STH-47): the product cap stopped the loop with a
      // pending tool call — the same terminal the Claude SDK's
      // error_max_turns result subtype produces. The record is structurally
      // closed (the executed tool result is in it), so a retry can resume
      // from that tool result.
      if (this.maxTurns != null && assistantTurns >= this.maxTurns && lastAssistant?.stopReason === 'toolUse') {
        finish({
          type: 'error',
          error: { code: 'max_turns', message: 'max turns', retryable: false, status: null },
          usage,
          continuation: continuationFromPiMessages(agent.state.messages),
        });
        return;
      }
      if (lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted') {
        // When Kuhn's signal aborted (or cancel() interrupted the turn), Pi
        // can surface the abort through internal setup steps (auth
        // resolution, stream start) as an 'error' stop with the abort reason
        // as its message — the abort context is lost at the Pi boundary.
        // (Caller aborts are classified above, before the stop reason is
        // read; this path keeps the provider-error rendering for aborts
        // surfaced through internal setup steps.)
        const error = normalizeProviderError(
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

    const onAbort = () => {
      this.cancelRequested = true;
      agent.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    channel.push(this.identityEvent(resume));

    const pump = (promptMode === 'continue' ? agent.continue() : agent.prompt(input))
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
 * A tool call the turn ended before executing (an interrupted/aborted turn):
 * the canonical record must stay canonical — a transcript ending in an
 * unanswered tool_call is rejected by the validator and by provider APIs at
 * resume. The Claude adapter closes the same situation with an explicit
 * error marker in its record; the Pi transcript gets the identical closure.
 * Executed calls always carry their real result in the transcript (Pi
 * finalizes every started call, including aborted ones), so this only ever
 * closes never-executed calls — the exactly-once lifecycle is preserved.
 */
// (UNRESOLVED_TOOL_RESULT_TEXT is shared with the Claude adapter via contract.js.)

/**
 * Pi transcript → canonical Kuhn continuation. Thinking blocks, images and
 * every provider/framework metadata field (api, provider, model, response
 * ids, usage, stop reasons, timestamps) are deliberately dropped — see
 * continuation.js for the portability rationale.
 *
 * Dangling tool calls (see UNRESOLVED_TOOL_RESULT_TEXT) are closed with an
 * explicit error tool_result before the envelope is validated.
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
        // A degenerate partial toolCall (an abort mid-stream can leave a
        // block without id/name) cannot be canonical and cannot be
        // referenced by a result — drop it rather than crash the terminal.
        if (block.type === 'toolCall' && block.id && block.name) {
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
  const resulted = new Set(messages
    .filter((message) => message.role === 'tool_result')
    .map((message) => message.toolCallId));
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_call' || !block.id || resulted.has(block.id)) continue;
      resulted.add(block.id);
      messages.push({
        role: 'tool_result',
        toolCallId: block.id,
        toolName: block.name,
        content: [{ type: 'text', text: UNRESOLVED_TOOL_RESULT_TEXT }],
        isError: true,
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
 *
 * `declaredUsage` (conformance harness): a per-model-call slot list. The
 * faux provider estimates usage from content; the declared-usage contract
 * replaces every final message's usage with the scenario's declared tokens
 * (the same declared-only inputs the Claude conformance driver scripts), so
 * the app's budget logic never sees a provider content estimate. A missing
 * or null slot (a model call the scenario did not script, e.g. the
 * provider-failure response) reports zero.
 */
export function createFauxPiRuntime({
  responses = [], tools = [], systemPrompt = '', provider = 'kuhn-faux', models, modelId,
  continuation, tokensPerSecond, thinkingLevel, maxTurns, declaredUsage,
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
  if (declaredUsage) {
    const originalStreamSimple = collection.streamSimple.bind(collection);
    let usageIndex = 0;
    collection.streamSimple = (model, context, options) => {
      const stream = originalStreamSimple(model, context, options);
      const declared = declaredUsage[usageIndex] ?? { input: 0, output: 0 };
      usageIndex += 1;
      const innerResult = stream.result();
      return {
        [Symbol.asyncIterator]: () => {
          const it = stream[Symbol.asyncIterator]();
          return { next: () => it.next(), return: (v) => it.return?.(v), throw: (e) => it.throw?.(e) };
        },
        result: async () => {
          const final = await innerResult;
          if (!final) return final;
          const usage = {
            input: declared.input ?? 0,
            output: declared.output ?? 0,
            cacheRead: declared.cacheRead ?? 0,
            cacheWrite: declared.cacheWrite ?? 0,
          };
          return {
            ...final,
            usage: {
              ...usage,
              totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        },
      };
    };
  }
  const model = modelId ? faux.getModel(modelId) : faux.models[0];
  if (!model) throw new Error(`Unknown faux model: ${modelId}`);
  const runtime = new PiAgentRuntime({
    models: collection,
    model,
    systemPrompt,
    tools,
    continuation,
    thinkingLevel,
    maxTurns,
  });
  return { runtime, faux, models: collection, model };
}

/**
 * Api-key auth for a credential Kuhn already resolved server-side (an org
 * secret, issue #111). The value lives only in this closure: it is never
 * placed on the model entry, the provider descriptor's public fields, the
 * continuation, or any event. No env var is consulted or mutated.
 */
export function staticApiKeyAuth(name, apiKey) {
  return {
    name,
    resolve: async ({ signal }) => {
      signal?.throwIfAborted?.();
      return { auth: { apiKey }, source: 'org secret' };
    },
  };
}

/**
 * Placeholder credential for a keyless local endpoint (issue #112: an
 * Ollama / vLLM server with no auth). pi-ai refuses to send a request with
 * no key, and such servers ignore the bearer, so this resolves to a fixed
 * non-secret token. Only the profile path asks for it explicitly.
 */
export const KEYLESS_PLACEHOLDER = 'none';
export function keylessAuth(name) {
  return {
    name,
    resolve: async ({ signal }) => {
      signal?.throwIfAborted?.();
      return { auth: { apiKey: KEYLESS_PLACEHOLDER }, source: 'no credential (local endpoint)' };
    },
  };
}

/**
 * A catalog entry with the owner's explicit capability overrides applied
 * (issue #111): a pinned context window or output cap replaces the
 * published value for this runtime only; the catalog object is untouched.
 */
function withOverrides(models, modelId, overrides) {
  if (!overrides || typeof overrides !== 'object') return models;
  const keys = ['reasoning', 'input', 'contextWindow', 'maxTokens'].filter((k) => overrides[k] !== undefined);
  if (keys.length === 0) return models;
  return models.map((m) => (m.id === modelId ? { ...m, ...Object.fromEntries(keys.map((k) => [k, overrides[k]])) } : m));
}

/** The auth for a provider path: a resolved key wins, then a keyless
 * placeholder when explicitly requested, else the named env var. */
function providerAuth(name, { apiKey, apiKeyEnv, keyless = false }) {
  if (apiKey) return staticApiKeyAuth(name, apiKey);
  if (keyless) return keylessAuth(name);
  return envApiKeyAuth(name, [apiKeyEnv]);
}

/**
 * A model entry for an id the provider catalog does not list (issue #112:
 * declared metadata for endpoints that cannot be auto-discovered). Cost is
 * zero here — Kuhn's own budget weighting (the profile's cost_weight) is
 * what meters spend, never pi-ai's price table.
 */
function declaredModel({ id, provider, api, baseUrl, name = id, reasoning = false, input = ['text'], contextWindow = 128_000, maxTokens = 16_384, compat = {} }) {
  return {
    id,
    name,
    api,
    provider,
    baseUrl,
    reasoning,
    input: [...input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat,
  };
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
  apiKey = null,
  keyless = false,
  name = modelId,
  reasoning = false,
  input = ['text'],
  contextWindow = 128_000,
  maxTokens = 16_384,
  compat = {},
  tools = [],
  systemPrompt = '',
  continuation,
  maxTurns,
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
    auth: { apiKey: providerAuth(`${providerId} API key`, { apiKey, apiKeyEnv, keyless }) },
    models: [model],
    api: openAICompletionsApi(),
  });
  const collection = createModels();
  collection.setProvider(provider);
  return {
    runtime: new PiAgentRuntime({ models: collection, model, tools, systemPrompt, continuation, maxTurns }),
    models: collection,
    model,
    provider,
  };
}

/**
 * Real, non-Anthropic OpenAI path used by the optional live smoke. Built
 * exactly like pi-ai's `openaiProvider()` (same id, endpoint, model
 * catalog, and API), except the credential resolves from the explicitly
 * named environment variable (`apiKeyEnv`; default `OPENAI_API_KEY`) — the
 * only variable consulted. The key is never read by name in Kuhn code and
 * never enters model metadata or continuation state.
 */
export function createOpenAIPiRuntime({
  modelId = 'gpt-5-mini',
  apiKeyEnv = 'OPENAI_API_KEY',
  apiKey = null,
  capabilities = null,
  capabilityOverrides = null,
  tools = [],
  systemPrompt = '',
  continuation,
  maxTurns,
} = {}) {
  const baseUrl = 'https://api.openai.com/v1';
  const catalog = Object.values(OPENAI_MODELS);
  // A model id the pinned catalog does not know runs on its declared
  // metadata (issue #112) — the catalog is a convenience, not an allowlist.
  const declared = catalog.some((m) => m.id === modelId) || !capabilities
    ? null
    : declaredModel({ id: modelId, provider: 'openai', api: 'openai-responses', baseUrl, ...capabilities });
  const provider = createProvider({
    id: 'openai',
    name: 'OpenAI',
    baseUrl,
    auth: { apiKey: providerAuth('OpenAI API key', { apiKey, apiKeyEnv }) },
    models: withOverrides(declared ? [...catalog, declared] : catalog, modelId, capabilityOverrides),
    api: openAIResponsesApi(),
  });
  const collection = createModels();
  collection.setProvider(provider);
  const model = collection.getModel('openai', modelId);
  if (!model) throw new Error(`Unknown OpenAI model: ${modelId}`);
  return {
    runtime: new PiAgentRuntime({ models: collection, model, tools, systemPrompt, continuation, maxTurns }),
    models: collection,
    model,
    provider,
  };
}

/**
 * Real non-Anthropic model path through OpenRouter for the optional live
 * smoke. Built exactly like pi-ai's `openrouterProvider()` (same id,
 * endpoint, model catalog, and API), except the credential resolves from
 * the explicitly named environment variable (`apiKeyEnv`; default
 * `OPENROUTER_API_KEY`) — the only variable consulted — and the built-in
 * OAuth entry is omitted: the preview documents the API-key path only and
 * no OAuth profile is consulted.
 */
export function createOpenRouterPiRuntime({
  modelId = 'openai/gpt-oss-20b',
  apiKeyEnv = 'OPENROUTER_API_KEY',
  apiKey = null,
  capabilities = null,
  capabilityOverrides = null,
  tools = [],
  systemPrompt = '',
  continuation,
  maxTurns,
} = {}) {
  const baseUrl = 'https://openrouter.ai/api/v1';
  const catalog = Object.values(OPENROUTER_MODELS);
  const declared = catalog.some((m) => m.id === modelId) || !capabilities
    ? null
    : declaredModel({ id: modelId, provider: 'openrouter', api: 'openai-completions', baseUrl, ...capabilities });
  const provider = createProvider({
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl,
    auth: { apiKey: providerAuth('OpenRouter API key', { apiKey, apiKeyEnv }) },
    models: withOverrides(declared ? [...catalog, declared] : catalog, modelId, capabilityOverrides),
    api: openAICompletionsApi(),
  });
  const collection = createModels();
  collection.setProvider(provider);
  const model = collection.getModel('openrouter', modelId);
  if (!model) throw new Error(`Unknown OpenRouter model: ${modelId}`);
  return {
    runtime: new PiAgentRuntime({ models: collection, model, tools, systemPrompt, continuation, maxTurns }),
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
