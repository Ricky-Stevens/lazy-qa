/**
 * Execute phase — agent spawning, rebalancing, supervisor, drain loop.
 */

import { mkdir } from 'node:fs/promises';
import type { Config } from '../../config/types.ts';
import type { SiteMapImpl } from '../../crawler/sitemap.ts';
import type { LlmBackend } from '../../llm/backend.ts';
import type { Logger } from '../../logging/logger.ts';
import { RateLimiter } from '../../safety/rate-limiter.ts';
import type { SkillsBundle } from '../../skills/loader.ts';
import { ATTACKER_PROFILES } from '../../tools/browser-server.ts';
import { SelectorCache } from '../../tools/selector-cache.ts';
import type { ResolvedAgent } from '../../types/agent.ts';
import type { Journey } from '../../types/journey.ts';
import type { ApplicationModel } from '../app-model.ts';
import { renderApplicationModelForPrompt } from '../app-model.ts';
import type { EventWriter } from '../events.ts';
import { FindingCache } from '../finding-cache.ts';
import type { LearningState, FalsePositivePattern } from '../learning.ts';
import { renderLearningContext } from '../learning.ts';
import { resolveMemoryPath } from '../memory.ts';
import { startRebalancer } from '../rebalancer.ts';
import { SharedKnowledge } from '../shared-knowledge.ts';
import type { SitePlaybookResult } from '../site-playbook.ts';
import { spawnAgent } from '../spawn-agent.ts';
import { runSupervisor } from '../supervisor.ts';
import type { TestPlan } from '../test-plan.ts';
import type { RouteDiff } from './intelligence.ts';

export interface ExecuteInput {
  runId: string;
  runDir: string;
  cfg: Config;
  backend: LlmBackend;
  siteMap: SiteMapImpl;
  skillsBundle: SkillsBundle;
  agents: ResolvedAgent[];
  securityQueue: ResolvedAgent[];
  qaQueue: ResolvedAgent[];
  isAutoMode: boolean;
  runCredentials: { username: string; password: string } | null;
  sessionInfo: { username: string; role?: string } | undefined;
  sitePlaybook: SitePlaybookResult;
  appModel: ApplicationModel | undefined;
  priorLearning: LearningState | null;
  routeDiff: RouteDiff;
  learningFpPatterns: FalsePositivePattern[];
  testPlan: TestPlan;
  logger: Logger;
  events: EventWriter;
  abortController: AbortController;
}

export interface ExecuteResult {
  journeys: Journey[];
  supervisorCostUsd: number;
  selectorCache: SelectorCache | undefined;
  /** Whether at least one agent was spawned (guards learning persistence). */
  agentPhaseStarted: boolean;
}

