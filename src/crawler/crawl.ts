/**
 * Pre-run crawler. Uses Crawlee's PlaywrightCrawler for robust SPA route
 * discovery — it handles link extraction, request queuing, deduplication,
 * concurrency, and SPA navigation natively. We parse each visited page into
 * a PageModel and store it in the shared SiteMap.
 *
 * Link discovery is three-pronged:
 *  1. Crawlee's built-in `enqueueLinks()` — standard `<a href>` links.
 *  2. Our custom `extractLinks()` — Angular `[routerLink]`, `data-routerlink`,
 *     `ng-reflect-router-link`, and SPA hash-routes (`#/path`) that Crawlee
 *     doesn't understand.
 *  3. Angular bundle scanning — on the root page, we fetch `main*.js` and
 *     scan for compiled route definitions (`path:"admin"`) to discover routes
 *     that aren't linked from any visible DOM element.
 *
 * Crawlee launches its own browser but inherits the auth session via
 * storageState from the auth-agent phase.
 */

import { randomUUID } from 'node:crypto';
import { PlaywrightCrawler, Configuration, type PlaywrightCrawlingContext, LogLevel, Log } from 'crawlee';
import { chromium as playwrightChromium } from 'playwright';
import { parsePage } from '../page-model/parser.ts';
import { extractLinks } from './extract-links.ts';
import { buildRouteEntry, SiteMapImpl } from './sitemap.ts';
import type { CrawlOptions, RouteEntry, SiteMap } from './types.ts';

/**
 * Scan `<script>` tags on the current page for Angular compiled route
 * definitions. Angular's AOT compiler emits patterns like `path:"admin"` or
 * `path:'wallet'` in the main bundle. We extract those path segments and
 * return them as absolute hash-route URLs.
 *
 * This is a best-effort heuristic — it catches routes that aren't linked
 * from any visible element (e.g. admin panels, hidden features).
 */
async function extractAngularBundleRoutes(
  page: import('playwright').Page,
  rootOrigin: string,
): Promise<string[]> {
  const paths: string[] = await page.evaluate(() => {
    const out: string[] = [];
    // Match `path:"segment"` or `path:'segment'` in inline/loaded scripts.
    // Angular AOT compiles route configs into the main bundle this way.
    const re = /path\s*:\s*["']([a-zA-Z0-9_\-\/]+)["']/g;
    for (const script of document.querySelectorAll('script[src]')) {
      // We can't read cross-origin script bodies from the DOM, but
      // Angular bundles are same-origin. Try fetching them.
      // Skip — fetching is async and complex inside evaluate. Instead,
      // scan the performance entries for script URLs and handle outside.
    }
    // Scan inline scripts (some SPAs inline route config).
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent ?? '';
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const seg = m[1];
        if (seg && seg !== '**' && seg !== '') out.push(seg);
      }
    }
    return out;
  });

  // Also fetch external JS bundles and scan them. Angular's main.js
  // contains the compiled route table.
  const scriptUrls: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script[src]'))
      .map((s) => s.getAttribute('src'))
      .filter((s): s is string => !!s)
      .filter((s) => /main[\.\-]/.test(s) || /app[\.\-]/.test(s) || /routes[\.\-]/.test(s)),
  );

  for (const src of scriptUrls) {
    try {
      const abs = new URL(src, rootOrigin).toString();
      const resp = await page.evaluate(
        async (url: string) => {
          try {
            const r = await fetch(url);
            if (!r.ok) return '';
            return await r.text();
          } catch {
            return '';
          }
        },
        abs,
      );
      if (resp) {
        const re = /path\s*:\s*["']([a-zA-Z0-9_\-\/]+)["']/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(resp)) !== null) {
          const seg = m[1];
          if (seg && seg !== '**' && seg !== '') paths.push(seg);
        }
      }
    } catch {
      // Best-effort — skip unreadable scripts.
    }
  }

  // Deduplicate and convert to absolute hash-route URLs.
  const unique = [...new Set(paths)];
  return unique.map((p) => `${rootOrigin}/#/${p}`);
}

/** Derive a canonical route key from a URL.
 *
 * SPA hash-routes (`#/path`) are the real route — the server path before
 * the `#` is irrelevant (the server never sees it). Without normalising,
 * `/basket#/contact` and `/#/contact` produce distinct route keys, causing
 * a combinatorial explosion of (server-paths × hash-routes).
 *
 * When a SPA hash-route is present, we collapse the pathname to `/` so
 * the route key is determined by the hash alone. Query strings are
 * stripped — they don't typically denote distinct routes. Returns the raw
 * string on parse failure. */
