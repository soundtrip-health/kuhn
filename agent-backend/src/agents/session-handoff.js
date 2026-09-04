// Fresh-session hand-off (issue #109). When a follow-up asks the provider to
// resume a session it no longer holds — the common case is a session the
// budget cutoff interrupted — the runtime starts a fresh session instead of
// failing, and this module renders Kuhn's own record of the dead session
// (db/conversation.js getSessionTranscript) into the prompt that fresh
// session receives. Pure text assembly: no model call, no IO. The caps come
// from config.agent.sessionHandoff — the record is by definition the tail of
// a run large enough to exhaust its budget, so it is clipped per message and
// in total, keeping the most recent turns.

const OMITTED_MARKER = '[earlier turns omitted]';

const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n[…truncated]` : s;
};

/**
 * Render one transcript row as a hand-off block, or null for rows that
 * carry nothing (system rows, empty assistant turns).
 * @param {object} row - { role, content, tool_calls, tool_call_id, is_error }
 * @param {Map<string,string>} callNames - tool_call id → tool name, filled
 *   from assistant rows so tool rows can be labelled
 */
function renderRow(row, callNames, maxCharsPerMessage) {
  switch (row.role) {
    case 'user':
      return row.content ? `[USER]\n${clip(row.content, maxCharsPerMessage)}` : null;
    case 'assistant': {
      const parts = [];
      if (row.content) parts.push(`[AGENT]\n${clip(row.content, maxCharsPerMessage)}`);
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        if (call?.id && call?.name) callNames.set(call.id, call.name);
        const args = call?.input == null ? '' : ` ${clip(JSON.stringify(call.input), maxCharsPerMessage)}`;
        parts.push(`[AGENT → tool ${call?.name ?? 'unknown'}]${args}`);
      }
      return parts.length > 0 ? parts.join('\n') : null;
    }
    case 'tool': {
      const name = callNames.get(row.tool_call_id) ?? 'tool';
      const status = row.is_error ? ' (error)' : '';
      return `[${name} result${status}]\n${clip(row.content ?? '', maxCharsPerMessage)}`;
    }
    default:
      return null;
  }
}

/**
 * Build the prompt a fresh session receives in place of a dead one.
 *
 * @param {object} args
 * @param {{ messages: object[], job: object|null }|null} args.transcript -
 *   getSessionTranscript's result; null/empty when Kuhn has no record either
 * @param {string} args.input - the prompt the follow-up would have sent
 *   (already context-augmented by the runtime's buildPrompt)
 * @param {number} args.maxChars - total hand-off transcript cap
 * @param {number} args.maxCharsPerMessage - per-row cap
 * @returns {string}
 */
export function renderSessionHandoff({ transcript, input, maxChars, maxCharsPerMessage }) {
  const messages = transcript?.messages ?? [];
  const why = transcript?.job?.error
    ? ` It stopped with: ${transcript.job.error}.`
    : '';

  // Render every row first (tool names resolve forwards), then keep the
  // longest suffix that fits the total cap.
  const callNames = new Map();
  const rendered = [];
  for (const row of messages) {
    const block = renderRow(row, callNames, maxCharsPerMessage);
    if (block) rendered.push(block);
  }
  const kept = [];
  let size = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const block = rendered[i];
    if (size + block.length > maxChars && kept.length > 0) break;
    kept.unshift(block);
    size += block.length;
  }
  const omitted = kept.length < rendered.length;

  const lines = [
    '<session_handoff>',
    'Your previous session on this task was interrupted before the work was finished'
    + ` and the model provider no longer holds it, so this is a fresh session.${why}`,
  ];
  if (kept.length > 0) {
    lines.push(
      "Below is Kuhn's record of that session, oldest first. Nothing in it is in your "
      + 'context otherwise: re-read any file you need before editing it, and do not '
      + 'repeat work the record shows as done.',
      '',
      ...(omitted ? [OMITTED_MARKER, ''] : []),
      kept.join('\n\n'),
    );
  } else {
    lines.push(
      'Kuhn has no record of that session either. Re-read the project files you need '
      + 'before acting, and ask the user if the state of the work is unclear.',
    );
  }
  lines.push('</session_handoff>', '', "The user's next message follows.", '', input);
  return lines.join('\n');
}
