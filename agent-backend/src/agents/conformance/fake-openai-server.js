/**
 * Scripted OpenAI-compatible chat-completions server (issue #112).
 *
 * An in-process HTTP server that speaks the streaming chat-completions wire
 * protocol the production Pi adapter drives through pi-ai's real `openai`
 * client: SSE chunks with role/content/tool_call deltas, a finish_reason,
 * the `stream_options.include_usage` usage chunk, and `[DONE]`. Every
 * request is answered from a script registered under the request's `model`
 * id, so the conformance suite can run the real OpenAI-compatible runtime
 * end to end over real HTTP with deterministic model behavior — what a
 * vLLM / Ollama / LiteLLM deployment would see, minus the model.
 *
 * Script entries:
 *   { kind: 'message', deltas: string[], toolCalls: [{ id, name, args }], usage: { input, output } }
 *   { kind: 'pause' }                  hold the request until the client aborts
 *   { kind: 'error', code }            a provider failure (see ERROR_STATUS)
 */

import { createServer } from 'node:http';

/** HTTP rendering of the normalized error codes scenarios script. A null
 * status destroys the socket (a network failure). */
export const ERROR_STATUS = {
  overloaded: { status: 529, message: 'Overloaded' },
  rate_limit: { status: 429, message: 'Rate limit exceeded' },
  server: { status: 500, message: 'Internal Server Error' },
  timeout: { status: 408, message: 'Request timed out' },
  network: { status: null, message: 'read ECONNRESET' },
  context_overflow: { status: 400, message: 'prompt is too long; the context window was exceeded' },
  provider_error: { status: 400, message: 'provider error: the model did not respond' },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createFakeOpenAIServer() {
  const scripts = new Map();
  const requests = [];
  let counter = 0;

  const sse = (res, payload) => { res.write(`data: ${JSON.stringify(payload)}\n\n`); };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'malformed JSON body' } }));
      return;
    }
    const record = {
      model: body.model,
      authorization: req.headers.authorization ?? null,
      messages: body.messages ?? [],
      tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name),
      stream: body.stream === true,
    };
    requests.push(record);
    const script = scripts.get(body.model);
    if (!script) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unknown model ${body.model}` } }));
      return;
    }
    const entry = script.responses[script.cursor];
    script.cursor += 1;
    if (!entry) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `script for ${body.model} exhausted` } }));
      return;
    }
    if (entry.kind === 'error') {
      const rendering = ERROR_STATUS[entry.code] ?? ERROR_STATUS.provider_error;
      if (rendering.status == null) {
        req.socket.destroy();
        return;
      }
      res.writeHead(rendering.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: rendering.message, type: 'server_error', code: entry.code } }));
      return;
    }
    if (entry.kind === 'pause') {
      // Park until the client gives up (the app's cancellation): no bytes
      // are ever written, so the client's abort is the only way out.
      req.on('close', () => { if (!res.writableEnded) res.destroy(); });
      return;
    }
    // A streamed assistant message.
    counter += 1;
    const id = `chatcmpl-fake-${counter}`;
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    for (const delta of entry.deltas ?? []) {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
    }
    (entry.toolCalls ?? []).forEach((call, index) => {
      sse(res, {
        ...base,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] },
          finish_reason: null,
        }],
      });
    });
    const hasCalls = (entry.toolCalls?.length ?? 0) > 0;
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: hasCalls ? 'tool_calls' : 'stop' }] });
    if (body.stream_options?.include_usage) {
      const usage = entry.usage ?? { input: 0, output: 0 };
      sse(res, { ...base, choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
  });

  return {
    requests,
    /** Start listening on a loopback port; resolves to the base URL (…/v1). */
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return this.url;
    },
    get url() {
      const address = server.address();
      return address ? `http://127.0.0.1:${address.port}/v1` : null;
    },
    /** Register (or replace) the response script served under a model id. */
    register(modelId, responses) {
      scripts.set(modelId, { responses, cursor: 0 });
    },
    /** Forget every script and observed request (per scenario). */
    reset() {
      scripts.clear();
      requests.length = 0;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
