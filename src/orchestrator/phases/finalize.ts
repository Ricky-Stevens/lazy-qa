/**
 * Finalize phase — aggregate findings, persist artefacts, coverage report,
 * post-run review, budget warning.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireSession } from '../../auth/session-pool.ts';
import type { Config } from '../../config/types.ts';
import type { SiteMapImpl } from '../../crawler/sitemap.ts';
import { type PlaybookOutcomeRecord, writeCoverageReport } from '../../findings/coverage.ts';
import { dedupeFindings } from '../../findings/evaluate.ts';
import {
  persistFindings,
  type RunManifest,
  writeRunManifest,
  writeSummaryMarkdown,
} from '../../findings/persist.ts';
import { writeReviewArtefacts } from '../../findings/report.ts';
import { reviewRun } from '../../findings/review.ts';
import type { LlmBackend } from '../../llm/backend.ts';
import type { Logger } from '../../logging/logger.ts';
import type { ResolvedAgent } from '../../types/agent.ts';
import type { Finding } from '../../types/finding.ts';
import type { Journey } from '../../types/journey.ts';
import type { ApplicationModel } from '../app-model.ts';
import type { EventWriter } from '../events.ts';
import { collectEventStats } from '../events.ts';

export interface FinalizeInput {
  runId: string;
  runDir: string;
  cfg: Config;
  backend: LlmBackend;
  siteMap: SiteMapImpl;
  agents: ResolvedAgent[];
  journeys: Journey[];
  authCostUsd: number;
  supervisorCostUsd: number;
  appModelCostUsd: number;
  appModel: ApplicationModel | undefined;
  logger: Logger;
  events: EventWriter;
}

export interface FinalizeResult {
  findings: Finding[];
  totalCostUsd: number;
  reviewClassifications: Array<{
    title: string;
    route?: string;
    classification: string;
    reasoning: string;
  }>;
  terminationReasons: Record<string, string>;
}

export async function finalizeRun(input: FinalizeInput): Promise<FinalizeResult> {
  const {
    runId,
    runDir,
    cfg,
    backend,
    siteMap,
    agents,
    journeys,
    authCostUsd,
    supervisorCostUsd,
    appModelCostUsd,
    appModel,
    logger,
    events,
  } = input;

  // Aggregate findings.
  const allFindings = dedupeFindings(journeys.flatMap((j) => j.findings));

  // Persist run manifest, findings, summary.
  const runStartedAt = journeys[0]?.startedAt ?? new Date().toISOString();
  const runEndedAt = new Date().toISOString();
  let totalCostUsd =
    journeys.reduce((sum, j) => sum + j.costUsd, 0) +
    authCostUsd +
    supervisorCostUsd +
    appModelCostUsd;

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
  // Write the final sitemap (includes agent-discovered routes).
  await writeFile(
    path.join(runDir, 'sitemap-final.json'),
    JSON.stringify(siteMap.serialize(), null, 2),
    'utf8',
  );

  // Coverage report.
  const eventsPath = path.join(runDir, 'events.jsonl');
  try {
    const { playbookOutcomes, primitiveActivity } = await collectEventStats(eventsPath);
    await writeCoverageReport(runDir, {
      runId,
      siteMap: siteMap.serialize(),
      journeys,
      playbookOutcomes,
      primitiveActivity,
    });
  } catch (err) {
    logger.warn('coverage.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Post-run reviewer.
  let reviewClassifications: Array<{
    title: string;
    route?: string;
    classification: string;
    reasoning: string;
  }> = [];
  const reviewEnabled = cfg.review.enabled && allFindings.length > 0;
  let reviewSummary: {
    confirmedBug: number;
    likelyBug: number;
    duplicate: number;
    environmental: number;
    notABug: number;
    themes: number;
    reviewCostUsd: number;
    verifyCostUsd: number;
  } | null = null;

  if (reviewEnabled) {
    let verifySession: Awaited<ReturnType<typeof acquireSession>> | null = null;
    if (cfg.review.verify_with_browser) {
      try {
        const firstResolved = agents[0];
        if (firstResolved) {
          verifySession = await acquireSession({
            targetUrl: cfg.target.url,
            auth: cfg.target.auth,
            allowedHosts: cfg.target.allowed_hosts,
            credentials: firstResolved.credentials,
            runDir,
            agentId: 'verifier',
            logger: logger.child({ tool: 'verify' }),
            stealth: cfg.target.stealth,
          });
        }
      } catch (err) {
        logger.warn('verify.session.acquire.failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      const review = await reviewRun({
        runDir,
        backend,
        model: cfg.review.model,
        batchMode: cfg.review.batch_mode,
        logger: logger.child({ tool: 'review' }),
        events,
        appModel,
        ...(verifySession
          ? {
              verify: {
                context: verifySession.context,
                rootUrl: cfg.target.url,
                allowedHosts: cfg.target.allowed_hosts,
                model: cfg.review.verify_model ?? cfg.review.model,
                concurrency: cfg.review.verify_concurrency,
                verifyOnlyUncertain: cfg.review.verify_only_uncertain,
              },
            }
          : {}),
      });
      await writeReviewArtefacts(runDir, review);
      reviewClassifications = review.reviews.map(({ finding, review: r }) => ({
        title: finding.title,
        route: finding.route,
        classification: r.classification,
        reasoning: r.reasoning,
      }));
      reviewSummary = {
        confirmedBug: review.counts.confirmed_bug,
        likelyBug: review.counts.likely_bug,
        duplicate: review.counts.duplicate,
        environmental: review.counts.environmental,
        notABug: review.counts.not_a_bug,
        themes: review.clusters.length,
        reviewCostUsd: review.reviewCostUsd,
        verifyCostUsd: review.verifyCostUsd,
      };
    } catch (err) {
      logger.error('review.crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (verifySession) {
        try {
          await verifySession.release();
        } catch (err) {
          logger.warn('verify.session.release.failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // Add review + verify cost to the total BEFORE the budget check.
  const reviewCost = reviewSummary?.reviewCostUsd ?? 0;
  const verifyCost = reviewSummary?.verifyCostUsd ?? 0;
  totalCostUsd = totalCostUsd + reviewCost + verifyCost;

  if (totalCostUsd > cfg.run.max_budget_usd) {
    logger.warn('run.budget.exceeded', {
      totalCostUsd: totalCostUsd.toFixed(4),
      maxBudgetUsd: cfg.run.max_budget_usd,
      message:
        'Run exceeded the configured max_budget_usd. Consider reducing agent budgets or agent count.',
    });
  }

  // Re-write the manifest with the final cost that includes review + verify.
  const finalManifest: RunManifest = {
    ...manifest,
    totalCostUsd,
  };
  await writeRunManifest(runDir, finalManifest);

  // Post-run webhook — send confirmed findings to external bug tracker.
  if (cfg.run.webhook_url) {
    try {
      const { sendFindingsWebhook } = await import('../webhook.ts');
      await sendFindingsWebhook({
        findings: allFindings,
        classifications: reviewClassifications,
        webhook: {
          url: cfg.run.webhook_url,
          minSeverity: cfg.run.webhook_min_severity,
          headers: cfg.run.webhook_headers,
        },
        runId,
        targetUrl: cfg.target.url,
        logger,
      });
    } catch (err) {
      logger.warn('webhook.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    findings: allFindings,
    totalCostUsd,
    reviewClassifications,
    terminationReasons,
  };
}
