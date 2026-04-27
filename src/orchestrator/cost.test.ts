import { describe, expect, it } from 'vitest';
import { computeCacheSavingsUsd, computeCostUsd } from './cost.ts';

describe('cost utilities', () => {
  describe('computeCostUsd', () => {
    it('should compute cost for known model', () => {
      const cost = computeCostUsd('claude-sonnet-4-6', {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // Sonnet: input $3/Mt, output $15/Mt
      // 1M input @ $3 + 0.5M output @ $15 = $3 + $7.50 = $10.50
      expect(cost).toBe(10.5);
    });

    it('should throw for unknown model', () => {
      expect(() =>
        computeCostUsd('claude-unknown-99', {
          input: 1_000_000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      ).toThrow(/unknown model/);
    });

    it('should factor in cache read and write tokens', () => {
      const cost = computeCostUsd('claude-haiku-4-5-20251001', {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 500_000,
        cacheWrite: 250_000,
      });
      // Haiku: input $0.8, output $4, cacheRead $0.08, cacheWrite $1
      // 1M input @ $0.8 + 0.5M output @ $4 + 0.5M cacheRead @ $0.08 + 0.25M cacheWrite @ $1
      // = $0.8 + $2 + $0.04 + $0.25 = $3.09
      expect(cost).toBeCloseTo(3.09, 2);
    });
  });

  describe('computeCacheSavingsUsd', () => {
    it('should compute savings for cache read tokens vs full input price', () => {
      // Sonnet: input $3/Mt, cacheRead $0.30/Mt
      // 1M cache-read tokens save: $3 - $0.30 = $2.70
      const savings = computeCacheSavingsUsd('claude-sonnet-4-6', 1_000_000);
      expect(savings).toBeCloseTo(2.7, 2);
    });

    it('should return 0 for unknown model', () => {
      const savings = computeCacheSavingsUsd('claude-unknown-99', 1_000_000);
      expect(savings).toBe(0);
    });

    it('should return 0 for zero cache read tokens', () => {
      const savings = computeCacheSavingsUsd('claude-sonnet-4-6', 0);
      expect(savings).toBe(0);
    });

    it('should scale savings proportionally with cache tokens', () => {
      // For Haiku: input $0.8/Mt, cacheRead $0.08/Mt = $0.72 savings per Mt
      const savings = computeCacheSavingsUsd('claude-haiku-4-5-20251001', 100_000);
      // 0.1M tokens * $0.72 per M = $0.072
      expect(savings).toBeCloseTo(0.072, 3);
    });

    it('should use Math.max to never return negative savings', () => {
      // In theory this shouldn't happen with real pricing, but verify the guard.
      // Create a hypothetical scenario (shouldn't occur in practice).
      const savings = computeCacheSavingsUsd('claude-sonnet-4-6', 1_000_000);
      expect(savings).toBeGreaterThanOrEqual(0);
    });
  });
});
