import type { Budget } from '../config/types.ts';

/**
 * A resolved agent after profile resolution + credentials resolution.
 * This is the runtime shape of an agent, distinct from AgentConfig.
 */
export interface ResolvedAgent {
  // Unique agent identifier
  id: string;
  // Profile name (slug like "power-user", or "custom" if override)
  profileName: string;
  // Resolved personality text (from profile or override_personality). The persona
  // IS the goal — there is no separate workflow or task description.
  personality: string;
  // Model to use (e.g. "claude-sonnet-4-6")
  model: string;
  // Optional cap on extended-thinking tokens. 0 disables thinking entirely
  // (fastest); 1500-3000 keeps multi-step coherence on Sonnet personas.
  // Undefined = SDK default for the chosen model.
  maxThinkingTokens?: number;
  // Optional separate model for between-chunk planning. When set, a brief plan
  // call uses this model; the cheap main model executes the plan.
  plannerModel?: string;
  // Budget with all fields filled (no optionals)
  budget: Required<Budget>;
  // Login credentials (resolved from env vars). null when target.auth.type === 'none'.
  credentials: { username: string; password: string } | null;
}
