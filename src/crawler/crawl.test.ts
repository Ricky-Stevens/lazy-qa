import { type Browser, chromium, type Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.ts';
import { crawlSite } from './crawl.ts';
import { extractLinks } from './extract-links.ts';

let browser: Browser;
let page: Page;

const ORIGIN = 'https://app.test';

beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterEach(async () => {
  await browser?.close();
});

/** Silence the logger in tests — we don't assert on it. */
function silentLogger() {
  const out = createLogger({ level: 'error' });
  return out;
}

/** Install handlers that synthesise three linked pages: /, /page1, /page2. */
async function installThreePageMock(): Promise<void> {
  await page.route(`${ORIGIN}/`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <h1>Home</h1>
        <a href="/page1">Page 1</a>
      </body></html>`,
    });
  });
  await page.route(`${ORIGIN}/page1`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <h1>Page 1</h1>
        <a href="/page2">Page 2</a>
      </body></html>`,
    });
  });
  await page.route(`${ORIGIN}/page2`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <h1>Page 2</h1>
        <a href="/">Home</a>
      </body></html>`,
    });
  });
}

describe('crawlSite', () => {
  it('walks linked routes to maxDepth, building a SiteMap with each visited', async () => {
    await installThreePageMock();
    await page.goto(`${ORIGIN}/`);

    const siteMap = await crawlSite(page, {
      maxDepth: 2,
      maxRoutes: 60,
      maxWallClockMs: 30_000,
      allowedHosts: ['app.test'],
      linkExtractor: extractLinks,
      logger: silentLogger(),
    });

    const routes = Object.keys(siteMap.routes);
    expect(routes).toContain(`${ORIGIN}/`);
    expect(routes).toContain(`${ORIGIN}/page1`);
    expect(routes).toContain(`${ORIGIN}/page2`);
    expect(routes).toHaveLength(3);

    expect(siteMap.routes[`${ORIGIN}/`]?.source).toBe('crawler');
    expect(siteMap.routes[`${ORIGIN}/`]?.visited).toBe(false);
    expect(siteMap.routes[`${ORIGIN}/`]?.status).toBe(200);
    expect(siteMap.pageModels[`${ORIGIN}/page1`]).toBeDefined();
  });

  it('respects the maxRoutes cap', async () => {
    await installThreePageMock();
    await page.goto(`${ORIGIN}/`);

    const siteMap = await crawlSite(page, {
      maxDepth: 5,
      maxRoutes: 2,
      maxWallClockMs: 30_000,
      allowedHosts: ['app.test'],
      linkExtractor: extractLinks,
      logger: silentLogger(),
    });

    expect(Object.keys(siteMap.routes)).toHaveLength(2);
  });

  it('respects the maxDepth boundary (depth 0 only fetches root)', async () => {
    await installThreePageMock();
    await page.goto(`${ORIGIN}/`);

    const siteMap = await crawlSite(page, {
      maxDepth: 0,
      maxRoutes: 60,
      maxWallClockMs: 30_000,
      allowedHosts: ['app.test'],
      linkExtractor: extractLinks,
      logger: silentLogger(),
    });

    expect(Object.keys(siteMap.routes)).toEqual([`${ORIGIN}/`]);
  });

  it('respects maxWallClockMs and aborts the crawl', async () => {
    // Each page response sleeps long enough that visiting more than 1 takes
    // more than maxWallClockMs.
    await page.route(`${ORIGIN}/**`, async (route) => {
      await new Promise((r) => setTimeout(r, 250));
      const url = route.request().url();
      const path = new URL(url).pathname;
      const next = path === '/' ? '/slow1' : path === '/slow1' ? '/slow2' : '/end';
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body><a href="${next}">Next</a></body></html>`,
      });
    });
    await page.goto(`${ORIGIN}/`);

    const start = Date.now();
    const siteMap = await crawlSite(page, {
      maxDepth: 5,
      maxRoutes: 60,
      maxWallClockMs: 400,
      allowedHosts: ['app.test'],
      linkExtractor: extractLinks,
      logger: silentLogger(),
    });
    const elapsed = Date.now() - start;

    // The crawl should bail on wall-clock long before reaching all 4 routes.
    // Allow generous slack since browser nav adds overhead.
    expect(elapsed).toBeLessThan(3_000);
    expect(Object.keys(siteMap.routes).length).toBeLessThan(4);
  });

  it('filters off-origin and disallowed-host links', async () => {
    await page.route(`${ORIGIN}/`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <a href="/internal">Internal</a>
          <a href="https://evil.example/x">Evil</a>
        </body></html>`,
      });
    });
    await page.route(`${ORIGIN}/internal`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body><h1>Internal</h1></body></html>`,
      });
    });
    await page.goto(`${ORIGIN}/`);

    const siteMap = await crawlSite(page, {
      maxDepth: 2,
      maxRoutes: 60,
      maxWallClockMs: 30_000,
      allowedHosts: ['app.test'],
      linkExtractor: extractLinks,
      logger: silentLogger(),
    });

    const routes = Object.keys(siteMap.routes);
    expect(routes).toContain(`${ORIGIN}/`);
    expect(routes).toContain(`${ORIGIN}/internal`);
    expect(routes.some((r) => r.includes('evil.example'))).toBe(false);
  });

  it('records a stub entry for routes that fail to navigate', async () => {
    await page.route(`${ORIGIN}/`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <a href="/broken">Broken</a>
        </body></html>`,
      });
    });
    await page.route(`${ORIGIN}/broken`, (route) => {
      route.abort('failed');
    });
    await page.goto(`${ORIGIN}/`);

    const siteMap = await crawlSite(page, {
      maxDepth: 2,
      maxRoutes: 60,
      maxWallClockMs: 30_000,
      allowedHosts: ['app.test'],
      linkExtractor: extractLinks,
      logger: silentLogger(),
    });

    expect(Object.keys(siteMap.routes)).toContain(`${ORIGIN}/broken`);
    const broken = siteMap.routes[`${ORIGIN}/broken`];
    expect(broken).toBeDefined();
    expect(broken?.title).toBe('');
    expect(broken?.source).toBe('crawler');
  });

  it('parallelism > 1 visits the same routes as serial (modulo order)', async () => {
    // browser.newPage() opens a "default" context that disallows additional
    // pages — so the crawler's `context.newPage()` would fail. Build a real
    // context here, then mock at the context level so any tab inherits it.
    const ctx = await browser.newContext();
    const tab = await ctx.newPage();

    const slug = (path: string) => path.replace(/^\//, '') || 'root';
    const linkBlock = (paths: string[]): string =>
      paths.map((p) => `<a href="${p}">${slug(p)}</a>`).join(' ');

    // Fan-out tree: root → /a /b /c; /a → /a1 /a2; /b → /b1; the rest are leaves.
    const tree: Record<string, string[]> = {
      '/': ['/a', '/b', '/c'],
      '/a': ['/a1', '/a2'],
      '/b': ['/b1'],
      '/c': [],
      '/a1': [],
      '/a2': [],
      '/b1': [],
    };
    await ctx.route(`${ORIGIN}/**`, (route) => {
      const url = route.request().url();
      const path = new URL(url).pathname;
      const children = tree[path] ?? [];
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body><h1>${slug(path)}</h1>${linkBlock(children)}</body></html>`,
      });
    });
    await tab.goto(`${ORIGIN}/`);

    const baseOpts = {
      maxDepth: 3,
      maxRoutes: 60,
      maxWallClockMs: 30_000,
      allowedHosts: ['app.test'] as string[],
      linkExtractor: extractLinks,
      logger: silentLogger(),
    };

    const serial = await crawlSite(tab, { ...baseOpts });
    await tab.goto(`${ORIGIN}/`);
    const parallel = await crawlSite(tab, { ...baseOpts, parallelism: 3 });

    const serialRoutes = new Set(Object.keys(serial.routes));
    const parallelRoutes = new Set(Object.keys(parallel.routes));
    expect(parallelRoutes).toEqual(serialRoutes);
    expect(serialRoutes.size).toBe(7);

    await ctx.close();
  }, 15_000);
});
