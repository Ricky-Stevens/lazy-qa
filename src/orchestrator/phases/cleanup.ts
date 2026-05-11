/**
 * Cleanup phase — emit run.end event, close event writer, flush selector
 * cache, persist cross-run learning state.
 */

import type { SiteMapImpl } from '../../crawler/sitemap.ts';
import type { Logger } from '../../logging/logger.ts';
import type { Finding } from '../../types/finding.ts';
import type { SelectorCache } from '../../tools/selector-cache.ts';
import type { ApplicationModel } from '../app-model.ts';
import type { EventWriter } from '../events.ts';
import {
  buildRouteSnapshots,
  deduplicateFpPatterns,
  extractFalsePositivePatterns,
  type LearningState,
  saveLearningState,
  updateKnownFindings,
} from '../learning.ts';

export interface CleanupInput {
  runId: string;
  targetUrl: string;
  events: EventWriter;
  logger: Logger;
  aggregateFindings: Finding[];
  aggregateCostUsd: number;
  aggregateTerminationReasons: Record<string, string>;
  selectorCache: SelectorCache | undefined;
  siteMap: SiteMapImpl | undefined;
  agentPhaseStarted: boolean;
  appModel: ApplicationModel | undefined;
  priorLearning: LearningState | null;
  reviewClassifications: Array<{
    title: string;
    route?: string;
    classification: string;
    reasoning: string;
  }>;
  removeUnhandledRejectionListener: () => void;
}

export async function cleanupRun(input: CleanupInput): Promise<void> {
  const {
    events,
    logger,
    aggregateFindings,
    aggregateCostUsd,
    aggregateTerminationReasons,
    selectorCache,
    siteMap,
    agentPhaseStarted,
    appModel,
    priorLearning,
    reviewClassifications,
    removeUnhandledRejectionListener,
    runId,
    targetUrl,
  } = input;

  const learningLogger = logger.child({ phase: 'learning' });

  // Emit run.end and close the writer.
  try {
    await events.write({
      type: 'run.end',
      totalCostUsd: aggregateCostUsd,
      terminationReasons: aggregateTerminationReasons,
      totalFindings: aggregateFindings.length,
    });
    await events.close();
  } catch (err) {
    logger.error('events.close.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  removeUnhandledRejectionListener();

  if (selectorCache) {
    try {
      await selectorCache.close();
    } catch (err) {
      logger.warn('selector-cache.close.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Only persist learning state when the run reached the agent phase AND
  // at least one agent was spawned.
  if (siteMap && agentPhaseStarted) {
    try {
      const updatedLearning: LearningState = {
        targetUrl,
        lastUpdated: new Date().toISOString(),
        appModel,
        knownFindings: updateKnownFindings(
          priorLearning?.knownFindings ?? [],
          aggregateFindings,
          runId,
        ),
        falsePositivePatterns: deduplicateFpPatterns([
          ...(priorLearning?.falsePositivePatterns ?? []),
          ...extractFalsePositivePatterns(reviewClassifications),
        ]),
        routeSnapshots: buildRouteSnapshots(siteMap.serialize()),
      };
      await saveLearningState(targetUrl, updatedLearning, learningLogger);
    } catch (err) {
      learningLogger.warn('learning.save.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
