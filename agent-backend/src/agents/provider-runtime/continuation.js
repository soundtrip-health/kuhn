/**
 * Canonical Kuhn continuation state (PLA-222/223; full production portability
 * is PLA-230).
 *
 * This is the only conversation representation allowed inside
 * `done.continuation` and `runTurn({continuation})`. It is Kuhn-owned and
 * versioned: adapters convert their framework messages to and from this shape
 * at the runtime boundary, so no provider or framework message object ever
 * crosses the seam.
 *
 * Version 1 deliberately carries only the model-facing transcript subset that
 * phase one proves portable:
 *
 * - `{role: 'user', content: [{type: 'text', text}]}`
 * - `{role: 'assistant', content: [{type: 'text', text} | {type: 'tool_call', id, name, arguments}]}`
 * - `{role: 'tool_result', toolCallId, toolName, content: [{type: 'text', text}], isError}`
 *
 * Deliberately excluded from canonical state, and rejected by the validator:
 *
 * - provider/framework metadata (api, provider, model, response ids, stop
 *   reasons, usage, timestamps) — the executing adapter re-stamps these;
 * - reasoning/thinking blocks and signatures — they cannot yet be replayed
 *   safely across providers, so a resumed conversation re-derives reasoning
 *   rather than replaying it (PLA-230 owns a portable policy);
 * - image content — phase-one `runTurn` input is text-only;
 * - provider-native session/cache ids — optional adapter diagnostics only,
 *   never correctness-critical state.
 */

export const CONTINUATION_VERSION = 1;

const MESSAGE_FIELDS = {
  user: ['role', 'content'],
  assistant: ['role', 'content'],
  tool_result: ['role', 'toolCallId', 'toolName', 'content', 'isError'],
};

const BLOCK_FIELDS = {
  text: ['type', 'text'],
  tool_call: ['type', 'id', 'name', 'arguments'],
};

/** Wrap already-canonical messages in a versioned continuation envelope. */
export function createContinuation(messages) {
  const continuation = { version: CONTINUATION_VERSION, messages: structuredClone(messages) };
  const violations = validateContinuation(continuation);
  if (violations.length > 0) {
    throw new Error(`refusing to emit non-canonical continuation: ${violations.join('; ')}`);
  }
  return continuation;
}

/** Throw a clear error when a caller supplies non-canonical continuation. */
export function assertContinuation(continuation) {
  const violations = validateContinuation(continuation);
  if (violations.length > 0) {
    throw new Error(`invalid continuation: ${violations.join('; ')}`);
  }
  return continuation;
}

/**
 * Structural validation. Returns violations instead of throwing so contract
 * tests can assert on the specific defects, mirroring
 * validateRuntimeEventSequence().
 */
export function validateContinuation(continuation) {
  const violations = [];
  if (!isPlainObject(continuation)) return ['continuation must be an object'];
  if (continuation.version !== CONTINUATION_VERSION) {
    return [`unsupported continuation version ${JSON.stringify(continuation.version)}; expected ${CONTINUATION_VERSION}`];
  }
  checkKeys(continuation, ['version', 'messages'], 'continuation', violations);
  if (!Array.isArray(continuation.messages)) {
    violations.push('continuation.messages must be an array');
    return [...new Set(violations)];
  }

  continuation.messages.forEach((message, index) => {
    const label = `messages[${index}]`;
    if (!isPlainObject(message)) {
      violations.push(`${label} must be an object`);
      return;
    }
    const allowed = MESSAGE_FIELDS[message.role];
    if (!allowed) {
      violations.push(`${label} has unknown role ${JSON.stringify(message.role)}`);
      return;
    }
    checkKeys(message, allowed, label, violations);
    if (message.role === 'tool_result') {
      if (typeof message.toolCallId !== 'string' || !message.toolCallId) violations.push(`${label} must reference toolCallId`);
      if (typeof message.toolName !== 'string' || !message.toolName) violations.push(`${label} must name its tool`);
      if (typeof message.isError !== 'boolean') violations.push(`${label} must include boolean isError`);
      validateBlocks(message.content, ['text'], label, violations);
      return;
    }
    const blockTypes = message.role === 'assistant' ? ['text', 'tool_call'] : ['text'];
    validateBlocks(message.content, blockTypes, label, violations);
  });

  const calls = new Map();
  for (const message of continuation.messages) {
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'tool_call' && block.id) calls.set(block.id, false);
      }
    }
    if (message?.role === 'tool_result') {
      if (!calls.has(message.toolCallId)) {
        violations.push(`tool_result ${message.toolCallId} has no preceding assistant tool_call`);
      } else if (calls.get(message.toolCallId)) {
        violations.push(`tool_result ${message.toolCallId} is duplicated`);
      } else {
        calls.set(message.toolCallId, true);
      }
    }
  }

  return [...new Set(violations)];
}

function validateBlocks(content, allowedTypes, label, violations) {
  if (!Array.isArray(content)) {
    violations.push(`${label}.content must be an array of blocks`);
    return;
  }
  content.forEach((block, index) => {
    const blockLabel = `${label}.content[${index}]`;
    if (!isPlainObject(block)) {
      violations.push(`${blockLabel} must be an object`);
      return;
    }
    if (!allowedTypes.includes(block.type)) {
      violations.push(`${blockLabel} has unsupported type ${JSON.stringify(block.type)}`);
      return;
    }
    checkKeys(block, BLOCK_FIELDS[block.type], blockLabel, violations);
    if (block.type === 'text' && typeof block.text !== 'string') {
      violations.push(`${blockLabel} must carry string text`);
    }
    if (block.type === 'tool_call') {
      if (typeof block.id !== 'string' || !block.id) violations.push(`${blockLabel} must include a call id`);
      if (typeof block.name !== 'string' || !block.name) violations.push(`${blockLabel} must include a tool name`);
      if (!isPlainObject(block.arguments)) violations.push(`${blockLabel} arguments must be an object`);
    }
  });
}

function checkKeys(object, allowed, label, violations) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      violations.push(`${label} has non-canonical field ${JSON.stringify(key)}`);
    }
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
