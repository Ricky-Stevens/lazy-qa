/**
 * Token-bucket rate limiter — prevents agents from overwhelming the target
 * application with requests. One bucket per host, shared across all agents
 * in a run. Configurable via `target.max_rps` in the YAML config.
 *
 * Usage: call `await limiter.acquire(host)` before each browser action
 * (navigate, click, fill_form, request_with_session). The call resolves
 * immediately if tokens are available, or waits until one becomes available.
 */

export interface RateLimiterConfig {
  maxRps: number;
  burstSize?: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
  waiters: Array<() => void>;
}

export class RateLimiter {
  private readonly maxRps: number;
  private readonly burstSize: number;
  private readonly buckets = new Map<string, Bucket>();
  private refillTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimiterConfig) {
    this.maxRps = config.maxRps;
    this.burstSize = config.burstSize ?? Math.max(config.maxRps * 2, 5);
  }

  start(): void {
    if (this.refillTimer) return;
    const intervalMs = Math.max(50, Math.floor(1000 / this.maxRps));
    this.refillTimer = setInterval(() => this.refillAll(), intervalMs);
    if (typeof this.refillTimer === 'object' && 'unref' in this.refillTimer) {
      (this.refillTimer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    for (const bucket of this.buckets.values()) {
      for (const resolve of bucket.waiters) resolve();
      bucket.waiters.length = 0;
    }
  }

  async acquire(host: string): Promise<void> {
    const bucket = this.getOrCreate(host);
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      bucket.waiters.push(resolve);
    });
  }

  tryAcquire(host: string): boolean {
    const bucket = this.getOrCreate(host);
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  private getOrCreate(host: string): Bucket {
    let bucket = this.buckets.get(host);
    if (!bucket) {
      bucket = { tokens: this.burstSize, lastRefill: Date.now(), waiters: [] };
      this.buckets.set(host, bucket);
    }
    return bucket;
  }

  private refillAll(): void {
    const now = Date.now();
    for (const bucket of this.buckets.values()) {
      const elapsed = now - bucket.lastRefill;
      const tokensToAdd = Math.floor((elapsed / 1000) * this.maxRps);
      if (tokensToAdd > 0) {
        bucket.tokens = Math.min(bucket.tokens + tokensToAdd, this.burstSize);
        bucket.lastRefill = now;
        while (bucket.tokens > 0 && bucket.waiters.length > 0) {
          bucket.tokens -= 1;
          const waiter = bucket.waiters.shift()!;
          waiter();
        }
      }
    }
  }
}

let globalLimiter: RateLimiter | null = null;

export function initGlobalRateLimiter(config: RateLimiterConfig): RateLimiter {
  if (globalLimiter) globalLimiter.stop();
  globalLimiter = new RateLimiter(config);
  globalLimiter.start();
  return globalLimiter;
}

export function getGlobalRateLimiter(): RateLimiter | null {
  return globalLimiter;
}

export function stopGlobalRateLimiter(): void {
  if (globalLimiter) {
    globalLimiter.stop();
    globalLimiter = null;
  }
}
