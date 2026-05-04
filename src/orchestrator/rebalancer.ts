/**
 * Adaptive Agent Pool Manager.
 *
 * Runs every TICK_INTERVAL_MS during a scan. Scores each agent's health
 * based on finding velocity, action diversity, cost efficiency, and
 * momentum. Agents that persistently score low are terminated and their
 * budget is either redistributed to high-performers or used to spawn a
 * replacement persona from the unused pool.
 *
 * Health scoring uses rolling windows — an agent that found 5 things
 * early then stalled scores lower than one that just found its first bug.
 * This rewards sustained output over early luck.
 */

import type { Logger } from '../logging/logger.ts';
import type { SiteMapAccessor } from '../crawler/types.ts';
import type { SkillsBundle } from '../skills/loader.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import { ATTACKER_PROFILES } from '../tools/browser-server.ts';
import { snapshotAll, type AgentRuntimeState } from './registry.ts';
import type { EventWriter } from './events.ts';

// ─── Tuning constants ────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 45_000;
const GRACE_PERIOD_TURNS = 20;
const PROBATION_TICKS_BEFORE_TERMINATE = 2;
const MIN_SPEND_BEFORE_EVAL = 0.15;

// Health score thresholds.
const THRESHOLD_THRIVING = 50;
const THRESHOLD_STRUGGLING = 25;

// Finding recency windows.
const RECENCY_HOT_MS = 2 * 60_000;
const RECENCY_WARM_MS = 5 * 60_000;
const RECENCY_COOL_MS = 10 * 60_000;

// ─── Health scoring ──────────────────────────────────────────────────────────

interface AgentHealth {
  agentId: string;
  score: number;
  breakdown: {
    findingRecency: number;
    actionDiversity: number;
    costEfficiency: number;
    momentum: number;
  };
  findings: number;
  turns: number;
  spent: number;
  remaining: number;
  isFinished: boolean;
  isAttacker: boolean;
}

function computeHealth(
  agent: ResolvedAgent,
  journey: Journey,
  registry: AgentRuntimeState | undefined,
  now: number,
): AgentHealth {
  const findings = journey.findings.length;
  const turns = journey.turns;
  const spent = journey.costUsd;
  const remaining = agent.budget.max_usd - spent;
  const isFinished = !!journey.terminationReason;
  const isAttacker = ATTACKER_PROFILES.has(agent.profileName);
  const inGrace = turns < GRACE_PERIOD_TURNS;

  // 1. Finding recency (0–30): rewards recent output over stale history.
  let findingRecency = 0;
  if (inGrace) {
    findingRecency = 15;
  } else if (findings > 0) {
    const lastFindingTs = journey.findings[findings - 1]?.ts;
    const lastFindingAge = lastFindingTs ? now - new Date(lastFindingTs).getTime() : Infinity;
    if (lastFindingAge < RECENCY_HOT_MS) findingRecency = 30;
    else if (lastFindingAge < RECENCY_WARM_MS) findingRecency = 20;
    else if (lastFindingAge < RECENCY_COOL_MS) findingRecency = 12;
    else findingRecency = 5;
  }

  // 2. Action diversity (0–25): unique tools in the recent window.
  let actionDiversity = 0;
  if (registry) {
    const uniqueTools = new Set(registry.recentTools).size;
    if (uniqueTools >= 5) actionDiversity = 25;
    else if (uniqueTools >= 3) actionDiversity = 15;
    else if (uniqueTools >= 2) actionDiversity = 8;
    else actionDiversity = 2;
  }

  // 3. Cost efficiency (0–25): findings per dollar.
  let costEfficiency = 0;
  if (spent > 0 && findings > 0) {
    const fpd = findings / spent;
    if (fpd > 5) costEfficiency = 25;
    else if (fpd > 2) costEfficiency = 20;
    else if (fpd > 0.5) costEfficiency = 12;
    else costEfficiency = 6;
  } else if (inGrace) {
    costEfficiency = 10;
  }

  // 4. Momentum (0–20): how recently the agent made a model turn.
  let momentum = 0;
  if (registry?.lastTurnAt) {
    const sinceTurn = now - registry.lastTurnAt;
    if (sinceTurn < 10_000) momentum = 20;
    else if (sinceTurn < 30_000) momentum = 15;
    else if (sinceTurn < 60_000) momentum = 10;
  }

  // 5. Stagnation penalty: an agent past grace with zero findings is burning
  // budget for nothing. Cap the activity-only components (momentum + diversity)
  // so pure busy-work can't keep the score above the struggling threshold.
  // Without this, an active-but-unproductive agent scores ~35 from momentum (20)
  // + diversity (15) alone, which exceeds THRESHOLD_STRUGGLING (25) and the
  // rebalancer never terminates it.
  if (!inGrace && findings === 0 && spent >= MIN_SPEND_BEFORE_EVAL) {
    actionDiversity = Math.min(actionDiversity, 8);
    momentum = Math.min(momentum, 5);
  }

  const score = findingRecency + actionDiversity + costEfficiency + momentum;

  return {
    agentId: agent.id,
    score,
    breakdown: { findingRecency, actionDiversity, costEfficiency, momentum },
    findings,
    turns,
    spent,
    remaining,
    isFinished,
    isAttacker,
  };
}

