/**
 * Orchestrator entry point for the regression harness.
 *
 * Orchestrates the full scan lifecycle: config -> safety -> crawler -> agents ->
 * findings review. Each phase is implemented in a dedicated module under
 * `./phases/`. This file is the pipeline that threads results between them.
 */

import { loadConfig, resolveApiKey, resolveTargetCredentials } from '../config/load.ts';
import type { SiteMap } from '../crawler/types.ts';
import type { Logger } from '../logging/logger.ts';
import { selectBackend } from '../llm/factory.ts';
import { loadSkills } from '../skills/loader.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';
import {
  assertAllHostsNonProd,
  assertAllowedTarget,
  assertHostsTrusted,
  assertNonProdHost,
} from '../safety/guards.ts';
import { resolveAgents } from './resolve.ts';

import { runAuthPhase } from './phases/authenticate.ts';
import { cleanupRun } from './phases/cleanup.ts';
import { runCrawlPhase } from './phases/crawl-phase.ts';
import { executeAgents } from './phases/execute.ts';
import { finalizeRun } from './phases/finalize.ts';
import { buildIntelligence } from './phases/intelligence.ts';
import { setupRun } from './phases/setup.ts';

export interface RunOptions {
  configPath: string;
  outputDir?: string;
  logger?: Logger;
}

export interface RunResult {
  runId: string;
  runDir: string;
  journeys: Journey[];
  findings: Finding[];
  totalCostUsd: number;
  siteMap: SiteMap;
}

export async function runScan(opts: RunOptions): Promise<RunResult> {
  // 1. Config + safety guards.
  const cfg = await loadConfig(opts.configPath);
  assertHostsTrusted(cfg.target.allowed_hosts);
  assertAllowedTarget(cfg.target.url, cfg.target.allowed_hosts);
  assertNonProdHost(cfg.target.url);
  assertAllHostsNonProd(cfg.target.allowed_hosts);

  // 2. Resolve auth backend.
  const apiKey = resolveApiKey(cfg);
  const llmAuth = process.env.LLM_AUTH;
  const backend = selectBackend({ apiKey: apiKey ?? undefined, llmAuth });

  // 3. Load skills + resolve agents (manual mode).
  const skillsBundle = await loadSkills();
  const isAutoMode = cfg.agents === 'auto';
  const agents: ResolvedAgent[] = isAutoMode ? [] : await resolveAgents(cfg, skillsBundle);

  if (!isAutoMode && agents.length === 0) {
    throw new Error('runScan: no agents resolved from config');
  }

  // In auto mode, credentials come from target.auth.credentials.
  // In manual mode, use the first agent's credentials.
  const runCredentials = isAutoMode
    ? resolveTargetCredentials(cfg)
    : (agents[0]?.credentials ?? resolveTargetCredentials(cfg));

  // 4. Setup: run ID, directories, events, logger, manifest stub.
  const setup = await setupRun(cfg, opts);
  const { runId, runDir, events, logger, testPlanRef, removeUnhandledRejectionListener } = setup;

  // Re-emit run.start with the resolved agent count now that we know it.
  logger.info('run.start', {
    runId,
    runDir,
    targetUrl: cfg.target.url,
    agentCount: isAutoMode ? 'auto' : agents.length,
    auth: backend.kind === 'sdk' ? 'claude-subscription' : 'anthropic-api-key',
    version: 'v2',
  });

  // Outer-scope accumulators for the finally block.
  let aggregateFindings: Finding[] = [];
  let aggregateCostUsd = 0;
  const aggregateTerminationReasons: Record<string, string> = {};
  let selectorCache: import('../tools/selector-cache.ts').SelectorCache | undefined;
  let appModel: import('./app-model.ts').ApplicationModel | undefined;
  let priorLearning: import('./learning.ts').LearningState | null = null;
  let reviewClassifications: Array<{
    title: string;
    route?: string;
    classification: string;
    reasoning: string;
  }> = [];
  let siteMapForCleanup: import('../crawler/sitemap.ts').SiteMapImpl | undefined;
  let agentPhaseStarted = false;

  // Shared abort controller.
  const runAbortController = new AbortController();
  let shuttingDown = false;
  function handleSignal(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn('run.signal', { signal, message: 'Graceful shutdown initiated' });
    runAbortController.abort();
  }
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    // 5. Authentication.
    const authResult = await runAuthPhase(
      cfg,
      backend,
      runDir,
      runCredentials,
      logger,
      events,
      runAbortController.signal,
    );

    // 6. Crawl + modal discovery.
    const crawlResult = await runCrawlPhase(cfg, runDir, runCredentials, logger, events);
    const { crawledMap, siteMap } = crawlResult;
    siteMapForCleanup = siteMap;

    // 7. Intelligence: learning, site classify, app model, test plan.
    const intel = await buildIntelligence(
      cfg,
      crawledMap,
      siteMap,
      backend,
      skillsBundle,
      runDir,
      logger,
      events,
    );
    testPlanRef.current = intel.testPlan;
    appModel = intel.appModel;
    priorLearning = intel.priorLearning;


    // 8. Execute agents.
    const execResult = await executeAgents({
      runId,
      runDir,
      cfg,
      backend,
      siteMap,
      skillsBundle,
      agents,
      securityQueue: intel.securityQueue,
      qaQueue: intel.qaQueue,
      isAutoMode,
      runCredentials,
      sessionInfo: authResult.sessionInfo,
      sitePlaybook: intel.sitePlaybook,
      appModel: intel.appModel,
      priorLearning: intel.priorLearning,
      routeDiff: intel.routeDiff,
      learningFpPatterns: intel.learningFpPatterns,
      testPlan: intel.testPlan,
      logger,
      events,
      abortController: runAbortController,
    });
    selectorCache = execResult.selectorCache;
    agentPhaseStarted = execResult.agentPhaseStarted;

    // 9. Finalize: aggregate, persist, review.
    const finalResult = await finalizeRun({
      runId,
      runDir,
      cfg,
      backend,
      siteMap,
      agents,
      journeys: execResult.journeys,
      authCostUsd: authResult.authCostUsd,
      supervisorCostUsd: execResult.supervisorCostUsd,
      appModelCostUsd: intel.appModelCostUsd,
      appModel: intel.appModel,
      logger,
      events,
    });

    aggregateFindings = finalResult.findings;
    aggregateCostUsd = finalResult.totalCostUsd;
    reviewClassifications = finalResult.reviewClassifications;
    Object.assign(aggregateTerminationReasons, finalResult.terminationReasons);

    return {
      runId,
      runDir,
      journeys: execResult.journeys,
      findings: finalResult.findings,
      totalCostUsd: finalResult.totalCostUsd,
      siteMap: siteMap.serialize(),
    };
  } finally {
    await cleanupRun({
      runId,
      targetUrl: cfg.target.url,
      events,
      logger,
      aggregateFindings,
      aggregateCostUsd,
      aggregateTerminationReasons,
      selectorCache,
      siteMap: siteMapForCleanup,
      agentPhaseStarted,
      appModel,
      priorLearning,
      reviewClassifications,
      removeUnhandledRejectionListener,
    });
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
