/**
 * Pre-run crawler. Uses Crawlee's PlaywrightCrawler for robust SPA route
 * discovery — it handles link extraction, request queuing, deduplication,
 * concurrency, and SPA navigation natively. We parse each visited page into
 * a PageModel and store it in the shared SiteMap.
 *
 * Link discovery is four-pronged:
 *  1. Crawlee's built-in `enqueueLinks()` — standard `<a href>` links.
 *  2. Our custom `extractLinks()` — `[routerLink]`, `data-routerlink`,
 *     `data-href`, and SPA hash-routes (`#/path`) that Crawlee misses.
 *  3. Bundle scanning — on the root page, fetch JS bundles and scan for
 *     compiled route definitions (`path:"admin"`). Works for Angular AOT,
 *     React Router, Vue Router, and similar frameworks.
 *  4. Interactive nav expansion — click collapsed sidebar/nav toggles
 *     (`aria-expanded="false"`, `<details>`, tree items) and re-extract
 *     links from the expanded DOM.
 *
 * Crawlee launches its own browser but inherits the auth session via
 * storageState from the auth-agent phase.
 */

import { randomUUID } from 'node:crypto';
import {
  Configuration,
  Log,
  LogLevel,
  PlaywrightCrawler,
  type PlaywrightCrawlingContext,
} from 'crawlee';
import { chromium as playwrightChromium } from 'playwright';
import { parsePage } from '../page-model/parser.ts';
import { isPathBanned } from '../safety/guards.ts';
import { deriveRoute } from '../util/route.ts';
import { extractLinks } from './extract-links.ts';
import { buildRouteEntry, SiteMapImpl } from './sitemap.ts';
import type { CrawlOptions, RouteEntry, SiteMap } from './types.ts';

/**
 * Scan `<script>` tags on the current page for compiled route definitions.
 * Works for Angular AOT (`path:"admin"`), React Router (`path:"/dashboard"`),
 * Vue Router, and most SPA frameworks — they all compile route configs into
 * `{path: "segment"}` object literals.
 *
 * Returns absolute URLs. Detects hash vs browser-history routing from the
 * root URL: if the root uses `#/` or `#!/`, routes are emitted as hash
 * routes; otherwise as pathname routes.
 */