function deriveRoute(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const isSpaHash = /^#!?\//.test(u.hash);
    if (isSpaHash) {
      return `${u.origin}/${u.hash}`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

function isAllowedHost(url: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  try {
    const host = new URL(url).host;
    const hostNoPort = host.split(':')[0] ?? host;
    for (const allowed of allowedHosts) {
      if (host === allowed) return true;
      if (hostNoPort === allowed) return true;
      const allowedNoPort = allowed.split(':')[0] ?? allowed;
      if (allowedNoPort === hostNoPort) return true;
    }
  } catch {
    // Malformed URL.
  }
  return false;
}

/**
 * Crawl from `rootUrl` outward using Crawlee's PlaywrightCrawler. Each
 * visited page is parsed into a PageModel and stored in the returned SiteMap.
 *
 * Crawlee manages its own browser. Auth is inherited via storageStatePath
 * (the auth-agent's saved session). No external Page needed.
 */
export async function crawlSite(opts: CrawlOptions): Promise<SiteMap> {
  const startedAt = Date.now();
  const { rootUrl } = opts;
  const siteMap = new SiteMapImpl({ rootUrl });
  const seen = new Set<string>();
  let visitedCount = 0;

  const crawlConfig = new Configuration({ persistStorage: false });

  const crawler = new PlaywrightCrawler(
    {
      launchContext: {
        launcher: playwrightChromium,
        launchOptions: {
          headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
          args: ['--disable-dev-shm-usage', '--disable-gpu'],
        },
        // Inject the auth session from the auth-agent phase.
        ...(opts.storageStatePath
          ? { useIncognitoPages: false, userDataDir: undefined }
          : {}),
      },
      browserPoolOptions: {
        postLaunchHooks: [
          async (_pageId, browserController) => {
            if (!opts.storageStatePath) return;
            try {
              const { readFile } = await import('node:fs/promises');
              const raw = await readFile(opts.storageStatePath, 'utf-8');
              const state = JSON.parse(raw);
              const browser = browserController.browser!;
              const context = browser.contexts()[0];
              if (context && state.cookies?.length) {
                await context.addCookies(state.cookies);
              }
            } catch {
              // Best-effort — agents handle their own auth.
            }
          },
        ],
      },
      maxRequestsPerCrawl: opts.maxRoutes,
      maxConcurrency: opts.parallelism ?? 3,
      navigationTimeoutSecs: 8,
      requestHandlerTimeoutSecs: 20,
      maxRequestRetries: 0,
      log: new Log({ level: LogLevel.OFF }),

      async requestHandler({ request, page: crawleePage, enqueueLinks, log, crawler: crawlerRef }: PlaywrightCrawlingContext) {
        const url = request.loadedUrl ?? request.url;
        const route = deriveRoute(url);

        if (!isAllowedHost(url, opts.allowedHosts)) return;

        // Check if we got redirected off-host.
        const finalUrl = crawleePage.url();
        if (finalUrl !== 'about:blank' && !isAllowedHost(finalUrl, opts.allowedHosts)) {
          opts.logger.debug('crawl.offHostRedirect', { url, finalUrl });
          return;
        }

        if (seen.has(route)) return;
        seen.add(route);
        visitedCount += 1;

        const probeId = randomUUID();
        await opts.events?.write({
          type: 'crawl.probe.submit',
          probeId,
          route,
          kind: 'http',
        });

        // Wait briefly for SPA hydration.
        await crawleePage.waitForTimeout(800);

        let model: Awaited<ReturnType<typeof parsePage>>;
        try {
          model = await parsePage(crawleePage);
        } catch (err) {
          opts.logger.debug('crawl.parseError', {
            url,
            error: err instanceof Error ? err.message : String(err),
          });
          // Record a stub entry for failed parses.
          const stub = buildRouteEntry({
            url,
            route,
            title: '',
            formIds: [],
            tableIds: [],
            modalIds: [],
            wizardIds: [],
            source: 'crawler',
            visited: false,
          });
          siteMap.upsertRoute(stub, {
            url, route, title: '', forms: [], tables: [], modals: [],
            wizards: [], toolbars: [], navLinks: [], bareInteractives: [],
            bareFields: [], discovered: [], network: [], console: [],
            textHash: '', looksBroken: true, interactiveCount: 0,
            capturedAt: new Date().toISOString(),
          });
          await opts.events?.write({
            type: 'crawl.probe.result',
            probeId,
            status: null,
            ok: false,
            durationMs: Date.now() - startedAt,
          });
          return;
        }

        const status = (request as unknown as { statusCode?: number }).statusCode ?? undefined;
        const entry: RouteEntry = buildRouteEntry({
          url: model.url || url,
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

        await opts.events?.write({
          type: 'crawl.probe.result',
          probeId,
          status: status ?? null,
          ok: true,
          durationMs: Date.now() - startedAt,
        });

        // ---- Link discovery: combine Crawlee built-in + our SPA-aware extractor ----

        // 1. Crawlee's built-in enqueueLinks — finds standard <a href> links.
        try {
          await enqueueLinks({
            strategy: 'same-hostname',
            transformRequestFunction: (req) => {
              if (!isAllowedHost(req.url, opts.allowedHosts)) return false;
              if (visitedCount >= opts.maxRoutes) return false;
              const reqRoute = deriveRoute(req.url);
              if (seen.has(reqRoute)) return false;
              return req;
            },
          });
        } catch {
          // enqueueLinks failure is non-fatal.
        }

        // 2. Our custom extractor — finds Angular [routerLink], data-routerlink,
        //    ng-reflect-router-link, and SPA hash-routes that Crawlee misses.
        //
        //    IMPORTANT: Crawlee strips URL fragments when computing uniqueKey,
        //    so `http://host/#/login` and `http://host/#/register` both dedup
        //    to `http://host/`. We set uniqueKey = full URL to preserve hash
        //    routes as distinct requests.
        try {
          const customLinks = await (opts.linkExtractor ?? extractLinks)(crawleePage);
          const toEnqueue: Array<{ url: string; uniqueKey: string }> = [];
          for (const link of customLinks) {
            if (!isAllowedHost(link, opts.allowedHosts)) continue;
            if (visitedCount + toEnqueue.length >= opts.maxRoutes) break;
            const linkRoute = deriveRoute(link);
            if (seen.has(linkRoute)) continue;
            toEnqueue.push({ url: link, uniqueKey: link });
          }
          if (toEnqueue.length > 0) {
            await crawlerRef.addRequests(toEnqueue);
            opts.logger.debug('crawl.customLinksEnqueued', {
              count: toEnqueue.length,
              source: url,
            });
          }
        } catch {
          // Custom extraction failure is non-fatal.
        }

        // 3. On the root page, scan Angular compiled bundles for route
        //    definitions (path:"admin", path:"wallet", etc.). These routes
        //    may not be linked from any visible element.
        if (request.url === rootUrl) {
          try {
            const origin = new URL(rootUrl).origin;
            const bundleRoutes = await extractAngularBundleRoutes(crawleePage, origin);
            const toEnqueue: Array<{ url: string; uniqueKey: string }> = [];
            for (const link of bundleRoutes) {
              if (!isAllowedHost(link, opts.allowedHosts)) continue;
              if (visitedCount + toEnqueue.length >= opts.maxRoutes) break;
              const linkRoute = deriveRoute(link);
              if (seen.has(linkRoute)) continue;
              toEnqueue.push({ url: link, uniqueKey: link });
            }
            if (toEnqueue.length > 0) {
              await crawlerRef.addRequests(toEnqueue);
              opts.logger.debug('crawl.bundleRoutesEnqueued', {
                count: toEnqueue.length,
              });
            }
          } catch {
            // Bundle scanning failure is non-fatal.
          }
        }
      },

      async failedRequestHandler({ request }) {
        const url = request.url;
        const route = deriveRoute(url);
        if (seen.has(route)) return;
        seen.add(route);

        const stub = buildRouteEntry({
          url,
          route,
          title: '',
          formIds: [],
          tableIds: [],
          modalIds: [],
          wizardIds: [],
          source: 'crawler',
          visited: false,
        });
        siteMap.upsertRoute(stub, {
          url, route, title: '', forms: [], tables: [], modals: [],
          wizards: [], toolbars: [], navLinks: [], bareInteractives: [],
          bareFields: [], discovered: [], network: [], console: [],
          textHash: '', looksBroken: true, interactiveCount: 0,
          capturedAt: new Date().toISOString(),
        });

        await opts.events?.write({
          type: 'crawl.probe.result',
          probeId: randomUUID(),
          status: null,
          ok: false,
          durationMs: Date.now() - startedAt,
        });
      },
    },
    crawlConfig,
  );

  // Wall-clock timeout: abort the crawler if it runs too long.
  const wallClockTimer = setTimeout(() => {
    opts.logger.debug('crawl.wallClockExceeded', { elapsedMs: Date.now() - startedAt });
    void crawler.teardown();
  }, opts.maxWallClockMs);

  try {
    await crawler.run([rootUrl]);
  } finally {
    clearTimeout(wallClockTimer);
    await crawler.teardown().catch(() => {});
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
