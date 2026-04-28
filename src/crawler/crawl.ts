/**
 * Pre-run BFS crawler. Walks the link graph from `rootUrl` to a bounded
 * depth, parsing a PageModel for each route and storing it in the shared
 * SiteMap. Pure read-only — never clicks buttons, submits forms, or
 * mutates application state. The crawler is the deterministic "where can I
 * go" reference; agents are responsible for everything behind interactions.
 */

import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import { parsePage } from '../page-model/parser.ts';
import { extractLinks } from './extract-links.ts';
import { buildRouteEntry, SiteMapImpl } from './sitemap.ts';
import type { CrawlOptions, RouteEntry, SiteMap } from './types.ts';

/** Default per-navigation timeout; conservatively short so crawl wall-clock
 * is dominated by parse time, not waiting on slow routes. */
const NAV_TIMEOUT_MS = 15_000;

/** Time to wait for SPA hydration after `domcontentloaded`. Capped so a page
 * with a long-poll/SSE connection that never goes networkidle still completes. */
const HYDRATION_WAIT_MS = 3_000;

/** After `domcontentloaded`, give the SPA a chance to render its nav. We try
 * `networkidle` first (most reliable signal hydration is done) and fall back
 * to a short fixed wait. Either way the crawler proceeds. */
async function waitForHydration(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: HYDRATION_WAIT_MS });
  } catch {
    // Networkidle never settled — the app probably has a persistent
    // connection. Fall back to a fixed wait so React/Vue/etc. has time to
    // mount the nav before we extract links.
    await page.waitForTimeout(800);
  }
}

/** Derive `origin + pathname` (no query/fragment) from a URL. Returns the
 * raw string on parse failure so misformed URLs don't crash the crawler. */
function deriveRoute(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

/** Returns the host of a URL or undefined for malformed input. */
function hostOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).host;
  } catch {
    return undefined;
  }
}

/** True if `url`'s host matches one of the allowedHosts. We support exact
 * host match plus port-stripped match (so `localhost:3001` is allowed by
 * `localhost`).
 *
 * TODO(phase-3-followup): reconcile with isHostAllowed in safety/guards.ts —
 * current semantics (port-stripped, no subdomains) differ from isHostAllowed
 * (subdomains allowed, no port handling). Dedup only after resolving which
 * policy is correct for crawl-time host validation.
 */
function isAllowedHost(url: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  const host = hostOf(url);
  if (!host) return false;
  const hostNoPort = host.split(':')[0] ?? host;
  for (const allowed of allowedHosts) {
    if (host === allowed) return true;
    if (hostNoPort === allowed) return true;
    const allowedNoPort = allowed.split(':')[0] ?? allowed;
    if (allowedNoPort === hostNoPort) return true;
  }
  return false;
}

/** True if `url` is same-origin as `rootUrl`. */
function isSameOrigin(url: string, rootUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(rootUrl).origin;
  } catch {
    return false;
  }
}

interface QueueItem {
  url: string;
  depth: number;
}

interface ProcessRouteContext {
  rootUrl: string;
  siteMap: SiteMapImpl;
  queue: QueueItem[];
  seen: Set<string>;
  opts: CrawlOptions;
}

/**
 * Process a single route on the supplied tab: navigate, parse the PageModel,
 * upsert into the sitemap, and append any newly-discovered links to the
 * shared queue. The tab is reused across routes when called serially; in the
 * parallel path each worker owns its own tab. Per-route nav/parse errors are
 * logged and recorded as a stub so the rest of the crawl continues.
 *
 * Returns true if a route was visited (visitedCount should bump), false if
 * skipped (host filter, parse failure, etc. — caller decides accounting).
 */
