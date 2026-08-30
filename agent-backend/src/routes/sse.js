/**
 * Stream an async iterable of events to the response as Server-Sent Events.
 * Used by the agent task routes (story 011) and the seeding pipeline (015).
 */

// Comment-frame keepalive interval (STH-48). A run parked on an ask_user
// question can sit idle for many minutes, and an SSE response with no traffic
// is exactly what idle-timeout middleboxes (and server request timeouts) kill
// — which the browser then surfaced as a mid-question "network error". A
// periodic SSE comment line (": ...") is invisible to the event parser but
// keeps bytes flowing on the socket.
export const HEARTBEAT_MS = 15_000;

export async function streamEvents(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();

  // Stop the producer when the browser disconnects. This must watch the
  // *response*: in Node 13+, the request's 'close' fires once the request
  // body has been consumed, which for a POST is immediately — listening
  // there cancels the task as soon as it starts.
  res.on('close', () => void events.return?.());

  try {
    for await (const event of events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}
