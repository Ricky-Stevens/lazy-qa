/**
 * Orchestrator entry point for the regression harness.
 *
 * Orchestrates the full scan lifecycle: config → safety → crawler → agents →
 * findings review. The crawler builds a shared `SiteMap` that every agent
 * consumes via `SiteMapAccessor`. After all agents finish, writes a
 * `coverage.md` aggregating sitemap stats and per-agent playbook outcomes.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireSession } from '../auth/session-pool.ts';
import { loadConfig, resolveApiKey } from '../config/load.ts';
import { crawlSite } from '../crawler/crawl.ts';
import { extractLinks } from '../crawler/extract-links.ts';
import { SiteMapImpl } from '../crawler/sitemap.ts';
import type { SiteMap } from '../crawler/types.ts';
import { writeCoverageReport } from '../findings/coverage.ts';
import { dedupeFindings } from '../findings/evaluate.ts';
import {
  persistFindings,
  type RunManifest,
  writeRunManifest,
  writeSummaryMarkdown,
} from '../findings/persist.ts';
import { writeReviewArtefacts } from '../findings/report.ts';
import { reviewRun } from '../findings/review.ts';
import type { Logger } from '../logging/logger.ts';
import { createLogger } from '../logging/logger.ts';
import { assertAllowedTarget, assertHostsTrusted, assertNonProdHost } from '../safety/guards.ts';
import type { Finding } from '../types/finding.ts';
import type { Journey } from '../types/journey.ts';
import { resolveMemoryPath } from './memory.ts';
import { resolveAgents } from './resolve.ts';
import { spawnAgent } from './spawn-agent.ts';
import { runSupervisor } from './supervisor.ts';

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

/** Crawler defaults. Mirrors spec §7.1 — the user can override via plugin
 *  configuration once `regress.config.ts` lands. */
const CRAWL_MAX_DEPTH = 2;
const CRAWL_MAX_ROUTES = 60;
const CRAWL_MAX_WALL_CLOCK_MS = 30_000;

