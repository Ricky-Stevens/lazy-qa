/**
 * Reason why a journey ended.
 */
export type TerminationReason =
  | 'end_session'
  | 'budget-hit'
  | 'error'
  | 'timeout'
  | 'signal'
  | 'max-turns'
  /** SDK-mode loop ended gracefully (SDK exhausted turns or got end_turn). */
  | 'sdk-end';

/**
 * Token usage for a journey.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * A complete journey log for one agent's exploration session.
 */
export interface Journey {
  // Unique run identifier (e.g. timestamp-based)
  runId: string;
  // Agent id from config
  agentId: string;
  // ISO 8601 timestamp when exploration started
  startedAt: string;
  // ISO 8601 timestamp when exploration ended (undefined while running)
  endedAt?: string;
  // Initial target URL
  startUrl: string;
  // Number of agent turns completed (assistant messages from the SDK stream)
  turns: number;
  // Findings reported during this journey
  findings: import('./finding.ts').Finding[];
  // Token usage stats
  tokenUsage: TokenUsage;
  // Estimated cost in USD (input + output + cache)
  costUsd: number;
  // Why the journey ended (undefined while running)
  terminationReason?: TerminationReason;
}
