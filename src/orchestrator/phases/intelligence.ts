/**
 * Intelligence phase — cross-run learning, site classification, application
 * model, test plan generation, and auto-agent queue building.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SiteMap } from '../../crawler/types.ts';
import type { SiteMapImpl } from '../../crawler/sitemap.ts';
import type { Config } from '../../config/types.ts';
import type { LlmBackend } from '../../llm/backend.ts';
import type { Logger } from '../../logging/logger.ts';
import type { SkillsBundle } from '../../skills/loader.ts';
import type { ResolvedAgent } from '../../types/agent.ts';
import type { EventWriter } from '../events.ts';
import type { ApplicationModel } from '../app-model.ts';
import { buildApplicationModel, renderApplicationModelForPrompt } from '../app-model.ts';
import {
  buildRouteSnapshots,
  diffRoutes,
  type LearningState,
  loadLearningState,
  renderLearningContext,
  shouldRegenerateAppModel,
} from '../learning.ts';
import { classifySite, type SitePlaybookResult } from '../site-playbook.ts';
import { generateTestPlan, type TestPlan } from '../test-plan.ts';
import { buildAgentQueues } from '../resolve.ts';

export interface RouteDiff {
  newRoutes: string[];
  removedRoutes: string[];
  changedRoutes: string[];
  unchangedRoutes: string[];
}

export interface IntelligenceResult {
  priorLearning: LearningState | null;
  sitePlaybook: SitePlaybookResult;
  appModel: ApplicationModel | undefined;
  testPlan: TestPlan;
  appModelCostUsd: number;
  routeDiff: RouteDiff;
  learningFpPatterns: LearningState['falsePositivePatterns'];
  /** Auto-mode queues (empty in manual mode). */
  securityQueue: ResolvedAgent[];
  qaQueue: ResolvedAgent[];
}

export async function buildIntelligence(
  cfg: Config,
  crawledMap: SiteMap,
  siteMap: SiteMapImpl,
  backend: LlmBackend,
  skillsBundle: SkillsBundle,
  runDir: string,
  logger: Logger,
  events: EventWriter,
): Promise<IntelligenceResult> {
  const isAutoMode = cfg.agents === 'auto';
  const learningLogger = logger.child({ phase: 'learning' });

  // Cross-run learning — load prior knowledge for this target.
  const priorLearning = await loadLearningState(cfg.target.url, learningLogger);
  const currentRoutes = Object.keys(crawledMap.routes);
  const routeDiff: RouteDiff = priorLearning
    ? diffRoutes(
        currentRoutes,
        priorLearning.routeSnapshots,
        Object.fromEntries(
          Object.entries(crawledMap.pageModels)
            .filter(([, m]) => m?.textHash)
            .map(([route, m]) => [route, m.textHash]),
        ),
      )
    : { newRoutes: currentRoutes, removedRoutes: [], changedRoutes: [], unchangedRoutes: [] };

  if (priorLearning) {
    learningLogger.info('learning.diff', {
      newRoutes: routeDiff.newRoutes.length,
      removedRoutes: routeDiff.removedRoutes.length,
      unchangedRoutes: routeDiff.unchangedRoutes.length,
    });
  }

  const learningFpPatterns = priorLearning?.falsePositivePatterns ?? [];

  // Site classifier — heuristic, no LLM call, instant.
  const sitePlaybook = classifySite({
    rootUrl: cfg.target.url,
    sitemap: crawledMap,
    logger: logger.child({ phase: 'site-classify' }),
    events,
  });
  await writeFile(
    path.join(runDir, 'site-playbook.json'),
    JSON.stringify(sitePlaybook, null, 2),
    'utf8',
  );

  // Application Model.
  let appModel: ApplicationModel | undefined;
  let appModelCostUsd = 0;
  const needsNewAppModel =
    !priorLearning?.appModel || shouldRegenerateAppModel(currentRoutes.length, routeDiff);
  try {
    if (needsNewAppModel) {
      const appModelResult = await buildApplicationModel({
        sitemap: crawledMap,
        siteShape: sitePlaybook.siteShape,
        siteSummary: sitePlaybook.siteSummary,
        backend,
        model: cfg.supervisor.model ?? 'claude-sonnet-4-6',
        logger: logger.child({ phase: 'app-model' }),
      });
      appModel = appModelResult.model;
      appModelCostUsd = appModelResult.costUsd;
    } else {
      appModel = priorLearning!.appModel;
      logger.info('app-model.reused', { reason: 'app unchanged (<30% new routes)' });
    }
    await writeFile(
      path.join(runDir, 'app-model.json'),
      JSON.stringify(appModel, null, 2),
      'utf8',
    );
  } catch (err) {
    logger.warn('app-model.skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Test plan.
  const testPlan: TestPlan = generateTestPlan({
    sitemap: crawledMap,
    appModel,
    personas: skillsBundle.personas,
  });
  await writeFile(
    path.join(runDir, 'test-plan.json'),
    JSON.stringify(testPlan, null, 2),
    'utf8',
  );
  logger.info('test-plan.generated', { items: testPlan.totalItems });

  // Auto mode: build two ordered queues from ALL personas.
  let securityQueue: ResolvedAgent[] = [];
  let qaQueue: ResolvedAgent[] = [];
  if (isAutoMode) {
    const queues = buildAgentQueues(cfg, skillsBundle);
    securityQueue = queues.securityQueue;
    qaQueue = queues.qaQueue;
    logger.info('auto-agents.queued', {
      securityTotal: securityQueue.length,
      qaTotal: qaQueue.length,
      securityOrder: securityQueue.map((a) => {
        const w = skillsBundle.personas.get(a.profileName)?.wave ?? 0;
        return `${a.id}(w${w})`;
      }),
      qaOrder: qaQueue.map((a) => a.id),
    });
  }

  return {
    priorLearning,
    sitePlaybook,
    appModel,
    testPlan,
    appModelCostUsd,
    routeDiff,
    learningFpPatterns,
    securityQueue,
    qaQueue,
  };
}
