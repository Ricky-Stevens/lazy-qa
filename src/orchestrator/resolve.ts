import { resolveAgentCredentials, resolveTargetCredentials } from '../config/load.ts';
import type { AgentConfig, Config } from '../config/types.ts';
import type { SkillsBundle } from '../skills/loader.ts';
import { ATTACKER_PROFILES } from '../tools/browser-server.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { RosterRecommendation } from './site-playbook.ts';

/**
 * Resolve manually-configured agents from the `agents` array in config.
 * Per-agent credentials fall back to target.auth.credentials when omitted.
 */
export async function resolveAgents(
  cfg: Config,
  skillsBundle: SkillsBundle,
): Promise<ResolvedAgent[]> {
  if (cfg.agents === 'auto') {
    throw new Error('resolveAgents called with agents=auto — use resolveAutoAgents instead');
  }
  const targetCreds = resolveTargetCredentials(cfg);
  return Promise.all(
    cfg.agents.map(async (agentCfg) => {
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

      const credentials = resolveAgentCredentials(agentCfg) ?? targetCreds;

      const budget = {
        max_turns: agentCfg.budget?.max_turns ?? persona.defaultBudget.max_turns,
        max_usd: agentCfg.budget?.max_usd ?? persona.defaultBudget.max_usd,
        max_minutes: agentCfg.budget?.max_minutes ?? persona.defaultBudget.max_minutes,
      };

      const model = agentCfg.model ?? cfg.anthropic.default_model;

      const resolved: ResolvedAgent = {
        id: agentCfg.id,
        profileName: persona.name,
        personality: persona.body,
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

/**
 * Resolve agents automatically from the site-playbook's roster recommendation.
 *
 * Pipeline:
 * 1. Start with the LLM-recommended roster (sorted by priority)
 * 2. Apply hard rules (auth.type gates attacker selection)
 * 3. Cap to max_agents
 * 4. Allocate budgets from the total pool
 * 5. Build ResolvedAgent[] with models from agent_selection config
 */
export function resolveAutoAgents(
  roster: RosterRecommendation[],
  cfg: Config,
  skillsBundle: SkillsBundle,
): ResolvedAgent[] {
  const sel = cfg.agent_selection;
  const credentials = resolveTargetCredentials(cfg);
  const isAuth = cfg.target.auth.type === 'form';

  // Sort by priority (1 = must-have first), then alphabetically for stability.
  const sorted = [...roster].sort(
    (a, b) => a.priority - b.priority || a.persona.localeCompare(b.persona),
  );

  // Hard rules: gate attacker personas by auth type.
  const filtered = sorted.filter((r) => {
    const isAttacker = ATTACKER_PROFILES.has(r.persona);
    // bobby-tables (insider) requires auth
    if (r.persona === 'bobby-tables' && !isAuth) return false;
    // zero-cool (external) is always valid — probes unauthenticated surface
    if (r.persona === 'zero-cool') return true;
    // Other attackers: require auth if they use authenticated tools
    if (isAttacker && !isAuth) return false;
    return true;
  });

  // Ensure at least one attacker is present.
  const hasAttacker = filtered.some((r) => ATTACKER_PROFILES.has(r.persona));
  if (!hasAttacker) {
    // Add zero-cool (external attacker) as minimum attacker.
    const zeroCool = skillsBundle.personas.get('zero-cool');
    if (zeroCool) {
      filtered.unshift({ persona: 'zero-cool', priority: 1, reason: 'auto: minimum attacker' });
    }
  }

  // Cap to max_agents.
  const capped = filtered.slice(0, sel.max_agents);

  // Budget allocation.
  const supervisorCost = cfg.supervisor.enabled ? cfg.supervisor.max_usd : 0;
  const reviewEstimate = cfg.review.enabled ? 1.5 : 0;
  const totalPool = Math.max(cfg.run.max_budget_usd - supervisorCost - reviewEstimate, 2);

  const attackerCount = capped.filter((r) => ATTACKER_PROFILES.has(r.persona)).length;
  const qaCount = capped.length - attackerCount;

  // Attackers get ~35% of pool (capped at $4 each), QA splits the rest.
  const attackerBudgetEach = Math.min(
    totalPool * 0.35 / Math.max(attackerCount, 1),
    4.0,
  );
  const qaPool = totalPool - attackerCount * attackerBudgetEach;
  const qaBudgetEach = qaCount > 0 ? Math.min(qaPool / qaCount, 2.5) : 0;

  const qaModel = sel.qa_model ?? cfg.anthropic.default_model;

  return capped.map((r) => {
    const persona = skillsBundle.personas.get(r.persona);
    if (!persona) {
      throw new Error(
        `Auto roster recommended persona '${r.persona}' but it's not in the skills bundle. ` +
          `Available: ${Array.from(skillsBundle.personas.keys()).join(', ')}`,
      );
    }
    if (!persona.defaultBudget) {
      throw new Error(`Persona '${r.persona}' is missing defaultBudget in SKILL.md`);
    }

    const isAttacker = ATTACKER_PROFILES.has(r.persona);
    const budgetUsd = isAttacker ? attackerBudgetEach : qaBudgetEach;
    const model = isAttacker ? sel.attacker_model : qaModel;
    const thinkingTokens = isAttacker ? sel.attacker_thinking_tokens : sel.qa_thinking_tokens;
    const maxMinutes = isAttacker ? 25 : 20;

    return {
      id: r.persona,
      profileName: persona.name,
      personality: persona.body,
      model,
      maxThinkingTokens: thinkingTokens,
      plannerModel: undefined,
      budget: {
        max_turns: persona.defaultBudget.max_turns,
        max_usd: Math.round(budgetUsd * 100) / 100,
        max_minutes: maxMinutes,
      },
      credentials,
    };
  });
}
