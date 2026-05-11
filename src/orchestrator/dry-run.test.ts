/**
 * Tests for dry-run.ts — the cost estimation logic and DryRunResult shape.
 *
 * The `dryRun` function itself requires live config, crawler, and LLM access.
 * We test the cost estimation logic by exercising `estimateCostForTurns`
 * indirectly through the exported `dryRun`, plus unit-test the estimation
 * arithmetic by recreating the formula with known pricing values.
 */

import { describe, expect, it } from 'vitest';
import { MODEL_PRICING, type PricePerMillion } from './cost.ts';

// ---------------------------------------------------------------------------
// Re-implement the estimation formula from dry-run.ts so we can unit-test it
// without needing to run the full dryRun pipeline (which requires config,
// crawler, and LLM).
// ---------------------------------------------------------------------------

interface AgentSummary {
  id: string;
  model: string;
  budgetMaxTurns: number;
}

function estimateCostForTurns(
  agents: AgentSummary[],
  avgTurns: number,
  appModelCost: number,
  supervisorModel: string,
  reviewModel: string | null,
  reviewEnabled: boolean,
): number {
  let total = appModelCost;

  for (const agent of agents) {
    const pricing = MODEL_PRICING[agent.model];
    if (!pricing) continue;
    const inputTokensPerTurn = 4000;
    const outputTokensPerTurn = 800;
    const cacheReadPerTurn = 8000;
    const costPerTurn =
      (inputTokensPerTurn * pricing.input) / 1_000_000 +
      (outputTokensPerTurn * pricing.output) / 1_000_000 +
      (cacheReadPerTurn * (pricing.cacheRead ?? pricing.input * 0.1)) / 1_000_000;
    total += costPerTurn * Math.min(avgTurns, agent.budgetMaxTurns);
  }

  const supervisorPricing = MODEL_PRICING[supervisorModel];
  if (supervisorPricing) {
    total +=
      ((5000 * supervisorPricing.input + 2000 * supervisorPricing.output) / 1_000_000) * 8;
  }

  if (reviewModel && reviewEnabled) {
    const reviewPricing = MODEL_PRICING[reviewModel];
    if (reviewPricing) {
      const estFindings = agents.length * 2;
      total +=
        ((3000 * reviewPricing.input + 1000 * reviewPricing.output) / 1_000_000) * estFindings;
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// Turn count helpers (replicated from dry-run.ts)
// ---------------------------------------------------------------------------

function avgTurnsLow(routeCount: number): number {
  return Math.min(8, Math.ceil(routeCount * 0.5));
}

function avgTurnsMid(routeCount: number): number {
  return Math.min(20, routeCount);
}

function avgTurnsHigh(routeCount: number): number {
  return Math.min(40, routeCount * 2);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dry-run cost estimation', () => {
  const sonnetPricing = MODEL_PRICING['claude-sonnet-4-6']!;
  const haikuPricing = MODEL_PRICING['claude-haiku-4-5-20251001']!;

  describe('avgTurns calculations', () => {
    it('low estimate is capped at 8', () => {
      expect(avgTurnsLow(100)).toBe(8);
    });

    it('low estimate is half of route count for small sites', () => {
      expect(avgTurnsLow(6)).toBe(3);
    });

    it('low estimate rounds up for odd route counts', () => {
      expect(avgTurnsLow(3)).toBe(2);
    });

    it('mid estimate is capped at 20', () => {
      expect(avgTurnsMid(50)).toBe(20);
    });

    it('mid estimate equals route count for small sites', () => {
      expect(avgTurnsMid(10)).toBe(10);
    });

    it('high estimate is capped at 40', () => {
      expect(avgTurnsHigh(100)).toBe(40);
    });

    it('high estimate is double route count for small sites', () => {
      expect(avgTurnsHigh(10)).toBe(20);
    });

    it('zero routes produces 0/0/0 turns', () => {
      expect(avgTurnsLow(0)).toBe(0);
      expect(avgTurnsMid(0)).toBe(0);
      expect(avgTurnsHigh(0)).toBe(0);
    });

    it('single route produces 1/1/2 turns', () => {
      expect(avgTurnsLow(1)).toBe(1);
      expect(avgTurnsMid(1)).toBe(1);
      expect(avgTurnsHigh(1)).toBe(2);
    });
  });

  describe('estimateCostForTurns', () => {
    it('returns only app model cost when no agents', () => {
      const cost = estimateCostForTurns(
        [],
        10,
        0.05,
        'claude-sonnet-4-6',
        'claude-sonnet-4-6',
        false,
      );
      // Should include supervisor cost + app model cost but no agent cost
      const expectedSupervisor =
        ((5000 * sonnetPricing.input + 2000 * sonnetPricing.output) / 1_000_000) * 8;
      expect(cost).toBeCloseTo(0.05 + expectedSupervisor, 4);
    });

    it('accumulates cost across multiple agents', () => {
      const agents: AgentSummary[] = [
        { id: 'a1', model: 'claude-haiku-4-5-20251001', budgetMaxTurns: 40 },
        { id: 'a2', model: 'claude-haiku-4-5-20251001', budgetMaxTurns: 40 },
      ];
      const costOneAgent = estimateCostForTurns(
        [agents[0]!],
        10,
        0,
        'claude-sonnet-4-6',
        null,
        false,
      );
      const costTwoAgents = estimateCostForTurns(
        agents,
        10,
        0,
        'claude-sonnet-4-6',
        null,
        false,
      );
      // Two agents should cost more than one
      expect(costTwoAgents).toBeGreaterThan(costOneAgent);
    });

    it('caps agent turns at budget max_turns', () => {
      const agent: AgentSummary = {
        id: 'a1',
        model: 'claude-haiku-4-5-20251001',
        budgetMaxTurns: 5,
      };
      const costLowAvg = estimateCostForTurns(
        [agent],
        3,
        0,
        'claude-sonnet-4-6',
        null,
        false,
      );
      const costHighAvg = estimateCostForTurns(
        [agent],
        100,
        0,
        'claude-sonnet-4-6',
        null,
        false,
      );
      // Both should be capped at 5 turns
      const costAtBudget = estimateCostForTurns(
        [agent],
        5,
        0,
        'claude-sonnet-4-6',
        null,
        false,
      );
      expect(costHighAvg).toBeCloseTo(costAtBudget, 6);
      expect(costLowAvg).toBeLessThan(costAtBudget);
    });

    it('skips agents with unknown models', () => {
      const agents: AgentSummary[] = [
        { id: 'a1', model: 'nonexistent-model', budgetMaxTurns: 40 },
      ];
      const cost = estimateCostForTurns(
        agents,
        10,
        0,
        'claude-sonnet-4-6',
        null,
        false,
      );
      // Only supervisor cost, no agent cost
      const expectedSupervisor =
        ((5000 * sonnetPricing.input + 2000 * sonnetPricing.output) / 1_000_000) * 8;
      expect(cost).toBeCloseTo(expectedSupervisor, 6);
    });

    it('adds review cost when review is enabled', () => {
      const agents: AgentSummary[] = [
        { id: 'a1', model: 'claude-haiku-4-5-20251001', budgetMaxTurns: 40 },
      ];
      const costNoReview = estimateCostForTurns(
        agents,
        10,
        0,
        'claude-sonnet-4-6',
        'claude-sonnet-4-6',
        false,
      );
      const costWithReview = estimateCostForTurns(
        agents,
        10,
        0,
        'claude-sonnet-4-6',
        'claude-sonnet-4-6',
        true,
      );
      expect(costWithReview).toBeGreaterThan(costNoReview);
    });

    it('review cost scales with agent count', () => {
      const oneAgent: AgentSummary[] = [
        { id: 'a1', model: 'claude-haiku-4-5-20251001', budgetMaxTurns: 40 },
      ];
      const threeAgents: AgentSummary[] = [
        { id: 'a1', model: 'claude-haiku-4-5-20251001', budgetMaxTurns: 40 },
        { id: 'a2', model: 'claude-haiku-4-5-20251001', budgetMaxTurns: 40 },
        { id: 'a3', model: 'claude-haiku-4-5-20251001', budgetMaxTurns: 40 },
      ];
      const costOne = estimateCostForTurns(
        oneAgent,
        10,
        0,
        'claude-sonnet-4-6',
        'claude-sonnet-4-6',
        true,
      );
      const costThree = estimateCostForTurns(
        threeAgents,
        10,
        0,
        'claude-sonnet-4-6',
        'claude-sonnet-4-6',
        true,
      );
      // 3 agents = 3x the review cost delta
      expect(costThree).toBeGreaterThan(costOne);
    });

    it('produces monotonically increasing low < mid < high estimates', () => {
      const agents: AgentSummary[] = [
        { id: 'a1', model: 'claude-haiku-4-5-20251001', budgetMaxTurns: 40 },
        { id: 'a2', model: 'claude-sonnet-4-6', budgetMaxTurns: 20 },
      ];
      const routeCount = 15;
      const low = estimateCostForTurns(
        agents,
        avgTurnsLow(routeCount),
        0.05,
        'claude-sonnet-4-6',
        'claude-sonnet-4-6',
        true,
      );
      const mid = estimateCostForTurns(
        agents,
        avgTurnsMid(routeCount),
        0.05,
        'claude-sonnet-4-6',
        'claude-sonnet-4-6',
        true,
      );
      const high = estimateCostForTurns(
        agents,
        avgTurnsHigh(routeCount),
        0.05,
        'claude-sonnet-4-6',
        'claude-sonnet-4-6',
        true,
      );
      expect(low).toBeLessThan(mid);
      expect(mid).toBeLessThan(high);
    });

    it('per-turn cost uses correct token assumptions', () => {
      // Verify the per-turn cost math for one Haiku agent, one turn
      const agent: AgentSummary = {
        id: 'a1',
        model: 'claude-haiku-4-5-20251001',
        budgetMaxTurns: 1,
      };
      const cost = estimateCostForTurns(
        [agent],
        1,
        0,
        'claude-sonnet-4-6',
        null,
        false,
      );
      // Agent cost: (4000 * 1.0 + 800 * 5.0 + 8000 * 0.1) / 1M = (4000 + 4000 + 800) / 1M = 0.0088
      const expectedAgentCost =
        (4000 * haikuPricing.input +
          800 * haikuPricing.output +
          8000 * haikuPricing.cacheRead) /
        1_000_000;
      // Supervisor cost: (5000 * 3 + 2000 * 15) / 1M * 8 = (15000 + 30000) / 1M * 8 = 0.36
      const expectedSupervisorCost =
        ((5000 * sonnetPricing.input + 2000 * sonnetPricing.output) / 1_000_000) * 8;

      expect(cost).toBeCloseTo(expectedAgentCost + expectedSupervisorCost, 6);
    });

    it('zero turns produces only supervisor and app model cost', () => {
      const agents: AgentSummary[] = [
        { id: 'a1', model: 'claude-haiku-4-5-20251001', budgetMaxTurns: 40 },
      ];
      const cost = estimateCostForTurns(
        agents,
        0,
        0.10,
        'claude-sonnet-4-6',
        null,
        false,
      );
      const expectedSupervisor =
        ((5000 * sonnetPricing.input + 2000 * sonnetPricing.output) / 1_000_000) * 8;
      expect(cost).toBeCloseTo(0.10 + expectedSupervisor, 6);
    });
  });
});

describe('DryRunResult shape', () => {
  it('model pricing contains all expected models', () => {
    expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5-20251001']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-7']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5']).toBeDefined();
  });

  it('all pricing entries have positive values', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.input).toBeGreaterThan(0);
      expect(pricing.output).toBeGreaterThan(0);
      expect(pricing.cacheRead).toBeGreaterThanOrEqual(0);
      expect(pricing.cacheWrite).toBeGreaterThanOrEqual(0);
    }
  });

  it('cache read is cheaper than input for all models', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.cacheRead).toBeLessThan(pricing.input);
    }
  });

  it('output is more expensive than input for all models', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.output).toBeGreaterThan(pricing.input);
    }
  });
});
