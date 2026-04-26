/**
 * discovery.ts integration tests. ask_sitemap is tested with a fake
 * SiteMapAccessor; route_404_probe uses page.route() to mock HTTP responses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { askSitemap, registerDiscoveryPlaybooks, route404Probe } from './discovery.ts';
import { PlaybookRegistry, type PlaybookContext } from './framework.ts';
import type { NetworkAnomaly, PageModel } from '../page-model/types.ts';
import type { RouteEntry, SiteMapAccessor } from '../crawler/types.ts';
import { createLogger } from '../logging/logger.ts';

let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

function makeRoute(route: string, opts: Partial<RouteEntry> = {}): RouteEntry {
  return {
    url: `https://example.test${route}`,
    route,
    title: opts.title ?? `Page ${route}`,
    status: opts.status,
    formIds: opts.formIds ?? [],
    tableIds: opts.tableIds ?? [],
    modalIds: opts.modalIds ?? [],
    wizardIds: opts.wizardIds ?? [],
    source: opts.source ?? 'crawler',
    discoveredAt: new Date().toISOString(),
    visitedAt: opts.visitedAt,
    visited: opts.visited ?? false,
  };
}

interface FakeSiteMapInputs {
  unvisited?: RouteEntry[];
  all?: RouteEntry[];
  formsUntested?: Array<{ route: string; formId: string }>;
  tablesUntested?: Array<{ route: string; tableId: string }>;
  modalsUntested?: Array<{ route: string; modalId: string }>;
  wizardsUntested?: Array<{ route: string; wizardId: string }>;
}

function fakeSiteMap(input: FakeSiteMapInputs = {}): SiteMapAccessor {
  return {
    getRoute: () => undefined,
    getPageModel: () => undefined,
    listAllRoutes: () => input.all ?? [],
    listUnvisitedRoutes: () => input.unvisited ?? [],
    listFormsUntested: () => input.formsUntested ?? [],
    listTablesUntested: () => input.tablesUntested ?? [],
    listModalsUntested: () => input.modalsUntested ?? [],
    listWizardsUntested: () => input.wizardsUntested ?? [],
    recordVisit: () => {},
    recordPlaybookOutcome: () => {},
    upsertRoute: () => {},
    serialize: () => ({
      startedAt: new Date().toISOString(),
      rootUrl: 'about:blank',
      routes: {},
      pageModels: {},
    }),
  };
}

function makeContext(
  page: Page,
  siteMap: SiteMapAccessor,
  network: NetworkAnomaly[] = [],
): PlaybookContext {
  const pageModel = async (): Promise<PageModel> => ({
    url: page.url(),
    route: page.url(),
    title: await page.title().catch(() => ''),
    forms: [],
    tables: [],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareInteractives: [],
    network,
    console: [],
    textHash: '',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
  });
  return {
    page,
    pageModel,
    siteMap,
    agentId: 'test-agent',
    persona: '',
    runDir: '/tmp/test',
    logger: createLogger({ level: 'error' }),
    allowedHosts: [],
  };
}

async function fresh(html: string): Promise<Page> {
  const p = await context.newPage();
  await p.setContent(html, { waitUntil: 'domcontentloaded' });
  return p;
}

// ─── ask_sitemap ─────────────────────────────────────────────────────────────

describe('ask_sitemap', () => {
  it('returns up to 10 unvisited routes from the SiteMapAccessor', async () => {
    const unvisited = [makeRoute('/a'), makeRoute('/b'), makeRoute('/c')];
    const sm = fakeSiteMap({ unvisited });
    const page = await fresh('<html><body></body></html>');
    try {
      const ctx = makeContext(page, sm);
      const out = await askSitemap.run({ query: 'unvisited routes' }, ctx);
      expect(out.status).toBe('ok');
      const items = (out.evidence as { items: unknown[] }).items;
      expect(items).toHaveLength(3);
      expect((out.evidence as { itemCount: number }).itemCount).toBe(3);
    } finally {
      await page.close();
    }
  });

  it('caps results at 10 even when the SiteMap has more', async () => {
    const unvisited = Array.from({ length: 15 }, (_, i) => makeRoute(`/r${i}`));
    const sm = fakeSiteMap({ unvisited });
    const page = await fresh('<html><body></body></html>');
    try {
      const ctx = makeContext(page, sm);
      const out = await askSitemap.run({ query: 'unvisited routes' }, ctx);
      expect((out.evidence as { items: unknown[] }).items).toHaveLength(10);
    } finally {
      await page.close();
    }
  });

  it('handles "4xx routes" by filtering listAllRoutes() on status', async () => {
    const all = [
      makeRoute('/ok', { status: 200 }),
      makeRoute('/missing', { status: 404 }),
      makeRoute('/forbidden', { status: 403 }),
      makeRoute('/server', { status: 500 }),
    ];
    const sm = fakeSiteMap({ all });
    const page = await fresh('<html><body></body></html>');
    try {
      const ctx = makeContext(page, sm);
      const out = await askSitemap.run({ query: '4xx routes' }, ctx);
      expect((out.evidence as { items: unknown[] }).items).toHaveLength(2);
    } finally {
      await page.close();
    }
  });
});

// ─── route_404_probe ─────────────────────────────────────────────────────────

describe('route_404_probe', () => {
  it('records the status of each probed path and returns ok when none are 5xx', async () => {
    const page = await context.newPage();
    await page.route(/^https:\/\/probe-test\.local\/.*/, (route) => {
      const url = route.request().url();
      if (url.endsWith('/exists')) {
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' });
      } else {
        route.fulfill({ status: 404, contentType: 'text/html', body: 'not found' });
      }
    });
    try {
      await page.goto('https://probe-test.local/start', { waitUntil: 'domcontentloaded' });
      const ctx = makeContext(page, fakeSiteMap());
      const out = await route404Probe.run(
        { paths: ['/exists', '/missing'] },
        ctx,
      );
      expect(out.status).toBe('ok');
      const results = (out.evidence as {
        results: Array<{ path: string; status: number | null; ok: boolean }>;
      }).results;
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ path: '/exists', status: 200, ok: true });
      expect(results[1]).toMatchObject({ path: '/missing', status: 404, ok: false });
    } finally {
      await page.close();
    }
  }, 15_000);

  it('returns suspicious when any probed path returns 5xx', async () => {
    const page = await context.newPage();
    await page.route(/^https:\/\/probe-test\.local\/.*/, (route) => {
      const url = route.request().url();
      if (url.endsWith('/broken')) {
        route.fulfill({ status: 500, contentType: 'text/html', body: 'oops' });
      } else {
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' });
      }
    });
    try {
      await page.goto('https://probe-test.local/start', { waitUntil: 'domcontentloaded' });
      const ctx = makeContext(page, fakeSiteMap());
      const out = await route404Probe.run({ paths: ['/broken'] }, ctx);
      expect(out.status).toBe('suspicious');
      expect((out.evidence as { any5xx: boolean }).any5xx).toBe(true);
    } finally {
      await page.close();
    }
  }, 15_000);
});

// ─── registry ────────────────────────────────────────────────────────────────

describe('registerDiscoveryPlaybooks', () => {
  it('registers all discovery playbooks', () => {
    const r = new PlaybookRegistry();
    registerDiscoveryPlaybooks(r);
    expect(r.size()).toBe(3);
    const names = r.list().map((p) => p.name).sort();
    expect(names).toEqual([
      'ask_sitemap',
      'discover_route_affordances',
      'route_404_probe',
    ]);
  });
});
