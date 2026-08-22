// In-process fixed-window rate limiting (STH-35 follow-up).
//
// Deliberately not a dependency and not DB-backed: the backend is a single
// Node process with in-process SQLite, so a Map is the whole mechanism. If
// Kuhn ever runs more than one process this becomes per-process (each gets
// its own budget) and would need moving into SQLite — that is the one thing
// to remember about it.
//
// Fixed windows, not sliding: a caller can burst up to 2×limit across a
// window boundary. That is fine for the thing this protects against (mailing
// the same person over and over) and keeps the state to two numbers per key.

/**
 * @param {{limit: number, windowMs: number}} opts
 * @returns {{consume: (key: string) => {ok: boolean, retryAfterMs: number, tripped: boolean},
 *            reset: () => void, size: () => number}}
 */
export function createRateLimiter({ limit, windowMs }) {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const windows = new Map();
  let lastPrune = 0;

  // Expired keys are swept opportunistically — same discipline as the token
  // tables in db/auth.js, no background timer. Memory is bounded by the
  // number of DISTINCT keys seen within one window, so the sweep is also
  // triggered by size to keep a burst of unique keys from accumulating.
  const prune = (now) => {
    if (now - lastPrune < windowMs && windows.size < 1000) return;
    lastPrune = now;
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
  };

  return {
    /**
     * Count one attempt against `key`.
     * @returns {{ok: boolean, retryAfterMs: number, tripped: boolean}} `tripped`
     *   is true only on the FIRST rejection of a window, so a caller can log
     *   or audit once per offender per window instead of once per attempt.
     */
    consume(key) {
      const now = Date.now();
      prune(now);
      let window = windows.get(key);
      if (!window || window.resetAt <= now) {
        window = { count: 0, resetAt: now + windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      if (window.count <= limit) return { ok: true, retryAfterMs: 0, tripped: false };
      return {
        ok: false,
        retryAfterMs: window.resetAt - now,
        tripped: window.count === limit + 1,
      };
    },
    /** Drop all state (tests, and a manual unblock in a REPL). */
    reset() {
      windows.clear();
      lastPrune = 0;
    },
    size: () => windows.size,
  };
}