// ─── Pool context (everything the rebalancer needs to spawn replacements) ────

export interface PoolContext {
  agents: ResolvedAgent[];
  journeys: Map<string, Journey>;
  siteMap: SiteMapAccessor;
  skillsBundle: SkillsBundle;
  /** Called to spawn a replacement agent. The rebalancer builds the
   *  ResolvedAgent; this callback handles the actual spawnAgent() call. */
  spawnReplacement: (agent: ResolvedAgent) => void;
  logger: Logger;
  events?: EventWriter;
  abortSignal?: AbortSignal;
  defaultModel: string;
  authType: 'form' | 'none';
  credentials: { username: string; password: string } | null;
}

// ─── Replacement persona selection ───────────────────────────────────────────

function selectReplacementPersona(
  ctx: PoolContext,
  terminatedProfile: string,
): string | null {
  const runningProfiles = new Set(
    ctx.agents
      .filter((a) => {
        const j = ctx.journeys.get(a.id);
        return j && !j.terminationReason;
      })
      .map((a) => a.profileName),
  );

  // Check what's untested.
  const untestedForms = ctx.siteMap.listFormsUntested('form_fuzz_validation').length;
  const untestedRoutes = ctx.siteMap.listUnvisitedRoutes().length;

  // Persona priority based on what's uncovered.
  const candidates: Array<{ name: string; score: number }> = [];

  for (const [name, persona] of ctx.skillsBundle.personas) {
    if (runningProfiles.has(name)) continue;
    if (name === terminatedProfile) continue;

    const isAttacker = ATTACKER_PROFILES.has(name);
    if (isAttacker && ctx.authType === 'none' && name === 'bobby-tables') continue;

    let score = 0;
    if (isAttacker) {
      score = 30;
    } else if (untestedForms > 5 && (name === 'house' || name === 'the-spanner')) {
      score = 25;
    } else if (untestedRoutes > 10 && (name === 'caine' || name === 'the-magpie')) {
      score = 20;
    } else if (name === 'leeroy-jenkins') {
      score = 15;
    } else {
      score = 10;
    }

    candidates.push({ name, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.name ?? null;
}

// ─── Main tick ───────────────────────────────────────────────────────────────

const probationCounters = new Map<string, number>();

function tick(ctx: PoolContext): void {
  const now = Date.now();
  const registrySnap = new Map(snapshotAll().map((s) => [s.agentId, s]));

  const healths: AgentHealth[] = [];
  for (const agent of ctx.agents) {
    const journey = ctx.journeys.get(agent.id);
    if (!journey) continue;
    const health = computeHealth(agent, journey, registrySnap.get(agent.id), now);
    healths.push(health);
  }

  const active = healths.filter((h) => !h.isFinished);
  if (active.length <= 1) {
    emitTickEvent(ctx, active, [], {});
    return;
  }

  const terminated: string[] = [];
  const boosted: Record<string, number> = {};
  let freedBudget = 0;

  for (const health of active) {
    if (health.spent < MIN_SPEND_BEFORE_EVAL) continue;
    if (health.turns < GRACE_PERIOD_TURNS) continue;

    if (health.score < THRESHOLD_STRUGGLING) {
      const prev = probationCounters.get(health.agentId) ?? 0;
      probationCounters.set(health.agentId, prev + 1);

      if (prev + 1 >= PROBATION_TICKS_BEFORE_TERMINATE) {
        const journey = ctx.journeys.get(health.agentId);
        if (journey) {
          journey.terminationReason = 'rebalanced';
          freedBudget += Math.max(health.remaining, 0);
          terminated.push(health.agentId);

          ctx.logger.info('rebalancer.terminate', {
            agentId: health.agentId,
            score: health.score,
            breakdown: health.breakdown,
            turns: health.turns,
            findings: health.findings,
            spent: `$${health.spent.toFixed(2)}`,
            freed: `$${Math.max(health.remaining, 0).toFixed(2)}`,
          });
        }
        probationCounters.delete(health.agentId);
      } else {
        ctx.logger.info('rebalancer.probation', {
          agentId: health.agentId,
          score: health.score,
          tick: prev + 1,
          of: PROBATION_TICKS_BEFORE_TERMINATE,
        });
      }
    } else {
      // Recovered — clear probation.
      probationCounters.delete(health.agentId);
    }
  }

  if (freedBudget <= 0 && terminated.length === 0) {
    // No terminations — check if any thriving agent needs a boost.
    for (const health of active) {
      if (
        health.score >= THRESHOLD_THRIVING &&
        health.findings >= 3 &&
        health.spent / (health.spent + health.remaining) >= 0.80
      ) {
        // Agent is thriving but running out. Give it a small bump from
        // the global pool headroom (if any).
        const bump = Math.min(0.50, health.remaining * 0.5);
        if (bump > 0.05) {
          const agent = ctx.agents.find((a) => a.id === health.agentId);
          if (agent) {
            agent.budget.max_usd += bump;
            boosted[health.agentId] = bump;
            ctx.logger.info('rebalancer.boost', {
              agentId: health.agentId,
              score: health.score,
              findings: health.findings,
              boost: `+$${bump.toFixed(2)}`,
            });
          }
        }
      }
    }
    emitTickEvent(ctx, active, terminated, boosted);
    return;
  }

  // Redistribute freed budget.
  if (freedBudget > 0) {
    // Decision: spawn a replacement or boost existing?
    const thriving = active.filter(
      (h) => !terminated.includes(h.agentId) && h.score >= THRESHOLD_THRIVING,
    );

    // Try to spawn a replacement for each terminated agent.
    let budgetForReplacements = freedBudget * 0.6;
    let budgetForBoosts = freedBudget * 0.4;
    let spawned = 0;

    for (const agentId of terminated) {
      if (budgetForReplacements < 0.30) break;

      const terminatedAgent = ctx.agents.find((a) => a.id === agentId);
      if (!terminatedAgent) continue;

      const replacementPersona = selectReplacementPersona(ctx, terminatedAgent.profileName);
      if (!replacementPersona) continue;

      const persona = ctx.skillsBundle.personas.get(replacementPersona);
      if (!persona?.defaultBudget) continue;

      const isAttacker = ATTACKER_PROFILES.has(replacementPersona);
      const replacementBudget = Math.min(budgetForReplacements, isAttacker ? 2.5 : 1.5);
      budgetForReplacements -= replacementBudget;

      const suffix = spawned > 0 ? `-${spawned + 1}` : '-r';
      const newAgent: ResolvedAgent = {
        id: `${replacementPersona}${suffix}`,
        profileName: persona.name,
        personality: persona.body,
        model: isAttacker ? 'claude-sonnet-4-6' : ctx.defaultModel,
        maxThinkingTokens: isAttacker ? 2000 : 1024,
        plannerModel: undefined,
        budget: {
          max_turns: persona.defaultBudget.max_turns,
          max_usd: Math.round(replacementBudget * 100) / 100,
          max_minutes: isAttacker ? 20 : 15,
        },
        credentials: ctx.credentials,
      };

      ctx.agents.push(newAgent);
      ctx.spawnReplacement(newAgent);
      spawned += 1;

      ctx.logger.info('rebalancer.spawn', {
        newAgentId: newAgent.id,
        persona: replacementPersona,
        budget: `$${newAgent.budget.max_usd.toFixed(2)}`,
        replacing: agentId,
      });
    }

    // Boost remaining budget to thriving agents.
    budgetForBoosts += budgetForReplacements;
    if (budgetForBoosts > 0.05 && thriving.length > 0) {
      const totalFindings = thriving.reduce((s, h) => s + h.findings, 0) || 1;
      for (const h of thriving) {
        const share = (h.findings / totalFindings) * budgetForBoosts;
        const rounded = Math.round(share * 100) / 100;
        if (rounded < 0.05) continue;
        const agent = ctx.agents.find((a) => a.id === h.agentId);
        if (agent) {
          agent.budget.max_usd += rounded;
          boosted[h.agentId] = rounded;
          ctx.logger.info('rebalancer.boost', {
            agentId: h.agentId,
            score: h.score,
            findings: h.findings,
            boost: `+$${rounded.toFixed(2)}`,
          });
        }
      }
    }
  }

  emitTickEvent(ctx, active, terminated, boosted);
}

/** Emit a rebalancer.tick event with health scores for observability. */
function emitTickEvent(
  ctx: PoolContext,
  active: AgentHealth[],
  terminated: string[],
  boosted: Record<string, number>,
): void {
  void ctx.events?.write({
    type: 'rebalancer.tick',
    terminated,
    boosted,
    activeAgents: active.length - terminated.length,
    healthScores: active.map((h) => ({
      agentId: h.agentId,
      score: h.score,
      findings: h.findings,
      turns: h.turns,
      spent: h.spent,
    })),
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startRebalancer(ctx: PoolContext): () => void {
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped || ctx.abortSignal?.aborted) return;
    try {
      tick(ctx);
    } catch (err) {
      ctx.logger.warn('rebalancer.error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, TICK_INTERVAL_MS);

  const onAbort = () => {
    stopped = true;
    clearInterval(interval);
  };
  ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });

  return () => {
    stopped = true;
    clearInterval(interval);
    ctx.abortSignal?.removeEventListener('abort', onAbort);
  };
}
