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

/**
 * Turns a client address into a rate-limit key. IPv6 addresses are grouped by
 * their /64 prefix, because one subscriber usually controls a whole /64 and
 * could otherwise rotate through addresses to dodge a per-address limit.
 */
export function clientKey(ip: string | undefined): string {
  const value = (ip ?? "").trim().toLowerCase().split("%")[0];
  if (!value) return "unknown";
  if (!value.includes(":") || value.includes(".")) return value.slice(0, 64);

  const [head, tail] = value.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups =
    tail === undefined
      ? headGroups
      : [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/**
 * A running total that resets each UTC day. Used as a spend ceiling for LLM
 * tokens across every shop served by this process, so that no combination of
 * shops and visitors can run up an unbounded bill.
 */
export class DailyBudget {
  private day = "";
  private used = 0;

  private roll(now: Date): void {
    const today = now.toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }

  spent(now: Date = new Date()): number {
    this.roll(now);
    return this.used;
  }

  add(amount: number, now: Date = new Date()): void {
    this.roll(now);
    this.used += Math.max(0, amount);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var shopiAssistRateLimiter: RateLimiter | undefined;
  // eslint-disable-next-line no-var
  var shopiAssistTokenBudget: DailyBudget | undefined;
}

/** Process-wide limiter. Kept on globalThis so dev-server reloads do not reset it. */
export const rateLimiter: RateLimiter =
  globalThis.shopiAssistRateLimiter ??
  (globalThis.shopiAssistRateLimiter = new RateLimiter());

/** Process-wide daily LLM token counter. */
export const tokenBudget: DailyBudget =
  globalThis.shopiAssistTokenBudget ??
  (globalThis.shopiAssistTokenBudget = new DailyBudget());
