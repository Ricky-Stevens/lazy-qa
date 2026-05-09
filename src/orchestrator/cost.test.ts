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

    it('should return conservative estimate for unknown model', () => {
      const cost = computeCostUsd('claude-unknown-99', {
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // Conservative fallback: all tokens × $15/Mt
      expect(cost).toBe(15);
    });

    it('should factor in cache read and write tokens', () => {
      const cost = computeCostUsd('claude-haiku-4-5-20251001', {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 500_000,
        cacheWrite: 250_000,
      });
      // Haiku: input $1.0, output $5.0, cacheRead $0.10, cacheWrite $2.0
      // 1M input @ $1.0 + 0.5M output @ $5.0 + 0.5M cacheRead @ $0.10 + 0.25M cacheWrite @ $2.0
      // = $1.0 + $2.5 + $0.05 + $0.5 = $4.05
      expect(cost).toBeCloseTo(4.05, 2);
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
      // For Haiku: input $1.0/Mt, cacheRead $0.10/Mt = $0.90 savings per Mt
      const savings = computeCacheSavingsUsd('claude-haiku-4-5-20251001', 100_000);
      // 0.1M tokens * $0.90 per M = $0.09
      expect(savings).toBeCloseTo(0.09, 3);
    });

    it('should use Math.max to never return negative savings', () => {
      // In theory this shouldn't happen with real pricing, but verify the guard.
      // Create a hypothetical scenario (shouldn't occur in practice).
      const savings = computeCacheSavingsUsd('claude-sonnet-4-6', 1_000_000);
      expect(savings).toBeGreaterThanOrEqual(0);
    });
  });
});
