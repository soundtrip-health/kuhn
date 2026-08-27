// Issue #68b: an in-process FIFO semaphore capping concurrent sandbox script
// runs (threat model T-22 — without a cap, N parallel agent tasks could fan
// out N docker containers). Script runs are the first adopter; moving
// render/ingest behind it is an explicit follow-up, not assumed here.

export class Semaphore {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Semaphore capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.inUse = 0;
    this.waiters = [];
  }

  /** Resolves when a slot is free. Always pair with release() (try/finally). */
  acquire() {
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  release() {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot straight to the next waiter (FIFO)
    else this.inUse = Math.max(0, this.inUse - 1);
  }

  /** Acquire, run, release — release survives a throwing fn. */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
