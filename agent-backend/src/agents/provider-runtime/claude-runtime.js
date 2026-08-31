/**
 * Claude AgentRuntime adapter (STH-7): the production model-execution
 * boundary beneath runAgentTask(). This is the ONLY production module that
 * imports Claude SDK objects or understands Claude message shapes.
 *
 * It implements the AgentRuntime contract (./contract.js): runTurn() yields
 * normalized events — provider identity, text deltas + final text,
 * tool_call/tool_result lifecycle, per-turn usage, and exactly one terminal
 * `done` (with the canonical Kuhn continuation) or `error` (with a
 * normalized provider failure). Kuhn product concerns (jobs, conversations,
 * budgets, questions, retries/backoff, event publication) stay ABOVE this
 * adapter in agents/runtime.js; Pi (STH-8) replaces this adapter, not the
 * product layer.
 *
 * Continuation semantics: the canonical transcript is threaded across
 * attempts. Retry semantics (contract.js): a turn with a `null`
 * continuation starts a fresh record — the input is appended exactly once.
 * A turn carrying a continuation RESUMES that record: the record already
 * contains the turn's user input (recorded by the failed attempt), so it
 * is never appended again — one logical user request appears exactly once
 * in the canonical record across attempts. The Claude session (when one
 * was allocated) is the model's source of truth (the adapter passes
 * `resume` and does not re-send the record to the model), while
 * `done.continuation` is always the FULL record — so a later
 * provider-neutral adapter (Pi) can resume the same conversation natively.
 * Error terminals carry the partial transcript the same way (`error.
 * continuation`) so a retried attempt keeps the record complete.
 *
 * A FRESH Claude conversation (no session) is always seeded from the task
 * input alone; Claude has no mechanism to replay a canonical transcript
 * into a new session. That is a documented transitional limitation of the
 * Claude adapter, not of the seam — the canonical continuation remains
 * authoritative Kuhn state.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { addUsage, normalizeProviderError, normalizeUsage, toolResultText } from './contract.js';
import { assertContinuation, createContinuation } from './continuation.js';
import { buildClaudeToolSet, CLAUDE_MCP_SERVER_NAME, toNeutralToolName } from './claude-tools.js';

export const CLAUDE_PROVIDER = 'anthropic';
const CLAUDE_API = 'claude-agent-sdk';

/**
 * Claude Agent SDK result subtypes that end a completed turn with a failure
 * reason (the SDK finished normally and reports why). Mapped to
 * non-retryable terminal codes OUTSIDE the provider-failure vocabulary, so
 * the product layer renders them as "Agent task stopped: <reason>" instead
 * of treating them as an upstream outage.
 */
const RESULT_SUBTYPE_CODES = {
  error_max_turns: 'max_turns',
  error_during_execution: 'during_execution',
};

/**
 * @param {object} args
 * @param {string} args.model - the model id Kuhn requested (per-role DB
 *   model or the global fallback)
 * @param {string} args.projectDir - the project workspace (SDK cwd)
 * @param {Array<object>} [args.tools] - neutral tool descriptors (agents/tools)
 * @param {number} [args.maxTurns] - Kuhn's per-run turn cap
 * @param {string|null} [args.initialSessionId] - session to resume when the
 *   task was started with one
 * @returns {object} AgentRuntime: { provider, model, cancel(), runTurn(turn) }
 */