export async function executeAgents(input: ExecuteInput): Promise<ExecuteResult> {
  const {
    runId,
    runDir,
    cfg,
    backend,
    siteMap,
    skillsBundle,
    agents,
    securityQueue,
    qaQueue,
    isAutoMode,
    runCredentials,
    sessionInfo,
    sitePlaybook,
    appModel,
    priorLearning,
    routeDiff,
    learningFpPatterns,
    testPlan,
    logger,
    events,
    abortController: runAbortController,
  } = input;

  // Resolve and initialise the per-target memory directory.
  const memoryEnabled = cfg.memory.enabled;
  const memoryPath = resolveMemoryPath(cfg.target.url, cfg.memory.path);
  if (memoryEnabled) {
    await mkdir(memoryPath, { recursive: true });
  }

  // Selector cache.
  let selectorCache: SelectorCache | undefined;
  const selectorCacheEnabled = cfg.selector_cache.enabled;
  if (selectorCacheEnabled) {
    selectorCache = await SelectorCache.load(cfg.target.url);
  }

  // Cross-agent finding cache.
  const findingCache = new FindingCache();
  if (learningFpPatterns.length > 0) {
    findingCache.seedFalsePositivePatterns(learningFpPatterns);
    logger.child({ phase: 'learning' }).info('learning.fp-patterns-seeded', {
      count: learningFpPatterns.length,
    });
  }

  // Shared cross-agent intelligence.
  const sharedKnowledge = new SharedKnowledge();

  // Slot-based agent spawning.
  const runStartedAt = new Date().toISOString();
  const supervisorEnabled = cfg.supervisor.enabled;
  const SPAWN_STAGGER_MS = 2_000;
  const explorerPromises: ReturnType<typeof spawnAgent>[] = [];
  const liveJourneys = new Map<string, Journey>();

  const rateLimiter =
    cfg.target.max_rps > 0 ? new RateLimiter({ maxRps: cfg.target.max_rps }) : null;
  if (rateLimiter) rateLimiter.start();

  const spawnOne = (agent: ResolvedAgent) =>
    spawnAgent({
      runId,
      runDir,
      targetUrl: cfg.target.url,
      allowedHosts: cfg.target.allowed_hosts,
      bannedPathPrefixes: cfg.target.banned_path_prefixes,
      auth: cfg.target.auth,
      agent,
      backend,
      siteMap,
      logger,
      abortSignal: runAbortController.signal,
      stealth: cfg.target.stealth,
      memoryEnabled,
      memoryPath,
      skillsBundle,
      events,
      selectorCache,
      findingCache,
      sharedKnowledge,
      sessionInfo,
      siteSummary: sitePlaybook.siteSummary,
      siteShape: sitePlaybook.siteShape,
      appModelContext: appModel ? renderApplicationModelForPrompt(appModel) : undefined,
      learningContext: priorLearning
        ? renderLearningContext(priorLearning, routeDiff)
        : undefined,
      journeyMap: liveJourneys,
      rateLimiter: rateLimiter ?? undefined,
    });

  // Dequeue initial agents to fill slots.
  const sel = cfg.agent_selection;
  const initialAgents: ResolvedAgent[] = [];

  for (let i = 0; i < sel.security_slots && securityQueue.length > 0; i++) {
    const agent = securityQueue.shift()!;
    initialAgents.push(agent);
    agents.push(agent);
  }
  for (let i = 0; i < sel.qa_slots && qaQueue.length > 0; i++) {
    const agent = qaQueue.shift()!;
    initialAgents.push(agent);
    agents.push(agent);
  }

  // Spawn initial agents with stagger.
  const agentPhaseStarted = initialAgents.length > 0 || (!isAutoMode && agents.length > 0);
  for (let i = 0; i < initialAgents.length; i++) {
    explorerPromises.push(spawnOne(initialAgents[i]!));
    if (i < initialAgents.length - 1) {
      await new Promise((r) => setTimeout(r, SPAWN_STAGGER_MS));
    }
  }

  logger.info('slot.initial', {
    security: initialAgents.filter((a) => ATTACKER_PROFILES.has(a.profileName)).map((a) => a.id),
    qa: initialAgents.filter((a) => !ATTACKER_PROFILES.has(a.profileName)).map((a) => a.id),
    securityQueued: securityQueue.length,
    qaQueued: qaQueue.length,
  });

  // Slot manager (rebalancer).
  const replacementPromises: ReturnType<typeof spawnAgent>[] = [];
  const stopRebalancer = startRebalancer({
    agents,
    journeys: liveJourneys,
    skillsBundle,
    defaultModel: cfg.anthropic.default_model,
    authType: cfg.target.auth.type,
    credentials: runCredentials,
    securityQueue,
    qaQueue,
    securitySlots: sel.security_slots,
    qaSlots: sel.qa_slots,
    spawnReplacement: (newAgent) => {
      replacementPromises.push(spawnOne(newAgent));
    },
    logger: logger.child({ phase: 'rebalancer' }),
    events,
    abortSignal: runAbortController.signal,
  });

  const supervisorPromise = supervisorEnabled
    ? runSupervisor({
        backend,
        model: cfg.supervisor.model,
        maxMinutes: cfg.supervisor.max_minutes,
        maxUsd: cfg.supervisor.max_usd,
        maxTurns: cfg.supervisor.max_turns,
        abortSignal: runAbortController.signal,
        logger: logger.child({ agentId: 'supervisor' }),
        events,
        authType: cfg.target.auth.type,
        sharedKnowledge,
        siteMap,
        testPlan,
      }).catch((err) => {
        logger.error('supervisor.crashed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
    : Promise.resolve(null);

  // Wall-clock deadline.
  const totalAgentCount = agents.length + securityQueue.length + qaQueue.length;
  const totalSlots = sel.security_slots + sel.qa_slots;
  const avgMinutes = 10;
  const estimatedWaves = Math.ceil(totalAgentCount / Math.max(totalSlots, 1));
  const OUTER_WAIT_DEADLINE_MS = Math.max(
    estimatedWaves * avgMinutes * 60_000 * 1.5 + 5 * 60_000,
    cfg.supervisor.max_minutes * 60_000 * 2,
  );
  const outerDeadlineHandle = setTimeout(() => {
    logger.error('explorer.allSettled.deadline.fired', {
      deadlineMs: OUTER_WAIT_DEADLINE_MS,
    });
    runAbortController.abort();
  }, OUTER_WAIT_DEADLINE_MS);
  if (
    typeof outerDeadlineHandle === 'object' &&
    outerDeadlineHandle !== null &&
    'unref' in outerDeadlineHandle
  ) {
    (outerDeadlineHandle as { unref: () => void }).unref();
  }

  // Wait for initial agents to complete.
  const initialResults = (await Promise.allSettled(explorerPromises)) as PromiseSettledResult<{
    journey: Journey;
  }>[];

  // Drain slot-filled replacement agents until all queues empty and all done.
  const allSettledResults = [...initialResults];
  const DRAIN_TIMEOUT_MS = 5 * 60_000;
  const drainStart = Date.now();
  while (!runAbortController.signal.aborted) {
    // Batch any pending replacement promises.
    if (replacementPromises.length > 0) {
      const batch = replacementPromises.splice(0);
      const batchResults = (await Promise.allSettled(batch)) as PromiseSettledResult<{
        journey: Journey;
      }>[];
      allSettledResults.push(...batchResults);
      continue;
    }

    // Check whether all agents are truly done via the liveJourneys map.
    const allTerminated = Array.from(liveJourneys.values()).every((j) => !!j.terminationReason);
    const queuesEmpty = securityQueue.length === 0 && qaQueue.length === 0;
    if (queuesEmpty && allTerminated) break;

    // Safety: don't spin forever if something is stuck.
    if (Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
      logger.warn('drain.timeout', {
        elapsed: Date.now() - drainStart,
        liveJourneyCount: liveJourneys.size,
        pendingReplacements: replacementPromises.length,
        unterminated: Array.from(liveJourneys.entries())
          .filter(([, j]) => !j.terminationReason)
          .map(([id]) => id),
      });
      break;
    }

    await new Promise((r) => setTimeout(r, 2_000));
  }

  stopRebalancer();
  if (rateLimiter) rateLimiter.stop();
  clearTimeout(outerDeadlineHandle);
  // Signal the supervisor to stop now that all agents are done.
  if (!runAbortController.signal.aborted) runAbortController.abort();
  const supervisorResult = await Promise.race([
    supervisorPromise,
    new Promise<undefined>((r) => setTimeout(() => r(undefined), 15_000)),
  ]);
  const supervisorCostUsd =
    supervisorResult && typeof supervisorResult === 'object' && 'costUsd' in supervisorResult
      ? (supervisorResult as { costUsd: number }).costUsd
      : 0;

  // Collect journeys from all agents (initial + slot-filled).
  const journeys: Journey[] = [];
  for (const result of allSettledResults) {
    if (result.status === 'fulfilled') {
      journeys.push(result.value.journey);
    } else {
      journeys.push({
        runId,
        agentId: 'unknown',
        startedAt: runStartedAt,
        endedAt: new Date().toISOString(),
        startUrl: cfg.target.url,
        turns: 0,
        findings: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        terminationReason: 'error',
      });
    }
  }

  return { journeys, supervisorCostUsd, selectorCache, agentPhaseStarted };
}
