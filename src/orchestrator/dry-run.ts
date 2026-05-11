/**
 * Dry-run mode — loads config, validates, crawls, builds intelligence,
 * estimates cost, and prints a summary without spawning any agents.
 *
 * Useful for verifying config + understanding what a scan will do/cost
 * before committing to it.
 */

import { loadConfig, resolveApiKey, resolveTargetCredentials } from '../config/load.ts';
import { crawlSite } from '../crawler/crawl.ts';
import { SiteMapImpl } from '../crawler/sitemap.ts';
import type { SiteMap } from '../crawler/types.ts';
import { selectBackend } from '../llm/factory.ts';
import { createLogger } from '../logging/logger.ts';
import {
  assertAllHostsNonProd,
  assertAllowedTarget,
  assertHostsTrusted,
  assertNonProdHost,
} from '../safety/guards.ts';
import { loadSkills } from '../skills/loader.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import { buildApplicationModel } from './app-model.ts';
import { MODEL_PRICING } from './cost.ts';
import { buildAgentQueues, resolveAgents } from './resolve.ts';
import { classifySite } from './site-playbook.ts';
import { generateTestPlan } from './test-plan.ts';

export interface DryRunResult {
  targetUrl: string;
  routeCount: number;
  agents: Array<{ id: string; profile: string; model: string; budgetUsd: number }>;
  testPlanItems: number;
  estimatedCostUsd: { low: number; mid: number; high: number };
  siteShape: string;
  siteSummary: string;
}

export async function dryRun(configPath: string): Promise<DryRunResult> {
  const cfg = await loadConfig(configPath);
  assertHostsTrusted(cfg.target.allowed_hosts);
  assertAllowedTarget(cfg.target.url, cfg.target.allowed_hosts);
  assertNonProdHost(cfg.target.url);
  assertAllHostsNonProd(cfg.target.allowed_hosts);

  const apiKey = resolveApiKey(cfg);
  const llmAuth = process.env.LLM_AUTH;
  const backend = selectBackend({ apiKey: apiKey ?? undefined, llmAuth });
  const skillsBundle = await loadSkills();
  const logger = createLogger({ runId: 'dry-run' });

  const isAutoMode = cfg.agents === 'auto';
  let agents: ResolvedAgent[] = isAutoMode ? [] : await resolveAgents(cfg, skillsBundle);

  // Crawl (lightweight — no modal discovery in dry-run)
  let crawledMap: SiteMap;
  try {
    crawledMap = await crawlSite({
      rootUrl: cfg.target.url,
      maxRoutes: cfg.crawler.max_routes,
      maxWallClockMs: cfg.crawler.max_wall_clock_s * 1_000,
      allowedHosts: cfg.target.allowed_hosts,
      bannedPathPrefixes: cfg.target.banned_path_prefixes,
      logger: logger.child({ phase: 'crawl' }),
      parallelism: cfg.crawler.parallelism,
      stealth: cfg.target.stealth,
    });
  } catch (err) {
    logger.warn('dry-run.crawl.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    crawledMap = {
      startedAt: new Date().toISOString(),
      rootUrl: cfg.target.url,
      routes: {},
      pageModels: {},
    };
  }

  const routeCount = Object.keys(crawledMap.routes).length;

  // Site classification (heuristic, no LLM)
  const sitePlaybook = classifySite({
    rootUrl: cfg.target.url,
    sitemap: crawledMap,
    logger: logger.child({ phase: 'site-classify' }),
  });

  // App model (one Sonnet call)
  let appModel: Awaited<ReturnType<typeof buildApplicationModel>>['model'] | undefined;
  let appModelCost = 0;
  try {
    const result = await buildApplicationModel({
      sitemap: crawledMap,
      siteShape: sitePlaybook.siteShape,
      siteSummary: sitePlaybook.siteSummary,
      backend,
      model: cfg.supervisor.model ?? 'claude-sonnet-4-6',
      logger: logger.child({ phase: 'app-model' }),
    });
    appModel = result.model;
    appModelCost = result.costUsd;
  } catch (err) {
    logger.warn('dry-run.app-model.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Auto-mode agent resolution
  if (isAutoMode) {
    const queues = buildAgentQueues(cfg, skillsBundle);
    agents = [...queues.securityQueue, ...queues.qaQueue];
  }

  // Build the SiteMapImpl for test plan generation
  const siteMap = new SiteMapImpl({
    rootUrl: crawledMap.rootUrl,
    startedAt: crawledMap.startedAt,
    allowedHosts: cfg.target.allowed_hosts,
  });
  for (const route of Object.values(crawledMap.routes)) {
    const model = crawledMap.pageModels[route.route];
    if (model) siteMap.upsertRoute(route, model);
  }

  // Test plan
  const testPlan = generateTestPlan({
    sitemap: crawledMap,
    appModel,
    personas: skillsBundle.personas,
  });

  // Cost estimation
  const agentSummaries = agents.map((a) => ({
    id: a.id,
    profile: a.profileName,
    model: a.model,
    budgetUsd: a.budget.max_usd,
  }));

  // Estimate cost using average turns and model pricing
  const avgTurnsLow = Math.min(8, Math.ceil(routeCount * 0.5));
  const avgTurnsMid = Math.min(20, routeCount);
  const avgTurnsHigh = Math.min(40, routeCount * 2);

  function estimateCostForTurns(avgTurns: number): number {
    let total = appModelCost;
    for (const agent of agents) {
      const pricing = MODEL_PRICING[agent.model];
      if (!pricing) continue;
      const inputTokensPerTurn = 4000;
      const outputTokensPerTurn = 800;
      const cacheReadPerTurn = 8000;
      const costPerTurn =
        (inputTokensPerTurn * pricing.input) / 1_000_000 +
        (outputTokensPerTurn * pricing.output) / 1_000_000 +
        (cacheReadPerTurn * (pricing.cacheRead ?? pricing.input * 0.1)) / 1_000_000;
      total += costPerTurn * Math.min(avgTurns, agent.budget.max_turns);
    }
    // Add supervisor cost estimate (~5-10 turns of Sonnet)
    const supervisorPricing = MODEL_PRICING[cfg.supervisor.model ?? 'claude-sonnet-4-6'];
    if (supervisorPricing) {
      total += (5000 * supervisorPricing.input + 2000 * supervisorPricing.output) / 1_000_000 * 8;
    }
    // Add review cost estimate
    const reviewPricing = MODEL_PRICING[cfg.review.model ?? 'claude-sonnet-4-6'];
    if (reviewPricing && cfg.review.enabled) {
      const estFindings = agents.length * 2;
      total += (3000 * reviewPricing.input + 1000 * reviewPricing.output) / 1_000_000 * estFindings;
    }
    return total;
  }

  return {
    targetUrl: cfg.target.url,
    routeCount,
    agents: agentSummaries,
    testPlanItems: testPlan.totalItems,
    estimatedCostUsd: {
      low: estimateCostForTurns(avgTurnsLow),
      mid: estimateCostForTurns(avgTurnsMid),
      high: estimateCostForTurns(avgTurnsHigh),
    },
    siteShape: sitePlaybook.siteShape,
    siteSummary: sitePlaybook.siteSummary,
  };
}
