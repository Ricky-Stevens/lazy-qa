import { resolveAgentCredentials } from '../config/load.ts';
import type { Config } from '../config/types.ts';
import { loadProfile } from '../profiles/load.ts';
import type { ResolvedAgent } from '../types/agent.ts';

export async function resolveAgents(cfg: Config): Promise<ResolvedAgent[]> {
  return Promise.all(
    cfg.agents.map(async (agentCfg) => {
      const profile = await loadProfile(agentCfg.profile);
      const credentials = resolveAgentCredentials(agentCfg);

      // Merge budget: start with profile defaults, overlay any explicit overrides
      const budget = {
        max_turns: agentCfg.budget?.max_turns ?? profile.defaultBudget.max_turns,
        max_usd: agentCfg.budget?.max_usd ?? profile.defaultBudget.max_usd,
        max_minutes: agentCfg.budget?.max_minutes ?? profile.defaultBudget.max_minutes,
      };

      const personality = agentCfg.override_personality ?? profile.personality;
      const model = agentCfg.model ?? cfg.anthropic.default_model;

      // Profile name becomes "custom" when the personality is overridden
      const profileName = agentCfg.override_personality != null ? 'custom' : profile.name;

      const resolved: ResolvedAgent = {
        id: agentCfg.id,
        profileName,
        personality,
        model,
        maxThinkingTokens: agentCfg.max_thinking_tokens,
        plannerModel: agentCfg.planner_model,
        budget,
        credentials,
      };
      return resolved;
    }),
  );
}