async function extractBundleRoutes(
  page: import('playwright').Page,
  rootOrigin: string,
  rootUrl: string,
): Promise<string[]> {
  const usesHashRouting = /^#!?\//.test(new URL(rootUrl).hash);

  const paths: string[] = await page.evaluate(() => {
    const out: string[] = [];
    const re = /path\s*:\s*["']([a-zA-Z0-9_\-/]+)["']/g;
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

  // Fetch external JS bundles. Widen the filename filter beyond Angular's
  // `main.js` to catch Vite (`index-*.js`, `assets/*.js`), webpack chunks,
  // and explicit route modules.
  const scriptUrls: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script[src]'))
      .map((s) => s.getAttribute('src'))
      .filter((s): s is string => !!s)
      .filter(
        (s) =>
          /main[.-]/.test(s) ||
          /app[.-]/.test(s) ||
          /routes?[.-]/.test(s) ||
          /index[.-]/.test(s) ||
          /assets\//.test(s),
      ),
  );

  for (const src of scriptUrls) {
    try {
      const abs = new URL(src, rootOrigin).toString();
      const resp = await page.evaluate(async (url: string) => {
        try {
          const r = await fetch(url);
          if (!r.ok) return '';
          return await r.text();
        } catch {
          return '';
        }
      }, abs);
      if (resp) {
        const re = /path\s*:\s*["']([a-zA-Z0-9_\-/]+)["']/g;
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

  const unique = [...new Set(paths)];
  if (usesHashRouting) {
    return unique.map((p) => `${rootOrigin}/#/${p}`);
  }
  return unique.map((p) => {
    const segment = p.startsWith('/') ? p : `/${p}`;
    return `${rootOrigin}${segment}`;
  });
}

/**
 * Expand collapsed navigation elements and re-extract links. Targets
 * common SPA sidebar patterns: aria-expanded toggles, <details>/<summary>,
 * tree items. Only clicks within navigation-scoped containers (nav, aside,
 * sidebar-like classnames) to avoid triggering page-level actions.
 */
async function expandNavAndExtractLinks(page: import('playwright').Page): Promise<string[]> {
  const EXPAND_SELECTORS = [
    'nav button[aria-expanded="false"]',
    'aside button[aria-expanded="false"]',
    '[class*="sidebar" i] button[aria-expanded="false"]',
    '[class*="sidenav" i] button[aria-expanded="false"]',
    '[class*="nav-menu" i] button[aria-expanded="false"]',
    '[role="tree"] [role="treeitem"][aria-expanded="false"]',
    'nav details:not([open]) > summary',
    'aside details:not([open]) > summary',
  ];

  let clickedAny = false;
  for (const sel of EXPAND_SELECTORS) {
    const elements = await page.$$(sel);
    for (const el of elements) {
      try {
        await el.click({ timeout: 300 });
        clickedAny = true;
      } catch {
        // Non-fatal — element may be obscured or detached.
      }
    }
  }

  if (!clickedAny) return [];

  // Let expanded sections animate and render.
  await page.waitForTimeout(400);
  return extractLinks(page);
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
 * string on parse failure — see `src/util/route.ts`. */

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
  const bannedPrefixes = opts.bannedPathPrefixes ?? [];
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
        ...(opts.storageStatePath ? { useIncognitoPages: false, userDataDir: undefined } : {}),
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

      // Desktop viewport before each navigation so responsive sidebars
      // (Tailwind `lg:block`, Material `md:`) aren't hidden. Many admin
      // portals collapse their nav below 1024px.
      preNavigationHooks: [
        async ({ page }) => {
          await page.setViewportSize({ width: 1280, height: 900 });
        },
      ],

      async requestHandler({
        request,
        page: crawleePage,
        enqueueLinks,
        log,
        crawler: crawlerRef,
      }: PlaywrightCrawlingContext) {
        const url = request.loadedUrl ?? request.url;
        const route = deriveRoute(url);

        if (!isAllowedHost(url, opts.allowedHosts)) return;
        if (isPathBanned(url, bannedPrefixes)) return;

        // Check if we got redirected off-host or onto a banned path.
        const finalUrl = crawleePage.url();
        if (finalUrl !== 'about:blank' && !isAllowedHost(finalUrl, opts.allowedHosts)) {
          opts.logger.debug('crawl.offHostRedirect', { url, finalUrl });
          return;
        }
        if (finalUrl !== 'about:blank' && isPathBanned(finalUrl, bannedPrefixes)) {
          opts.logger.debug('crawl.bannedPathRedirect', { url, finalUrl });
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

        // Wait for SPA hydration: network idle means API calls have resolved
        // and the framework has data to render navigation. Fixed 800ms was too
        // short for React apps that fetch session/profile before rendering nav.
        try {
          await crawleePage.waitForLoadState('networkidle', { timeout: 5000 });
        } catch {
          // Some pages never reach networkidle (WebSocket keep-alives, polling).
        }
        // Brief buffer for React's async setState re-render after data arrives.
        await crawleePage.waitForTimeout(300);

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
            url,
            route,
            title: '',
            forms: [],
            tables: [],
            modals: [],
            wizards: [],
            toolbars: [],
            navLinks: [],
            bareInteractives: [],
            bareFields: [],
            discovered: [],
            network: [],
            console: [],
            textHash: '',
            looksBroken: true,
            interactiveCount: 0,
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
              if (isPathBanned(req.url, bannedPrefixes)) return false;
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
            if (isPathBanned(link, bannedPrefixes)) continue;
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
            const bundleRoutes = await extractBundleRoutes(crawleePage, origin, rootUrl);
            const toEnqueue: Array<{ url: string; uniqueKey: string }> = [];
            for (const link of bundleRoutes) {
              if (!isAllowedHost(link, opts.allowedHosts)) continue;
              if (isPathBanned(link, bannedPrefixes)) continue;
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

        // 4. Expand collapsed nav/sidebar sections and re-extract links.
        //    Targets aria-expanded toggles, <details>/<summary>, and tree
        //    items inside nav/aside/sidebar containers.
        try {
          const expandedLinks = await expandNavAndExtractLinks(crawleePage);
          const toEnqueue: Array<{ url: string; uniqueKey: string }> = [];
          for (const link of expandedLinks) {
            if (!isAllowedHost(link, opts.allowedHosts)) continue;
            if (isPathBanned(link, bannedPrefixes)) continue;
            if (visitedCount + toEnqueue.length >= opts.maxRoutes) break;
            const linkRoute = deriveRoute(link);
            if (seen.has(linkRoute)) continue;
            toEnqueue.push({ url: link, uniqueKey: link });
          }
          if (toEnqueue.length > 0) {
            await crawlerRef.addRequests(toEnqueue);
            opts.logger.debug('crawl.expandedNavLinksEnqueued', {
              count: toEnqueue.length,
              source: url,
            });
          }
        } catch {
          // Nav expansion failure is non-fatal.
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
          url,
          route,
          title: '',
          forms: [],
          tables: [],
          modals: [],
          wizards: [],
          toolbars: [],
          navLinks: [],
          bareInteractives: [],
          bareFields: [],
          discovered: [],
          network: [],
          console: [],
          textHash: '',
          looksBroken: true,
          interactiveCount: 0,
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
