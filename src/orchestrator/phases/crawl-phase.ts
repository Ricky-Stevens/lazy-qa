/**
 * Crawl phase — pre-run BFS crawl + modal/drawer discovery. Produces the
 * SiteMap that agents consume.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireSession } from '../../auth/session-pool.ts';
import type { Config } from '../../config/types.ts';
import { crawlSite } from '../../crawler/crawl.ts';
import { discoverModals } from '../../crawler/discover-modals.ts';
import { SiteMapImpl } from '../../crawler/sitemap.ts';
import type { SiteMap } from '../../crawler/types.ts';
import type { Logger } from '../../logging/logger.ts';
import type { EventWriter } from '../events.ts';

export interface CrawlPhaseResult {
  crawledMap: SiteMap;
  siteMap: SiteMapImpl;
}

export async function runCrawlPhase(
  cfg: Config,
  runDir: string,
  runCredentials: { username: string; password: string } | null,
  logger: Logger,
  events: EventWriter,
): Promise<CrawlPhaseResult> {
  const crawlerLogger = logger.child({ phase: 'crawl' });
  const crawlStartedAt = Date.now();
  const authStatePath = path.join(runDir, 'auth-state.json');

  let crawledMap: SiteMap;
  try {
    crawledMap = await crawlSite({
      rootUrl: cfg.target.url,
      maxRoutes: cfg.crawler.max_routes,
      maxWallClockMs: cfg.crawler.max_wall_clock_s * 1_000,
      allowedHosts: cfg.target.allowed_hosts,
      bannedPathPrefixes: cfg.target.banned_path_prefixes,
      storageStatePath: cfg.target.auth.type === 'form' ? authStatePath : undefined,
      logger: crawlerLogger,
      parallelism: cfg.crawler.parallelism,
      stealth: cfg.target.stealth,
      events,
    });
  } catch (err) {
    crawlerLogger.error('crawl.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    crawledMap = {
      startedAt: new Date(crawlStartedAt).toISOString(),
      rootUrl: cfg.target.url,
      routes: {},
      pageModels: {},
    };
  }

  // Persist the crawler output before agents start.
  await writeFile(
    path.join(runDir, 'sitemap.json'),
    JSON.stringify(crawledMap, null, 2),
    'utf8',
  );

  logger.info('crawl.done', {
    routes: Object.keys(crawledMap.routes).length,
    durationMs: Date.now() - crawlStartedAt,
  });

  // Build the live, mutable accessor agents will share.
  const siteMap = new SiteMapImpl({
    rootUrl: crawledMap.rootUrl,
    startedAt: crawledMap.startedAt,
    allowedHosts: cfg.target.allowed_hosts,
  });
  for (const route of Object.values(crawledMap.routes)) {
    const model = crawledMap.pageModels[route.route];
    if (!model) continue;
    siteMap.upsertRoute(route, model);
  }

  // Post-crawl modal/drawer discovery.
  let modalDiscoverySession: Awaited<ReturnType<typeof acquireSession>> | null = null;
  try {
    modalDiscoverySession = await acquireSession({
      targetUrl: cfg.target.url,
      auth: cfg.target.auth,
      allowedHosts: cfg.target.allowed_hosts,
      credentials: runCredentials,
      runDir,
      agentId: 'modal-discovery',
      logger: logger.child({ phase: 'discover-modals' }),
      stealth: cfg.target.stealth,
    });
    const discoveryResult = await discoverModals({
      sitemap: siteMap,
      page: modalDiscoverySession.page,
      logger: logger.child({ phase: 'discover-modals' }),
    });
    logger.info('discover-modals.done', {
      routesProbed: discoveryResult.routesProbed,
      modalsFound: discoveryResult.modalsFound,
      formsDiscovered: discoveryResult.formsDiscovered,
    });

    // Re-serialize the enriched sitemap.
    const enrichedMap = siteMap.serialize();
    crawledMap = enrichedMap;
    await writeFile(
      path.join(runDir, 'sitemap.json'),
      JSON.stringify(enrichedMap, null, 2),
      'utf8',
    );
  } catch (err) {
    logger.warn('discover-modals.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (modalDiscoverySession) {
      try {
        await modalDiscoverySession.release();
      } catch {
        // Best-effort release.
      }
    }
  }

  return { crawledMap, siteMap };
}