export async function runScan(opts: RunOptions): Promise<RunResult> {
  // 1. Config + safety guards. Order matters: trusted-hosts first, then
  // target ∈ allowed_hosts, then a positive non-prod check. Any failure
  // aborts before we touch creds.
  const cfg = await loadConfig(opts.configPath);
  assertHostsTrusted(cfg.target.allowed_hosts);
  assertAllowedTarget(cfg.target.url, cfg.target.allowed_hosts);
  assertNonProdHost(cfg.target.url);

  // 2. Resolve API key + agents. Direct-API loop requires a real API key (see
  // spawn-agent docstring); subscription auth is unsupported.
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    throw new Error(
      'runScan requires ANTHROPIC_API_KEY. The direct-API loop does not support subscription auth via the `claude` CLI. Set ANTHROPIC_API_KEY in your environment.',
    );
  }
  const agents = await resolveAgents(cfg);

  // 3. Run ID + output directory.
  const runId = randomUUID();
  const outputDir = opts.outputDir ?? cfg.run.output_dir;
  const runDir = path.resolve(outputDir, runId);
  await mkdir(runDir, { recursive: true });

  // 4. Best-effort `last` symlink so `runs/last` always points at the most
  // recent run for ad-hoc inspection.
  try {
    const lastLink = path.resolve(outputDir, 'last');
    await unlink(lastLink).catch(() => undefined);
    await symlink(runId, lastLink);
  } catch {
    // Some filesystems (FAT, certain Windows paths) don't support symlinks —
    // silently degrade.
  }

  // 5. Logger.
  const logger = opts.logger ?? createLogger({ runId });

  // 6. Early pre-run manifest stub — useful when the run crashes before
  // completing.
  await writeRunManifest(runDir, {
    runId,
    startedAt: new Date().toISOString(),
    endedAt: '',
    targetUrl: cfg.target.url,
    agentIds: agents.map((a) => a.id),
    totalCostUsd: 0,
    totalFindings: 0,
    terminationReasons: {},
  });

  logger.info('run.start', {
    runId,
    runDir,
    targetUrl: cfg.target.url,
    agentCount: agents.length,
    auth: 'anthropic-api-key',
    version: 'v2',
  });

  // 7. Shared abort controller — SIGINT/SIGTERM aborts every agent + the
  // supervisor + the in-flight crawler at once.
  const runAbortController = new AbortController();
  let shuttingDown = false;
  function handleSignal(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn('run.signal', { signal, message: 'Graceful shutdown initiated' });
    runAbortController.abort();
  }
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  // 8. Pre-run crawl. Open a temporary tab on the shared session — first
  // call here triggers login, every subsequent agent's acquireSession()
  // shares the same authed context. Persist the sitemap to disk before
  // spawning agents so the run is debuggable from the moment crawling
  // finishes.
  const firstAgent = agents[0];
  if (!firstAgent) {
    throw new Error('runScan: no agents resolved from config');
  }

  const crawlerLogger = logger.child({ phase: 'crawl' });
  let siteMap: SiteMapImpl;
  let crawledMap: SiteMap;
  const crawlStartedAt = Date.now();
  let crawlerSession: Awaited<ReturnType<typeof acquireSession>> | null = null;
  try {
    crawlerSession = await acquireSession({
      targetUrl: cfg.target.url,
      auth: cfg.target.auth,
      allowedHosts: cfg.target.allowed_hosts,
      credentials: firstAgent.credentials,
      runDir,
      agentId: 'crawler',
      logger: crawlerLogger,
      stealth: cfg.target.stealth,
    });
    crawledMap = await crawlSite(crawlerSession.page, {
      maxDepth: CRAWL_MAX_DEPTH,
      maxRoutes: CRAWL_MAX_ROUTES,
      maxWallClockMs: CRAWL_MAX_WALL_CLOCK_MS,
      allowedHosts: cfg.target.allowed_hosts,
      linkExtractor: extractLinks,
      logger: crawlerLogger,
    });
  } catch (err) {
    crawlerLogger.error('crawl.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Build an empty sitemap so agents still run; coverage will show 0
    // crawler-discovered routes, which is itself a useful signal.
    crawledMap = {
      startedAt: new Date(crawlStartedAt).toISOString(),
      rootUrl: cfg.target.url,
      routes: {},
      pageModels: {},
    };
  } finally {
    if (crawlerSession) {
      await crawlerSession.release().catch((closeErr) => {
        crawlerLogger.warn('crawl.session.release.failed', {
          error: closeErr instanceof Error ? closeErr.message : String(closeErr),
        });
      });
    }
  }

  // Persist the crawler output before agents start. Agents will mutate the
  // live in-memory map (recordVisit / recordPlaybookOutcome / on-demand
  // expansion), but having the pristine pre-run snapshot on disk means we
  // can diff after the run to see what agents discovered.
  await writeFile(path.join(runDir, 'sitemap.json'), JSON.stringify(crawledMap, null, 2), 'utf8');

  logger.info('crawl.done', {
    routes: Object.keys(crawledMap.routes).length,
    durationMs: Date.now() - crawlStartedAt,
  });

  // Build the live, mutable accessor agents will share. Hydrate it from the
  // pristine crawler output.
  siteMap = new SiteMapImpl({
    rootUrl: crawledMap.rootUrl,
    startedAt: crawledMap.startedAt,
  });
  for (const route of Object.values(crawledMap.routes)) {
    const model = crawledMap.pageModels[route.route];
    if (!model) continue;
    siteMap.upsertRoute(route, model);
  }

  // 9. Resolve and initialise the per-target memory directory. Created once
  // before any agents spawn so concurrent agents share the same path.
  const memoryEnabled = cfg.memory.enabled;
  const memoryPath = resolveMemoryPath(cfg.target.url, cfg.memory.path);
  if (memoryEnabled) {
    await mkdir(memoryPath, { recursive: true });
  }

  // 10. Launch agents in parallel. The supervisor runs concurrently and
  // finishes when every agent terminates.
  const runStartedAt = new Date().toISOString();

  const supervisorEnabled = cfg.supervisor.enabled;
  const explorerPromises = agents.map((agent) =>
    spawnAgent({
      runId,
      runDir,
      targetUrl: cfg.target.url,
      allowedHosts: cfg.target.allowed_hosts,
      auth: cfg.target.auth,
      agent,
      apiKey,
      siteMap,
      logger,
      abortSignal: runAbortController.signal,
      stealth: cfg.target.stealth,
      memoryEnabled,
      memoryPath,
    }),
  );

  const supervisorPromise = supervisorEnabled
    ? runSupervisor({
        apiKey,
        model: cfg.supervisor.model,
        maxMinutes: cfg.supervisor.max_minutes,
        maxUsd: cfg.supervisor.max_usd,
        maxTurns: cfg.supervisor.max_turns,
        abortSignal: runAbortController.signal,
        logger: logger.child({ agentId: 'supervisor' }),
      }).catch((err) => {
        // Supervisor is best-effort — never fail the run if it errors.
        logger.error('supervisor.crashed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
    : Promise.resolve(null);

  const [explorerResults] = await Promise.all([
    Promise.allSettled(explorerPromises),
    supervisorPromise,
  ]);

  // 10. Collect journeys; build placeholders for rejected agents so the
  // manifest is always complete.
  const journeys: Journey[] = [];
  for (const [i, result] of explorerResults.entries()) {
    const agent = agents[i];
    if (!agent) continue;
    if (result.status === 'fulfilled') {
      journeys.push(result.value.journey);
    } else {
      logger.error('agent.rejected', {
        agentId: agent.id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      journeys.push({
        runId,
        agentId: agent.id,
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

  // 11. Aggregate findings.
  const allFindings = dedupeFindings(journeys.flatMap((j) => j.findings));

  // 12. Persist run manifest, findings, summary.
  const runEndedAt = new Date().toISOString();
  const totalCostUsd = journeys.reduce((sum, j) => sum + j.costUsd, 0);
  const terminationReasons: Record<string, string> = {};
  for (const j of journeys) {
    terminationReasons[j.agentId] = j.terminationReason ?? 'unknown';
  }

  const manifest: RunManifest = {
    runId,
    startedAt: runStartedAt,
    endedAt: runEndedAt,
    targetUrl: cfg.target.url,
    agentIds: agents.map((a) => a.id),
    totalCostUsd,
    totalFindings: allFindings.length,
    terminationReasons,
  };

  await persistFindings(runDir, allFindings);
  await writeRunManifest(runDir, manifest);
  await writeSummaryMarkdown(runDir, journeys, allFindings);

  // 13. Coverage report. The playbookOutcomes array is empty for now —
  // wiring per-agent outcome jsonl is owned by WP15. Once that lands, the run
  // will read `runs/<runId>/playbooks/<agentId>.jsonl` and pass them in.
  try {
    await writeCoverageReport(runDir, {
      runId,
      siteMap: siteMap.serialize(),
      journeys,
      playbookOutcomes: [],
    });
  } catch (err) {
    logger.error('coverage.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 14. Post-run reviewer. Re-reads the artefacts we just wrote and produces
  // review.md / review.json. Best-effort — a reviewer crash never fails the
  // run; the raw findings are already on disk for manual triage.
  const reviewEnabled = cfg.review.enabled && allFindings.length > 0;
  let reviewSummary: {
    confirmedBug: number;
    likelyBug: number;
    duplicate: number;
    environmental: number;
    notABug: number;
    themes: number;
    reviewCostUsd: number;
  } | null = null;
  if (reviewEnabled) {
    try {
      const review = await reviewRun({
        runDir,
        apiKey,
        model: cfg.review.model,
        batchMode: cfg.review.batch_mode,
        logger: logger.child({ tool: 'review' }),
      });
      await writeReviewArtefacts(runDir, review);
      reviewSummary = {
        confirmedBug: review.counts.confirmed_bug,
        likelyBug: review.counts.likely_bug,
        duplicate: review.counts.duplicate,
        environmental: review.counts.environmental,
        notABug: review.counts.not_a_bug,
        themes: review.clusters.length,
        reviewCostUsd: review.reviewCostUsd,
      };
    } catch (err) {
      logger.error('review.crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 15. Run-level budget warning (informational only — can't enforce mid-run).
  if (totalCostUsd > cfg.run.max_budget_usd) {
    logger.warn('run.budget.exceeded', {
      totalCostUsd: totalCostUsd.toFixed(4),
      maxBudgetUsd: cfg.run.max_budget_usd,
      message:
        'Run exceeded the configured max_budget_usd. Consider reducing agent budgets or agent count.',
    });
  }

  logger.info('run.complete', {
    runId,
    runDir,
    totalFindings: allFindings.length,
    totalCostUsd: totalCostUsd.toFixed(4),
    agentCount: journeys.length,
    review: reviewSummary,
  });

  return {
    runId,
    runDir,
    journeys,
    findings: allFindings,
    totalCostUsd,
    siteMap: siteMap.serialize(),
  };
}
