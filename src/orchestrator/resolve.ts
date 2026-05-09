import { resolveAgentCredentials, resolveTargetCredentials } from '../config/load.ts';
import type { AgentConfig, Config } from '../config/types.ts';
import type { SkillsBundle } from '../skills/loader.ts';
import { ATTACKER_PROFILES } from '../tools/browser-server.ts';
import type { ResolvedAgent } from '../types/agent.ts';

/**
 * Resolve manually-configured agents from the `agents` array in config.
 * Per-agent credentials fall back to target.auth.credentials when omitted.
 */
export async function resolveAgents(
  cfg: Config,
  skillsBundle: SkillsBundle,
): Promise<ResolvedAgent[]> {
  if (cfg.agents === 'auto') {
    throw new Error('resolveAgents called with agents=auto — use buildAgentQueues instead');
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

// ─── Slot-based queue builder ────────────────────────────────────────────────

export interface AgentQueues {
  securityQueue: ResolvedAgent[];
  qaQueue: ResolvedAgent[];
}

const AUTH_GATED_ATTACKERS = new Set([
  'bobby-tables',
  'sudo',
  'mystique',
  'mitnick',
  'trust-me-bro',
  'rickroll',
]);

/**
 * Build two ordered agent queues from ALL personas in the skills bundle.
 *
 * Security queue: ordered by (wave ASC, name ASC). Wave gating is enforced
 * at dequeue time by the rebalancer, not here.
 *
 * QA queue: ordered alphabetically by name for deterministic, reproducible runs.
 *
 * Each agent gets its SKILL.md defaultBudget verbatim — no pool-splitting.
 */
export function buildAgentQueues(cfg: Config, skillsBundle: SkillsBundle): AgentQueues {
  const sel = cfg.agent_selection;
  const credentials = resolveTargetCredentials(cfg);
  const isAuth = cfg.target.auth.type === 'form';

  const securityQueue: ResolvedAgent[] = [];
  const qaQueue: ResolvedAgent[] = [];

  for (const [name, persona] of skillsBundle.personas) {
    if (persona.type !== 'persona') continue;
    if (!persona.defaultBudget) continue;

    const isAttacker = persona.category === 'attacker';

    if (isAttacker && !isAuth && AUTH_GATED_ATTACKERS.has(name)) continue;

    const defaultModel = isAttacker
      ? sel.attacker_model
      : (sel.qa_model ?? cfg.anthropic.default_model);
    const model = persona.model ?? defaultModel;
    const thinkingTokens = isAttacker ? sel.attacker_thinking_tokens : sel.qa_thinking_tokens;

    const agent: ResolvedAgent = {
      id: name,
      profileName: persona.name,
      personality: persona.body,
      model,
      maxThinkingTokens: thinkingTokens,
      plannerModel: undefined,
      budget: {
        max_turns: persona.defaultBudget.max_turns,
        max_usd: persona.defaultBudget.max_usd,
        max_minutes: persona.defaultBudget.max_minutes,
      },
      credentials,
    };

    if (isAttacker) {
      securityQueue.push(agent);
    } else {
      qaQueue.push(agent);
    }
  }

  securityQueue.sort((a, b) => {
    const waveA = skillsBundle.personas.get(a.profileName)?.wave ?? 0;
    const waveB = skillsBundle.personas.get(b.profileName)?.wave ?? 0;
    if (waveA !== waveB) return waveA - waveB;
    return a.profileName.localeCompare(b.profileName);
  });

  qaQueue.sort((a, b) => a.profileName.localeCompare(b.profileName));

  return { securityQueue, qaQueue };
}