async function processRoute(
  tab: Page,
  item: QueueItem,
  ctx: ProcessRouteContext,
): Promise<boolean> {
  const { rootUrl, siteMap, queue, seen, opts } = ctx;
  const { events } = opts;
  const route = deriveRoute(item.url);
  if (!isSameOrigin(item.url, rootUrl)) return false;
  if (!isAllowedHost(item.url, opts.allowedHosts)) return false;

  const probeId = randomUUID();
  const probeStart = Date.now();
  await events?.write({
    type: 'crawl.probe.submit',
    probeId,
    route,
    kind: 'http',
  });

  let status: number | undefined;
  let navError: string | undefined;
  try {
    const response = await tab.goto(item.url, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    status = response?.status();
    await waitForHydration(tab);
  } catch (err) {
    navError = err instanceof Error ? err.message : String(err);
    opts.logger.debug('crawl.navError', { url: item.url, error: navError });
  }

  await events?.write({
    type: 'crawl.probe.result',
    probeId,
    status: status ?? null,
    ok: !navError && (status === undefined || status < 400),
    durationMs: Date.now() - probeStart,
  });

  if (navError) {
    const stub = buildRouteEntry({
      url: item.url,
      route,
      title: '',
      formIds: [],
      tableIds: [],
      modalIds: [],
      wizardIds: [],
      source: 'crawler',
      visited: false,
    });
    const stubModel = {
      url: item.url,
      route,
      title: '',
      forms: [],
      tables: [],
      modals: [],
      wizards: [],
      toolbars: [],
      navLinks: [],
      bareInteractives: [],
      discovered: [],
      network: [],
      console: [],
      textHash: '',
      looksBroken: true,
      interactiveCount: 0,
      capturedAt: new Date().toISOString(),
    };
    siteMap.upsertRoute(stub, stubModel);
    return true;
  }

  let model: Awaited<ReturnType<typeof parsePage>>;
  try {
    model = await parsePage(tab);
  } catch (err) {
    opts.logger.debug('crawl.parseError', {
      url: item.url,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  const entry: RouteEntry = buildRouteEntry({
    url: model.url || item.url,
    route: model.route || route,
    title: model.title,
    ...(status !== undefined ? { status } : {}),
    formIds: model.forms.map((f) => f.id),
    tableIds: model.tables.map((t) => t.id),
    modalIds: model.modals.map((m) => m.id),
    wizardIds: model.wizards.map((w) => w.id),
    source: 'crawler',
    visited: false,
  });
  siteMap.upsertRoute(entry, model);

  if (item.depth >= opts.maxDepth) return true;

  let links: string[] = [];
  try {
    links = await (opts.linkExtractor ?? extractLinks)(tab);
  } catch (err) {
    opts.logger.debug('crawl.extractError', {
      url: item.url,
      error: err instanceof Error ? err.message : String(err),
    });
    links = [];
  }

  for (const link of links) {
    if (!isSameOrigin(link, rootUrl)) continue;
    if (!isAllowedHost(link, opts.allowedHosts)) continue;
    const linkRoute = deriveRoute(link);
    if (seen.has(linkRoute)) continue;
    queue.push({ url: link, depth: item.depth + 1 });
  }
  return true;
}

/**
 * Crawl from `rootUrl` outward, parsing each visited route's PageModel and
 * recording it in the returned SiteMap. Stops on any of:
 *   - queue empty
 *   - visited count >= maxRoutes
 *   - wall-clock exceeded maxWallClockMs
 *   - depth would exceed maxDepth (links beyond depth aren't enqueued)
 *
 * The crawler swallows per-route navigation errors and stores a stub entry
 * so callers can see *what* failed without aborting the whole crawl.
 *
 * Concurrency: with `parallelism === 1` (default) the crawler reuses the
 * input `page` across routes — preserves any `page.route()` test mocks.
 * With `parallelism > 1` it opens up to N tabs from the page's
 * BrowserContext, which inherit only `context.route()` handlers.
 */
export async function crawlSite(page: Page, opts: CrawlOptions): Promise<SiteMap> {
  const startedAt = Date.now();
  const rootUrl = page.url();
  const siteMap = new SiteMapImpl({ rootUrl });
  const seen = new Set<string>();
  const queue: QueueItem[] = [{ url: rootUrl, depth: 0 }];
  const parallelism = Math.max(1, Math.floor(opts.parallelism ?? 1));

  opts.logger.debug('crawl.start', {
    rootUrl,
    maxDepth: opts.maxDepth,
    maxRoutes: opts.maxRoutes,
    parallelism,
  });

  const ctx: ProcessRouteContext = { rootUrl, siteMap, queue, seen, opts };
  let visitedCount = 0;
  const halt = (): boolean => {
    if (visitedCount >= opts.maxRoutes) {
      opts.logger.debug('crawl.maxRoutesReached', { maxRoutes: opts.maxRoutes });
      return true;
    }
    if (Date.now() - startedAt > opts.maxWallClockMs) {
      opts.logger.debug('crawl.wallClockExceeded', { elapsedMs: Date.now() - startedAt });
      return true;
    }
    return false;
  };

  if (parallelism === 1) {
    while (queue.length > 0) {
      if (halt()) break;
      const next = queue.shift();
      if (!next) break;
      const route = deriveRoute(next.url);
      if (seen.has(route)) continue;
      seen.add(route);
      const visited = await processRoute(page, next, ctx);
      if (visited) visitedCount += 1;
    }
  } else {
    const context: BrowserContext = page.context();
    const inFlight = new Set<Promise<void>>();
    let aborted = false;

    const runOne = async (item: QueueItem): Promise<void> => {
      const tab = await context.newPage();
      try {
        const visited = await processRoute(tab, item, ctx);
        if (visited) visitedCount += 1;
      } finally {
        try {
          await tab.close();
        } catch {
          // tab may already be closed if context tore down — ignore.
        }
      }
    };

    while ((queue.length > 0 || inFlight.size > 0) && !aborted) {
      while (queue.length > 0 && inFlight.size < parallelism) {
        if (halt()) {
          aborted = true;
          break;
        }
        const item = queue.shift();
        if (!item) break;
        const route = deriveRoute(item.url);
        if (seen.has(route)) continue;
        seen.add(route);
        const promise = runOne(item).then(
          () => {
            inFlight.delete(promise);
          },
          (err) => {
            inFlight.delete(promise);
            opts.logger.debug('crawl.workerError', {
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
        inFlight.add(promise);
      }
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    }
    // Drain any still-running workers after abort, so we don't leak tabs.
    if (aborted && inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }
  }

  const final = siteMap.serialize();
  const crawlDurationMs = Date.now() - startedAt;
  opts.logger.info('crawl.done', {
    routes: Object.keys(final.routes).length,
    elapsedMs: crawlDurationMs,
  });

  await opts.events?.write({
    type: 'crawl.complete',
    routeCount: Object.keys(final.routes).length,
    durationMs: crawlDurationMs,
  });

  return final;
}
