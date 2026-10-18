/**
 * This file has two small tools for not overloading the Warcraft Logs API:
 *
 * - TTLCache: a cache -- temporary storage that remembers an API response
 *   for a while, so we don't have to ask for the same data twice.
 * - SlidingWindowCounter: a rate limiter -- a safety cap on how many
 *   requests we're allowed to send in a given time window.
 *
 * Both just use a plain in-memory list/map, so they reset whenever the app
 * restarts and aren't shared between multiple server copies. That's fine
 * for a small project like this one; a bigger app would use a shared
 * database (like Redis) instead.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();

  constructor(private defaultTtlMs: number) {}

  // Returns the cached value, or `undefined` if we don't have it (or it's
  // expired). We check the expiry time right here when reading, instead of
  // running a background timer to clean things up -- simpler, and fine for
  // an app this small.
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  // Convenience helper: return the cached value if we have one, otherwise
  // run `fn` to get a fresh value, cache it, and return that. Not
  // currently used by lib/wcl/client.ts -- it needs to decide the TTL
  // AFTER the request finishes, so it calls get/set separately instead.
  async getOrSet(key: string, ttlMs: number | undefined, fn: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * A simple rate limiter: it remembers the timestamps of recent requests
 * and makes new ones wait their turn once too many have happened within
 * the time window. This is a safety cap for this app's own code (in case
 * of a bug that sends requests in a loop) -- it's separate from Warcraft
 * Logs's own hourly quota, which is checked with `rateLimitData` instead
 * (see lib/wcl/client.ts).
 */
export class SlidingWindowCounter {
  private timestamps: number[] = [];

  constructor(private windowMs: number, private max: number) {}

  // Call this once per request you're about to send. Returns false (and
  // records nothing) if we've already hit the limit for this window.
  // Prefer `acquire()` below for anything that can just wait its turn --
  // this lower-level method is here mainly so `acquire()` (and tests) can
  // check/reserve a slot without also pulling in the wait loop.
  tryConsume(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    // Drop timestamps older than the window before counting -- this is
    // what makes it "sliding" instead of resetting all at once on a timer.
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    if (this.timestamps.length >= this.max) return false;
    this.timestamps.push(now);
    return true;
  }

  // Like `tryConsume`, but instead of refusing once the window is full, it
  // waits until a slot actually opens up (right when the oldest timestamp
  // in the window ages out) and then takes it. This is what
  // lib/wcl/client.ts uses: a burst of requests (e.g. fetching a few dozen
  // guild reports at once) should queue up and go out steadily within this
  // app's own safety cap, not have the back half of the burst just fail --
  // a report that silently never got fetched is a worse outcome than this
  // one page taking longer to load. There's no cap on how long this can
  // wait; the caller's own request volume is already bounded elsewhere
  // (see MAX_NIGHTS_FOR_TREND / REPORTS_SCAN_CAP in lib/wcl/service.ts), so
  // this just paces those bounded requests out instead of adding its own
  // separate limit.
  async acquire(): Promise<void> {
    for (;;) {
      if (this.tryConsume()) return;
      // Same cutoff math as tryConsume -- wait exactly until the oldest
      // timestamp currently in the window falls out of it (a fixed few ms
      // of slack for clock/setTimeout imprecision, rather than polling in
      // a tight loop or guessing a delay).
      const oldest = this.timestamps[0];
      const waitMs = oldest !== undefined ? oldest + this.windowMs - Date.now() + 5 : 50;
      await sleep(Math.max(waitMs, 10));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
