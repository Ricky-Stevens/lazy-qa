// CHECK: verify against current anthropic pricing; update as needed
// Prices are per 1,000,000 tokens in USD

export interface PricePerMillion {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICING: Record<string, PricePerMillion> = {
  // CHECK: verify against current anthropic pricing; update as needed
  'claude-opus-4-7': {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  // CHECK: verify against current anthropic pricing; update as needed
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  // CHECK: verify against current anthropic pricing; update as needed
  'claude-haiku-4-5-20251001': {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite: 2.0,
  },
};

// Alias: short model name → canonical pricing
MODEL_PRICING['claude-haiku-4-5'] = MODEL_PRICING['claude-haiku-4-5-20251001']!;

export function computeCostUsd(
  model: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const conservativePerMillion = 15;
    return (totalTokens * conservativePerMillion) / 1_000_000;
  }
  return (
    (usage.input * pricing.input +
      usage.output * pricing.output +
      usage.cacheRead * pricing.cacheRead +
      usage.cacheWrite * pricing.cacheWrite) /
    1_000_000
  );
}

/** Compute the dollar savings from cache reads vs paying full input price. */
export function computeCacheSavingsUsd(model: string, cacheReadTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  const fullCost = (cacheReadTokens * pricing.input) / 1_000_000;
  const actualCost = (cacheReadTokens * pricing.cacheRead) / 1_000_000;
  return Math.max(0, fullCost - actualCost);
}
