/**
 * Slot-Based Agent Pool Manager.
 *
 * Maintains a fixed number of concurrent agent slots (default: 2 security +
 * 2 QA). Every TICK_INTERVAL_MS it:
 *   1. Scores each running agent's health
 *   2. Terminates stagnant agents (freeing their slot)
 *   3. Fills any empty slots from the queues
 *
 * Security queue is wave-gated: wave N agents only dequeue when all wave
 * N-1 agents have finished. QA queue is FIFO.
 */

import type { Logger } from '../logging/logger.ts';
import type { SkillsBundle } from '../skills/loader.ts';
import { ATTACKER_PROFILES } from '../tools/browser-server.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import type { EventWriter } from './events.ts';
import { type AgentRuntimeState, snapshotAll } from './registry.ts';

// ─── Tuning constants ────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 15_000;
const GRACE_PERIOD_TURNS = 8;
const PROBATION_TICKS_BEFORE_TERMINATE = 2;
const MIN_SPEND_BEFORE_EVAL = 0.08;

const THRESHOLD_THRIVING = 50;
const THRESHOLD_STRUGGLING = 25;

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

  let actionDiversity = 0;
  if (registry) {
    const uniqueTools = new Set(registry.recentTools).size;
    if (uniqueTools >= 5) actionDiversity = 25;
    else if (uniqueTools >= 3) actionDiversity = 15;
    else if (uniqueTools >= 2) actionDiversity = 8;
    else actionDiversity = 2;
  }

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

  let momentum = 0;
  if (registry?.lastTurnAt) {
    const sinceTurn = now - registry.lastTurnAt;
    if (sinceTurn < 10_000) momentum = 20;
    else if (sinceTurn < 30_000) momentum = 15;
    else if (sinceTurn < 60_000) momentum = 10;
  }

  // Stagnation penalty: 0 findings past grace → cap activity scores hard.
  if (!inGrace && findings === 0 && spent >= MIN_SPEND_BEFORE_EVAL) {
    actionDiversity = Math.min(actionDiversity, 5);
    momentum = Math.min(momentum, 3);
  }

  // Stale-finding penalty: agent found something early but nothing recent.
  // One early finding shouldn't grant permanent immunity. Triggers 10 turns
  // after grace period, or when the last finding is older than RECENCY_COOL_MS.
  if (!inGrace && findings > 0 && turns > GRACE_PERIOD_TURNS + 10) {
    const lastFindingTs = journey.findings[findings - 1]?.ts;
    const lastFindingAge = lastFindingTs ? now - new Date(lastFindingTs).getTime() : Infinity;
    if (lastFindingAge > RECENCY_WARM_MS) {
      actionDiversity = Math.min(actionDiversity, 5);
      momentum = Math.min(momentum, 3);
    }
  }

  // Findings-per-turn floor: an agent burning 15+ turns with fewer than
  // 1 finding per 15 turns is wandering, not testing — regardless of how
  // "active" it looks. Hard cap on total score.
  if (!inGrace && turns >= 15 && findings < Math.ceil(turns / 15)) {
    findingRecency = Math.min(findingRecency, 5);
    costEfficiency = Math.min(costEfficiency, 3);
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

// ─── Pool context ────────────────────────────────────────────────────────────

export interface PoolContext {
  agents: ResolvedAgent[];
  journeys: Map<string, Journey>;
  skillsBundle: SkillsBundle;
  spawnReplacement: (agent: ResolvedAgent) => void;
  logger: Logger;
  events?: EventWriter;
  abortSignal?: AbortSignal;
  defaultModel: string;
  authType: 'form' | 'none';
  credentials: { username: string; password: string } | null;
  securityQueue: ResolvedAgent[];
  qaQueue: ResolvedAgent[];
  securitySlots: number;
  qaSlots: number;
}

// ─── Wave-gated security dequeue ─────────────────────────────────────────────

function dequeueNextSecurity(ctx: PoolContext): ResolvedAgent | null {
  if (ctx.securityQueue.length === 0) return null;

  const nextAgent = ctx.securityQueue[0]!;
  const nextPersona = ctx.skillsBundle.personas.get(nextAgent.profileName);
  const nextWave = nextPersona?.wave ?? 0;

  if (nextWave > 0) {
    const prevWave = nextWave - 1;
    const prevWaveRunning = ctx.agents.some((a) => {
      const p = ctx.skillsBundle.personas.get(a.profileName);
      if (p?.category !== 'attacker') return false;
      if ((p?.wave ?? 0) !== prevWave) return false;
      const j = ctx.journeys.get(a.id);
      return j && !j.terminationReason;
    });

    // Also check: are there previous-wave agents still in the queue ahead of us?
    // (Shouldn't happen since queue is wave-sorted, but guard anyway.)
    const prevWaveQueued = ctx.securityQueue.some((a) => {
      if (a === nextAgent) return false;
      const p = ctx.skillsBundle.personas.get(a.profileName);
      return (p?.wave ?? 0) === prevWave;
    });

    if (prevWaveRunning || prevWaveQueued) return null;
  }

  return ctx.securityQueue.shift()!;
}

// ─── Slot filling ────────────────────────────────────────────────────────────

function fillSlots(ctx: PoolContext): void {
  let activeSecurity = 0;
  let activeQa = 0;
  for (const agent of ctx.agents) {
    const journey = ctx.journeys.get(agent.id);
    if (!journey || journey.terminationReason) continue;
    if (ATTACKER_PROFILES.has(agent.profileName)) activeSecurity++;
    else activeQa++;
  }

  while (activeSecurity < ctx.securitySlots && ctx.securityQueue.length > 0) {
    const next = dequeueNextSecurity(ctx);
    if (!next) break;
    ctx.agents.push(next);
    ctx.spawnReplacement(next);
    activeSecurity++;

    const persona = ctx.skillsBundle.personas.get(next.profileName);
    ctx.logger.info('slot.fill', {
      agentId: next.id,
      category: 'security',
      wave: persona?.wave,
      activeSlots: activeSecurity + activeQa,
      securityQueueRemaining: ctx.securityQueue.length,
      qaQueueRemaining: ctx.qaQueue.length,
    });
    void ctx.events?.write({
      type: 'slot.fill',
      agentId: next.id,
      category: 'security',
      wave: persona?.wave,
      securityQueueRemaining: ctx.securityQueue.length,
      qaQueueRemaining: ctx.qaQueue.length,
      activeSlots: activeSecurity + activeQa,
    });
  }

  while (activeQa < ctx.qaSlots && ctx.qaQueue.length > 0) {
    const next = ctx.qaQueue.shift()!;
    ctx.agents.push(next);
    ctx.spawnReplacement(next);
    activeQa++;

    ctx.logger.info('slot.fill', {
      agentId: next.id,
      category: 'qa',
      activeSlots: activeSecurity + activeQa,
      securityQueueRemaining: ctx.securityQueue.length,
      qaQueueRemaining: ctx.qaQueue.length,
    });
    void ctx.events?.write({
      type: 'slot.fill',
      agentId: next.id,
      category: 'qa',
      securityQueueRemaining: ctx.securityQueue.length,
      qaQueueRemaining: ctx.qaQueue.length,
      activeSlots: activeSecurity + activeQa,
    });
  }

  if (
    ctx.securityQueue.length === 0 &&
    ctx.qaQueue.length === 0 &&
    activeSecurity === 0 &&
    activeQa === 0
  ) {
    ctx.logger.info('slot.drain', { totalAgentsRun: ctx.agents.length });
    void ctx.events?.write({
      type: 'slot.drain',
      totalAgentsRun: ctx.agents.length,
    });
  }
}

// ─── Main tick ───────────────────────────────────────────────────────────────

function tick(ctx: PoolContext, probationCounters: Map<string, number>): void {
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

  // Health scoring and termination (only when 2+ agents active).
  const terminated: string[] = [];
  const boosted: Record<string, number> = {};

  if (active.length >= 2) {
    let freedBudget = 0;

    for (const health of active) {
      if (health.spent < MIN_SPEND_BEFORE_EVAL) continue;
      if (health.turns < GRACE_PERIOD_TURNS) continue;

      const nudgeCount = registrySnap.get(health.agentId)?.nudgesReceived ?? 0;
      const fastKill = nudgeCount >= 2 && health.findings === 0;

      if (fastKill || health.score < THRESHOLD_STRUGGLING) {
        const prev = probationCounters.get(health.agentId) ?? 0;
        probationCounters.set(health.agentId, prev + 1);

        if (fastKill || prev + 1 >= PROBATION_TICKS_BEFORE_TERMINATE) {
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
        probationCounters.delete(health.agentId);
      }
    }

    // Boost thriving agents with any freed budget.
    if (freedBudget > 0.05) {
      const thriving = active.filter(
        (h) => !terminated.includes(h.agentId) && h.score >= THRESHOLD_THRIVING,
      );
      if (thriving.length > 0) {
        const totalFindings = thriving.reduce((s, h) => s + h.findings, 0) || 1;
        for (const h of thriving) {
          const share = (h.findings / totalFindings) * freedBudget;
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
  }

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

  // Fill any empty slots (from natural termination or rebalancer kills).
  fillSlots(ctx);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startRebalancer(ctx: PoolContext): () => void {
  let stopped = false;
  const probationCounters = new Map<string, number>();

  const interval = setInterval(() => {
    if (stopped || ctx.abortSignal?.aborted) return;
    try {
      tick(ctx, probationCounters);
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
