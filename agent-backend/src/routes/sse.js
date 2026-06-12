/**
 * Stream an async iterable of events to the response as Server-Sent Events.
 * Used by the agent task routes (story 011) and the seeding pipeline (015).
 */
export async function streamEvents(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

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
    res.end();
  }
}
