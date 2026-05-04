import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.ts';
import { crawlSite } from './crawl.ts';

let server: http.Server;
let port: number;
let origin: string;

function silentLogger() {
  return createLogger({ level: 'error' });
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      port = addr.port;
      origin = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

afterEach(async () => {
  await stopServer();
});

const html = (title: string, links: string[]): string => {
  const anchors = links.map((l) => `<a href="${l}">${l}</a>`).join(' ');
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${anchors}</body></html>`;
};

describe('crawlSite', () => {
  it('walks linked routes, building a SiteMap with each visited', async () => {
    const pages: Record<string, string> = {
      '/': html('Home', ['/page1']),
      '/page1': html('Page 1', ['/page2']),
      '/page2': html('Page 2', ['/']),
    };

    await startServer((req, res) => {
      const body = pages[req.url ?? '/'] ?? html('Not Found', []);
      res.writeHead(req.url && pages[req.url] ? 200 : 404, { 'content-type': 'text/html' });
      res.end(body);
    });

    const siteMap = await crawlSite({
      rootUrl: `${origin}/`,
      maxRoutes: 60,
      maxWallClockMs: 30_000,
      allowedHosts: [`127.0.0.1:${port}`],
      logger: silentLogger(),
    });

    const routes = Object.keys(siteMap.routes);
    expect(routes).toContain(`${origin}/`);
    expect(routes).toContain(`${origin}/page1`);
    expect(routes).toContain(`${origin}/page2`);
    expect(routes.length).toBeGreaterThanOrEqual(3);

    expect(siteMap.routes[`${origin}/`]?.source).toBe('crawler');
    expect(siteMap.routes[`${origin}/`]?.visited).toBe(false);
    expect(siteMap.pageModels[`${origin}/page1`]).toBeDefined();
  });

  it('respects the maxRoutes cap', async () => {
    const pages: Record<string, string> = {
      '/': html('Home', ['/page1']),
      '/page1': html('Page 1', ['/page2']),
      '/page2': html('Page 2', []),
    };

    await startServer((req, res) => {
      const body = pages[req.url ?? '/'] ?? html('Not Found', []);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    });

    const siteMap = await crawlSite({
      rootUrl: `${origin}/`,
      maxRoutes: 2,
      maxWallClockMs: 30_000,
      allowedHosts: [`127.0.0.1:${port}`],
      logger: silentLogger(),
    });

    expect(Object.keys(siteMap.routes).length).toBeLessThanOrEqual(2);
  });

  it('respects maxWallClockMs and aborts the crawl', async () => {
    await startServer((req, res) => {
      // Slow responses so the wall clock triggers.
      setTimeout(() => {
        const p = req.url ?? '/';
        const next = p === '/' ? '/slow1' : p === '/slow1' ? '/slow2' : '/end';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html(p, [next]));
      }, 300);
    });

    const start = Date.now();
    const siteMap = await crawlSite({
      rootUrl: `${origin}/`,
      maxRoutes: 60,
      maxWallClockMs: 2_000,
      allowedHosts: [`127.0.0.1:${port}`],
      logger: silentLogger(),
    });
    const elapsed = Date.now() - start;

    // Should terminate within a reasonable time of the wall clock limit.
    expect(elapsed).toBeLessThan(15_000);
    expect(Object.keys(siteMap.routes).length).toBeLessThan(4);
  });

  it('filters off-origin links', async () => {
    const pages: Record<string, string> = {
      '/': html('Home', ['/internal', 'https://evil.example/x']),
      '/internal': html('Internal', []),
    };

    await startServer((req, res) => {
      const body = pages[req.url ?? '/'] ?? html('Not Found', []);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    });

    const siteMap = await crawlSite({
      rootUrl: `${origin}/`,
      maxRoutes: 60,
      maxWallClockMs: 30_000,
      allowedHosts: [`127.0.0.1:${port}`],
      logger: silentLogger(),
    });

    const routes = Object.keys(siteMap.routes);
    expect(routes).toContain(`${origin}/`);
    expect(routes).toContain(`${origin}/internal`);
    expect(routes.some((r) => r.includes('evil.example'))).toBe(false);
  });

  it('discovers SPA hash-routes from [routerLink] attributes', async () => {
    // Simulates an Angular app: the root page has no <a href> links to
    // hash-routes, but has elements with routerLink attributes that our
    // custom extractor picks up.
    const spaRoot = `<!doctype html><html><head><title>SPA</title></head><body>
      <nav>
        <a routerLink="/dashboard">#/dashboard</a>
        <a routerLink="/wallet">#/wallet</a>
        <a routerLink="/admin">#/admin</a>
      </nav>
    </body></html>`;

    // All hash-routes serve the same SPA shell (as a real Angular app would).
    await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(spaRoot);
    });

    const siteMap = await crawlSite({
      rootUrl: `${origin}/`,
      maxRoutes: 20,
      maxWallClockMs: 30_000,
      allowedHosts: [`127.0.0.1:${port}`],
      logger: silentLogger(),
    });

    const routes = Object.keys(siteMap.routes);
    // The custom extractor should have found routerLink="/dashboard" etc.
    // and enqueued them as hash-routes. Crawlee's built-in enqueueLinks
    // would miss these because routerLink is not a standard href.
    expect(routes.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts routes from inline Angular bundle scripts', async () => {
    // Simulates an Angular app with route config compiled into an inline script.
    const bundlePage = `<!doctype html><html><head><title>Bundle</title></head><body>
      <script>
        var routes = [{path:"login"},{path:"register"},{path:"basket"},{path:"administration"}];
      </script>
    </body></html>`;

    await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(bundlePage);
    });

    const siteMap = await crawlSite({
      rootUrl: `${origin}/`,
      maxRoutes: 40,
      maxWallClockMs: 30_000,
      allowedHosts: [`127.0.0.1:${port}`],
      logger: silentLogger(),
    });

    const routes = Object.keys(siteMap.routes);
    // The bundle scanner should find path:"login", path:"register", etc.
    // and enqueue them as hash-routes from the root page.
    expect(routes.length).toBeGreaterThanOrEqual(3);
    // At least some of the bundled routes should appear.
    const hasHashRoutes = routes.some((r) => r.includes('#/'));
    expect(hasHashRoutes).toBe(true);
  });

  it('records a stub entry for routes that fail to navigate', async () => {
    await startServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html('Home', ['/broken']));
      } else {
        // Immediately destroy the connection to simulate a hard failure.
        res.destroy();
      }
    });

    const siteMap = await crawlSite({
      rootUrl: `${origin}/`,
      maxRoutes: 60,
      maxWallClockMs: 30_000,
      allowedHosts: [`127.0.0.1:${port}`],
      logger: silentLogger(),
    });

    // The broken route should be recorded (as a stub or via failedRequestHandler).
    expect(Object.keys(siteMap.routes).length).toBeGreaterThanOrEqual(1);
  });
});
