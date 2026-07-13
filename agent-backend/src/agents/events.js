/**
 * Async event channel — lets the SDK message pump and concurrently-running
 * tool handlers (e.g. dispatch_agent forwarding child progress) both push
 * AgentEvents into the single stream consumed by runAgentTask's generator.
 */
export class EventChannel {
  /**
   * @param {object} [opts]
   * @param {(event: object) => void} [opts.onEvent] - Tee called for every
   *   accepted push, before delivery — fires even while no consumer is
   *   attached (detached runs), which is what lets the project event feed see
   *   background work (story 005-001). Must not throw into the pump.
   */
  constructor({ onEvent } = {}) {
    this.buffer = [];
    this.waiters = [];
    this.ended = false;
    this.onEvent = onEvent;
  }

  push(event) {
    if (this.ended) return;
    try {
      this.onEvent?.(event);
    } catch (err) {
      console.error('[events] onEvent tee threw:', err);
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.buffer.push(event);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  /**
   * Drop any waiter left by a consumer that stopped mid-await (e.g. the browser
   * disconnected while the run was parked on a question). Without this the next
   * push() would resolve that dead waiter and the event would be lost instead
   * of buffered for the reconnecting consumer (story 027).
   */
  detach() {
    this.waiters.length = 0;
  }

  next() {
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift(), done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}
