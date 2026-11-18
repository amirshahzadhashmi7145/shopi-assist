/**
 * Small in-memory fixed-window rate limiter.
 *
 * The storefront chat endpoint is public and every message costs LLM tokens,
 * so it needs a ceiling. State lives in this process only: with several app
 * instances each one enforces its own budget. Swap this for a shared store
 * (Redis, the database) before scaling horizontally.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the current window resets (0 when allowed). */
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  /**
   * Counts one hit against `key` and reports whether it is within `max` hits
   * per `windowMs`.
   */
  hit(
    key: string,
    max: number,
    windowMs: number,
    now: number = Date.now(),
  ): RateLimitResult {
    this.sweep(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: max >= 1, retryAfterMs: max >= 1 ? 0 : windowMs };
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Drops expired buckets at most once a minute so the map cannot grow forever. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var shopiAssistRateLimiter: RateLimiter | undefined;
}

/** Process-wide limiter. Kept on globalThis so dev-server reloads do not reset it. */
export const rateLimiter: RateLimiter =
  globalThis.shopiAssistRateLimiter ??
  (globalThis.shopiAssistRateLimiter = new RateLimiter());
