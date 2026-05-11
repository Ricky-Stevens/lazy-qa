import { afterEach, describe, expect, it } from 'vitest';
import {
  getGlobalRateLimiter,
  initGlobalRateLimiter,
  RateLimiter,
  stopGlobalRateLimiter,
} from './rate-limiter.ts';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.stop();
  });

  it('allows immediate acquisition when tokens are available', async () => {
    limiter = new RateLimiter({ maxRps: 100 });
    limiter.start();
    const start = Date.now();
    await limiter.acquire('localhost:3000');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('tryAcquire returns true when tokens available', () => {
    limiter = new RateLimiter({ maxRps: 10, burstSize: 5 });
    limiter.start();
    expect(limiter.tryAcquire('localhost:3000')).toBe(true);
  });

  it('tryAcquire returns false when burst exhausted', () => {
    limiter = new RateLimiter({ maxRps: 10, burstSize: 2 });
    limiter.start();
    expect(limiter.tryAcquire('localhost:3000')).toBe(true);
    expect(limiter.tryAcquire('localhost:3000')).toBe(true);
    expect(limiter.tryAcquire('localhost:3000')).toBe(false);
  });

  it('tracks separate buckets per host', () => {
    limiter = new RateLimiter({ maxRps: 10, burstSize: 1 });
    limiter.start();
    expect(limiter.tryAcquire('host-a')).toBe(true);
    expect(limiter.tryAcquire('host-a')).toBe(false);
    expect(limiter.tryAcquire('host-b')).toBe(true);
  });

  it('stop resolves all pending waiters', async () => {
    limiter = new RateLimiter({ maxRps: 1, burstSize: 1 });
    limiter.start();
    limiter.tryAcquire('host');
    const promise = limiter.acquire('host');
    limiter.stop();
    await promise;
  });

  it('refills tokens over time', async () => {
    limiter = new RateLimiter({ maxRps: 100, burstSize: 1 });
    limiter.start();
    expect(limiter.tryAcquire('host')).toBe(true);
    expect(limiter.tryAcquire('host')).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(limiter.tryAcquire('host')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Edge case tests
  // -------------------------------------------------------------------------

  it('defaults burstSize to max(maxRps * 2, 5)', () => {
    // maxRps=1 => burstSize = max(2, 5) = 5
    limiter = new RateLimiter({ maxRps: 1 });
    limiter.start();
    let acquired = 0;
    while (limiter.tryAcquire('host')) acquired++;
    expect(acquired).toBe(5);
  });

  it('defaults burstSize to maxRps * 2 for high maxRps', () => {
    // maxRps=10 => burstSize = max(20, 5) = 20
    limiter = new RateLimiter({ maxRps: 10 });
    limiter.start();
    let acquired = 0;
    while (limiter.tryAcquire('host')) acquired++;
    expect(acquired).toBe(20);
  });

  it('start is idempotent (does not reset buckets)', () => {
    limiter = new RateLimiter({ maxRps: 10, burstSize: 3 });
    limiter.start();
    limiter.tryAcquire('host'); // consume one token
    limiter.start(); // second start should be a no-op
    // Should still have only 2 tokens remaining, not 3
    expect(limiter.tryAcquire('host')).toBe(true);
    expect(limiter.tryAcquire('host')).toBe(true);
    expect(limiter.tryAcquire('host')).toBe(false);
  });

  it('stop resolves multiple pending waiters', async () => {
    limiter = new RateLimiter({ maxRps: 1, burstSize: 1 });
    limiter.start();
    limiter.tryAcquire('host'); // exhaust the single token

    const p1 = limiter.acquire('host');
    const p2 = limiter.acquire('host');
    const p3 = limiter.acquire('host');

    limiter.stop();

    // All three should resolve without hanging
    await Promise.all([p1, p2, p3]);
  });

  it('acquire works without calling start (lazy bucket creation)', () => {
    // acquire should not throw even if start() was never called;
    // it will just queue and never resolve unless tokens appear or stop() is called.
    limiter = new RateLimiter({ maxRps: 10, burstSize: 2 });
    // No start() — tokens exist in bucket at creation time
    expect(limiter.tryAcquire('host')).toBe(true);
    expect(limiter.tryAcquire('host')).toBe(true);
    expect(limiter.tryAcquire('host')).toBe(false);
  });

  it('does not refill above burstSize', async () => {
    limiter = new RateLimiter({ maxRps: 100, burstSize: 3 });
    limiter.start();
    // Wait for multiple refill intervals
    await new Promise((r) => setTimeout(r, 200));
    // Should never have more than 3 tokens
    let acquired = 0;
    while (limiter.tryAcquire('host')) acquired++;
    expect(acquired).toBe(3);
  });

  it('handles high maxRps values', () => {
    limiter = new RateLimiter({ maxRps: 10_000, burstSize: 100 });
    limiter.start();
    let acquired = 0;
    while (limiter.tryAcquire('host')) acquired++;
    expect(acquired).toBe(100);
  });

  it('waiters are served in FIFO order', async () => {
    limiter = new RateLimiter({ maxRps: 1000, burstSize: 1 });
    limiter.start();
    limiter.tryAcquire('host'); // exhaust

    const order: number[] = [];
    const p1 = limiter.acquire('host').then(() => order.push(1));
    const p2 = limiter.acquire('host').then(() => order.push(2));

    // Wait for refill to serve the waiters
    await new Promise((r) => setTimeout(r, 150));
    limiter.stop();
    await Promise.all([p1, p2]);

    expect(order[0]).toBe(1);
    expect(order[1]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Global rate limiter singleton
// ---------------------------------------------------------------------------

describe('Global RateLimiter', () => {
  afterEach(() => {
    stopGlobalRateLimiter();
  });

  it('initGlobalRateLimiter creates and starts a limiter', () => {
    const limiter = initGlobalRateLimiter({ maxRps: 10, burstSize: 3 });
    expect(limiter).toBeInstanceOf(RateLimiter);
    expect(getGlobalRateLimiter()).toBe(limiter);
    expect(limiter.tryAcquire('host')).toBe(true);
  });

  it('getGlobalRateLimiter returns null before init', () => {
    expect(getGlobalRateLimiter()).toBeNull();
  });

  it('initGlobalRateLimiter stops previous instance', () => {
    const first = initGlobalRateLimiter({ maxRps: 10, burstSize: 2 });
    const second = initGlobalRateLimiter({ maxRps: 10, burstSize: 5 });

    expect(getGlobalRateLimiter()).toBe(second);
    expect(getGlobalRateLimiter()).not.toBe(first);

    // Second limiter should have burstSize 5
    let acquired = 0;
    while (second.tryAcquire('host')) acquired++;
    expect(acquired).toBe(5);
  });

  it('stopGlobalRateLimiter clears the singleton', () => {
    initGlobalRateLimiter({ maxRps: 10 });
    expect(getGlobalRateLimiter()).not.toBeNull();
    stopGlobalRateLimiter();
    expect(getGlobalRateLimiter()).toBeNull();
  });

  it('stopGlobalRateLimiter is safe to call when no limiter exists', () => {
    expect(() => stopGlobalRateLimiter()).not.toThrow();
    expect(() => stopGlobalRateLimiter()).not.toThrow();
  });
});
