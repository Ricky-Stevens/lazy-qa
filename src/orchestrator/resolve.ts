import { resolveAgentCredentials } from '../config/load.ts';
import type { Config } from '../config/types.ts';
import type { SkillsBundle } from '../skills/loader.ts';
import type { ResolvedAgent } from '../types/agent.ts';

export async function resolveAgents(cfg: Config, skillsBundle: SkillsBundle): Promise<ResolvedAgent[]> {
  return Promise.all(
    cfg.agents.map(async (agentCfg) => {
      // Look up persona via skills bundle instead of loadProfile()
      const persona = skillsBundle.personas.get(agentCfg.profile);
      if (!persona) {
        throw new Error(
          `Profile '${agentCfg.profile}' not found in skills bundle. ` +
            `Available personas: ${Array.from(skillsBundle.personas.keys()).join(', ')}`,
        );
      }
      if (!persona.defaultBudget) {
        throw new Error(`Persona '${agentCfg.profile}' is missing defaultBudget in SKILL.md`);
      }

      const credentials = resolveAgentCredentials(agentCfg);

      // Merge budget: start with persona defaults, overlay any explicit overrides
      const budget = {
        max_turns: agentCfg.budget?.max_turns ?? persona.defaultBudget.max_turns,
        max_usd: agentCfg.budget?.max_usd ?? persona.defaultBudget.max_usd,
        max_minutes: agentCfg.budget?.max_minutes ?? persona.defaultBudget.max_minutes,
      };

      // Personality is the persona body; override if explicitly set on the agent config
      const personality = agentCfg.override_personality ?? persona.body;
      const model = agentCfg.model ?? cfg.anthropic.default_model;

      // Profile name becomes "custom" when the personality is overridden
      const profileName = agentCfg.override_personality != null ? 'custom' : persona.name;

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
