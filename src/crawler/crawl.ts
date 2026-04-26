/**
 * Pre-run BFS crawler. Walks the link graph from `rootUrl` to a bounded
 * depth, parsing a PageModel for each route and storing it in the shared
 * SiteMap. Pure read-only — never clicks buttons, submits forms, or
 * mutates application state. The crawler is the deterministic "where can I
 * go" reference; agents are responsible for everything behind interactions.
 */

import type { Page } from 'playwright';
import { parsePage } from '../page-model/parser.ts';
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
 * `localhost`). */
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
 */
export async function crawlSite(page: Page, opts: CrawlOptions): Promise<SiteMap> {
  const startedAt = Date.now();
  // The root URL comes from page.url() — agents call crawlSite after auth /
  // navigating to the target's start page, so the page is already on the
  // root route.
  const rootUrl = page.url();
  const siteMap = new SiteMapImpl({ rootUrl });
  const seen = new Set<string>();
  const queue: QueueItem[] = [{ url: rootUrl, depth: 0 }];

  opts.logger.debug('crawl.start', { rootUrl, maxDepth: opts.maxDepth, maxRoutes: opts.maxRoutes });

  let visitedCount = 0;
  while (queue.length > 0) {
    if (visitedCount >= opts.maxRoutes) {
      opts.logger.debug('crawl.maxRoutesReached', { maxRoutes: opts.maxRoutes });
      break;
    }
    if (Date.now() - startedAt > opts.maxWallClockMs) {
      opts.logger.debug('crawl.wallClockExceeded', { elapsedMs: Date.now() - startedAt });
      break;
    }

    const next = queue.shift();
    if (!next) break;
    const route = deriveRoute(next.url);
    if (seen.has(route)) continue;
    seen.add(route);

    if (!isSameOrigin(next.url, rootUrl)) continue;
    if (!isAllowedHost(next.url, opts.allowedHosts)) continue;

    let status: number | undefined;
    let navError: string | undefined;
    try {
      const response = await page.goto(next.url, {
        timeout: NAV_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });
      status = response?.status();
      // SPAs render nav after hydration. Without this wait the link
      // extractor finds zero anchors on Next.js / React-router apps.
      await waitForHydration(page);
    } catch (err) {
      navError = err instanceof Error ? err.message : String(err);
      opts.logger.debug('crawl.navError', { url: next.url, error: navError });
    }

    if (navError) {
      const stub = buildRouteEntry({
        url: next.url,
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
        url: next.url,
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
      visitedCount += 1;
      continue;
    }

    let model: Awaited<ReturnType<typeof parsePage>>;
    try {
      model = await parsePage(page);
    } catch (err) {
      opts.logger.debug('crawl.parseError', {
        url: next.url,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const entry: RouteEntry = buildRouteEntry({
      url: model.url || next.url,
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
    visitedCount += 1;

    if (next.depth >= opts.maxDepth) continue;

    let links: string[] = [];
    try {
      links = await opts.linkExtractor.extract(page);
    } catch (err) {
      opts.logger.debug('crawl.extractError', {
        url: next.url,
        error: err instanceof Error ? err.message : String(err),
      });
      links = [];
    }

    for (const link of links) {
      if (!isSameOrigin(link, rootUrl)) continue;
      if (!isAllowedHost(link, opts.allowedHosts)) continue;
      const linkRoute = deriveRoute(link);
      if (seen.has(linkRoute)) continue;
      queue.push({ url: link, depth: next.depth + 1 });
    }
  }

  const final = siteMap.serialize();
  opts.logger.info('crawl.done', {
    routes: Object.keys(final.routes).length,
    elapsedMs: Date.now() - startedAt,
  });
  return final;
}