export function createClaudeRuntime({
  model, projectDir, tools = [], maxTurns, initialSessionId = null,
} = {}) {
  const { mcpServer, builtinTools, allowedTools, claudeToNeutral } = buildClaudeToolSet(tools);
  let activeQuery = null;

  /** Interrupt the in-flight SDK query (task teardown / budget cutoff). */
  function cancel() {
    const q = activeQuery;
    if (q?.interrupt) Promise.resolve(q.interrupt()).catch(() => { /* already stopped */ });
  }

  const identityEvent = (sessionId) => ({
    type: 'provider',
    provider: CLAUDE_PROVIDER,
    model,
    api: CLAUDE_API,
    ...(sessionId ? { sessionId } : {}),
  });

  const cancelledError = (signal) => normalizeProviderError(
    signal?.reason ?? new DOMException('Aborted', 'AbortError'),
    { stopReason: 'aborted' },
  );

  /** Canonical (disjoint-component) usage from a Claude message usage. */
  const toCanonicalUsage = (usage) => normalizeUsage({
    inputTokens: usage.input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    outputTokens: usage.output_tokens,
  });

  /**
   * @param {{ input: string, signal?: AbortSignal, resume?: string|null,
   *   systemPrompt?: string, continuation?: {version: number, messages: Array<object>}|null,
   *   retry?: boolean }} turn
   */
  async function* runTurn({ input, signal, resume = null, systemPrompt, continuation = null, retry = false } = {}) {
    const sessionId = resume ?? initialSessionId ?? null;
    // Identity first, before any provider work (contract pre-abort rule).
    yield identityEvent(sessionId);
    if (signal?.aborted) {
      yield { type: 'error', error: cancelledError(signal) };
      return;
    }

    // Canonical transcript: the threaded record (previous attempts,
    // including a failed partial) plus this turn's messages. Retry
    // semantics (contract.js): only a RETRY turn (retry: true with a
    // non-null continuation) skips the append — that record is the
    // failed attempt's transcript of this same request and already
    // contains its user input. Fresh turns and follow-ups append the
    // input exactly once. The distinction is the product's explicit
    // flag — never string matching on the input text.
    const isRetry = continuation != null && retry;
    const messages = continuation
      ? structuredClone(assertContinuation(continuation).messages)
      : [];
    if (!isRetry) {
      messages.push({ role: 'user', content: [{ type: 'text', text: input }] });
    }

    const pendingCalls = new Map(); // tool_use id → tool name
    let assistantBlocks = [];
    let sessionUsage = null;
    let terminal = false;

    const onAbort = () => cancel();
    signal?.addEventListener('abort', onAbort, { once: true });

    const flushAssistant = () => {
      if (assistantBlocks.length > 0) {
        messages.push({ role: 'assistant', content: assistantBlocks });
        assistantBlocks = [];
      }
    };

    // A provider stream can end with a tool_use that never received its
    // tool_result (a malformed/truncated stream). The canonical continuation
    // must stay canonical, so such calls are closed with an explicit error
    // marker instead of being dropped or left dangling. Real Claude streams
    // resolve every call before the result message; this is defensive.
    const UNRESOLVED_TOOL_RESULT_TEXT =
      '(unresolved: the provider stream ended without a result for this tool call)';
    const resolveUnresolvedCalls = () => {
      for (const [id, name] of pendingCalls) {
        messages.push({
          role: 'tool_result',
          toolCallId: id,
          toolName: name,
          content: [{ type: 'text', text: UNRESOLVED_TOOL_RESULT_TEXT }],
          isError: true,
        });
      }
      pendingCalls.clear();
    };

    // Never throws: a transcript the canonical builder refuses is carried as
    // null rather than taking the terminal emission down with it.
    const safeContinuation = () => {
      if (messages.length === 0) return null;
      try {
        return createContinuation(messages);
      } catch {
        return null;
      }
    };

    const sdk = sdkQuery({
      prompt: input,
      options: {
        ...(systemPrompt ? { systemPrompt } : {}),
        cwd: projectDir,
        model,
        maxTurns,
        tools: builtinTools,
        allowedTools,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true, // token-level text_delta events (story 013)
        settingSources: [], // never load host CLAUDE.md / settings into agent context
        ...(mcpServer ? { mcpServers: { [CLAUDE_MCP_SERVER_NAME]: mcpServer } } : {}),
        // Resume the live session on retry so the agent continues from where
        // a transient failure interrupted it, not from scratch (story 029).
        ...(sessionId ? { resume: sessionId } : {}),
      },
    });
    activeQuery = sdk;

    try {
      for await (const message of sdk) {
        switch (message.type) {
          case 'system': {
            if (message.subtype === 'init' && message.session_id) {
              yield identityEvent(message.session_id);
            }
            break;
          }
          case 'stream_event': {
            // Token-level streaming: forward text deltas as they arrive. The
            // full turn still follows as a single `text` event (the chat UI
            // replaces accumulated deltas with it); logging/budgeting stay
            // turn-based.
            const event = message.event;
            if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
              yield { type: 'text_delta', content: event.delta.text };
            }
            break;
          }
          case 'assistant': {
            const blocks = message.message?.content ?? [];
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
            if (text) {
              assistantBlocks.push({ type: 'text', text });
              yield { type: 'text', content: text };
            }
            for (const block of blocks.filter((b) => b.type === 'tool_use')) {
              // Neutral Kuhn tool name in the canonical contract (STH-47):
              // the SDK reports Claude MCP-qualified names
              // (mcp__kuhn__write_file); the canonical events and
              // continuation carry the stable neutral name so the same
              // record resumes on any adapter.
              const neutralName = toNeutralToolName(block.name, claudeToNeutral);
              pendingCalls.set(block.id, neutralName);
              const call = { type: 'tool_call', id: block.id, name: neutralName, arguments: structuredClone(block.input ?? {}) };
              assistantBlocks.push(call);
              yield { type: 'tool_call', id: block.id, name: neutralName, arguments: structuredClone(call.arguments) };
            }
            const msgUsage = message.message?.usage;
            if (msgUsage) {
              const usage = toCanonicalUsage(msgUsage);
              sessionUsage = addUsage(sessionUsage, usage);
              yield { type: 'usage', usage };
            }
            break;
          }
          case 'user': {
            // Tool results echoed back into the loop.
            for (const block of message.message?.content ?? []) {
              if (block.type !== 'tool_result') continue;
              flushAssistant();
              const name = pendingCalls.get(block.tool_use_id) ?? 'unknown';
              pendingCalls.delete(block.tool_use_id);
              const isError = block.is_error === true;
              const content = [{ type: 'text', text: toolResultText(block.content) }];
              messages.push({
                role: 'tool_result',
                toolCallId: block.tool_use_id,
                toolName: name,
                content: structuredClone(content),
                isError,
              });
              yield { type: 'tool_result', id: block.tool_use_id, name, content: structuredClone(content), isError };
            }
            break;
          }
          case 'result': {
            flushAssistant();
            resolveUnresolvedCalls();
            const resultUsage = message.usage;
            const finalUsage = (resultUsage && (resultUsage.input_tokens != null || resultUsage.output_tokens != null))
              ? toCanonicalUsage(resultUsage)
              : (sessionUsage ?? normalizeUsage());
            if (message.subtype === 'success') {
              yield {
                type: 'done',
                finishReason: 'stop',
                usage: finalUsage,
                continuation: safeContinuation(),
              };
            } else {
              const code = RESULT_SUBTYPE_CODES[message.subtype] ?? message.subtype.replace(/^error_/, '');
              yield {
                type: 'error',
                error: { code, message: code.replaceAll('_', ' '), retryable: false, status: null },
                usage: finalUsage,
                continuation: safeContinuation(),
              };
            }
            terminal = true;
            break;
          }
          default:
            // Unrecognized Claude message shape: not a contract event.
            break;
        }
        if (signal?.aborted) break;
      }
    } catch (err) {
      if (!terminal) {
        flushAssistant();
        resolveUnresolvedCalls();
        yield {
          type: 'error',
          error: normalizeProviderError(err, { stopReason: signal?.aborted ? 'aborted' : undefined }),
          usage: sessionUsage,
          continuation: safeContinuation(),
        };
        terminal = true;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (activeQuery === sdk) activeQuery = null;
      if (!terminal) {
        flushAssistant();
        resolveUnresolvedCalls();
        // The SDK stream ended without a result message: an interrupt, or a
        // malformed stream. Both are terminal.
        yield {
          type: 'error',
          error: signal?.aborted ? cancelledError(signal)
            : normalizeProviderError(new Error('Claude SDK stream ended without a result message')),
          usage: sessionUsage,
          continuation: safeContinuation(),
        };
      }
    }
  }

  const identity = {
    provider: CLAUDE_PROVIDER,
    model,
    api: CLAUDE_API,
  };
  return {
    provider: CLAUDE_PROVIDER,
    model,
    identity,
    cancel,
    runTurn,
  };
}
