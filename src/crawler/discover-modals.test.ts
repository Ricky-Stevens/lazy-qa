/**
 * Tests for discover-modals.ts — candidate collection, deduplication,
 * trigger regex matching, and the discovery pipeline with mock pages.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActionRef, PageModel } from '../page-model/types.ts';
import type { Logger } from '../logging/logger.ts';
import type { RouteEntry, SiteMapAccessor } from './types.ts';
import { discoverModals, type DiscoverModalsOptions } from './discover-modals.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActionRef(label: string, overrides: Partial<ActionRef> = {}): ActionRef {
  return {
    locator: `button:has-text("${label}")`,
    label,
    type: 'button',
    disabled: false,
    intent: 'action',
    ...overrides,
  };
}

function makePageModel(overrides: Partial<PageModel> = {}): PageModel {
  return {
    url: 'http://localhost:3000/page',
    route: '/page',
    title: 'Test Page',
    forms: [],
    tables: [],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareInteractives: [],
    bareFields: [],
    network: [],
    console: [],
    textHash: 'abc123',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRouteEntry(route: string, overrides: Partial<RouteEntry> = {}): RouteEntry {
  return {
    url: `http://localhost:3000${route}`,
    route,
    title: 'Page',
    formIds: [],
    tableIds: [],
    modalIds: [],
    wizardIds: [],
    source: 'crawler',
    visited: true,
    ...overrides,
  } as RouteEntry;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeSiteMap(routes: Array<{ entry: RouteEntry; model?: PageModel }>): SiteMapAccessor {
  const routeMap = new Map<string, RouteEntry>();
  const modelMap = new Map<string, PageModel>();
  for (const { entry, model } of routes) {
    routeMap.set(entry.route, entry);
    if (model) modelMap.set(entry.route, model);
  }
  return {
    listAllRoutes: vi.fn().mockReturnValue(Array.from(routeMap.values())),
    getPageModel: vi.fn().mockImplementation((r: string) => modelMap.get(r) ?? null),
    getRoute: vi.fn().mockImplementation((r: string) => routeMap.get(r) ?? null),
    upsertRoute: vi.fn(),
    recordVisit: vi.fn(),
    listFormsUntested: vi.fn().mockReturnValue([]),
    listTablesUntested: vi.fn().mockReturnValue([]),
    listModalsUntested: vi.fn().mockReturnValue([]),
    listWizardsUntested: vi.fn().mockReturnValue([]),
  } as unknown as SiteMapAccessor;
}

function makeMockPage() {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('http://localhost:3000/page'),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
    },
    locator: vi.fn().mockReturnValue({
      first: vi.fn().mockReturnValue({
        isVisible: vi.fn().mockResolvedValue(false),
        click: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discoverModals', () => {
  describe('no candidates', () => {
    it('returns zeros when no routes have trigger buttons', async () => {
      const model = makePageModel({ toolbars: [], bareInteractives: [] });
      const sitemap = makeSiteMap([
        { entry: makeRouteEntry('/page'), model },
      ]);
      const page = makeMockPage();
      const logger = makeLogger();

      const result = await discoverModals({
        sitemap,
        page: page as any,
        logger,
      });

      expect(result.routesProbed).toBe(0);
      expect(result.modalsFound).toBe(0);
      expect(result.formsDiscovered).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        'discover-modals.skip',
        expect.objectContaining({ reason: 'no routes with trigger buttons' }),
      );
    });

    it('skips routes without page models', async () => {
      const sitemap = makeSiteMap([
        { entry: makeRouteEntry('/no-model') },
      ]);
      const page = makeMockPage();
      const logger = makeLogger();

      const result = await discoverModals({
        sitemap,
        page: page as any,
        logger,
      });

      expect(result.routesProbed).toBe(0);
    });
  });

  describe('trigger regex matching', () => {
    it('matches "Add" button label', async () => {
      const model = makePageModel({
        toolbars: [makeActionRef('Add User')],
        bareInteractives: [],
      });
      const sitemap = makeSiteMap([
        { entry: makeRouteEntry('/users'), model },
      ]);
      const page = makeMockPage();
      const logger = makeLogger();

      const result = await discoverModals({
        sitemap,
        page: page as any,
        logger,
      });

      expect(result.routesProbed).toBe(1);
    });

    it('matches "Create" button label', async () => {
      const model = makePageModel({
        toolbars: [makeActionRef('Create Item')],
        bareInteractives: [],
      });
      const sitemap = makeSiteMap([
        { entry: makeRouteEntry('/items'), model },
      ]);
      const page = makeMockPage();
      const logger = makeLogger();

      const result = await discoverModals({
        sitemap,
        page: page as any,
        logger,
      });

      expect(result.routesProbed).toBe(1);
    });

    it('matches "Edit" button label', async () => {
      const model = makePageModel({
        toolbars: [makeActionRef('Edit Profile')],
        bareInteractives: [],
      });
      const sitemap = makeSiteMap([
        { entry: makeRouteEntry('/profile'), model },
      ]);
      const page = makeMockPage();
      const logger = makeLogger();

      const result = await discoverModals({
        sitemap,
        page: page as any,
        logger,
      });

      expect(result.routesProbed).toBe(1);
    });

    it('does not match non-trigger labels', async () => {
      const model = makePageModel({
        toolbars: [makeActionRef('Submit'), makeActionRef('Close')],
        bareInteractives: [makeActionRef('Delete')],
      });
      const sitemap = makeSiteMap([
        { entry: makeRouteEntry('/page'), model },
      ]);
      const page = makeMockPage();
      const logger = makeLogger();

      const result = await discoverModals({
        sitemap,
        page: page as any,
        logger,
      });

      expect(result.routesProbed).toBe(0);
    });

    it('skips disabled buttons', async () => {
      const model = makePageModel({
        toolbars: [makeActionRef('Add User', { disabled: true })],
        bareInteractives: [],
      });
      const sitemap = makeSiteMap([
        { entry: makeRouteEntry('/users'), model },
      ]);
      const page = makeMockPage();
      const logger = makeLogger();

      const result = await discoverModals({
        sitemap,
        page: page as any,
        logger,
      });

      expect(result.routesProbed).toBe(0);
    });
  });

  describe('caps', () => {
    it('respects maxRoutesToProbe cap', async () => {
      const routes = Array.from({ length: 30 }, (_, i) => {
        const model = makePageModel({
          toolbars: [makeActionRef(`Add Item ${i}`)],
          bareInteractives: [],
        });
        return { entry: makeRouteEntry(`/route-${i}`), model };
      });
      const sitemap = makeSiteMap(routes);
      const page = makeMockPage();
      const logger = makeLogger();

      const result = await discoverModals({
        sitemap,
        page: page as any,
        logger,
        maxRoutesToProbe: 5,
      });

      expect(result.routesProbed).toBeLessThanOrEqual(5);
    });
  });

  describe('navigation handling', () => {
    it('continues after navigation failure on a route', async () => {
      const model = makePageModel({
        toolbars: [makeActionRef('Add Item')],
        bareInteractives: [],
      });
      const sitemap = makeSiteMap([
        { entry: makeRouteEntry('/fails'), model },
        { entry: makeRouteEntry('/works'), model },
      ]);
      const page = makeMockPage();
      page.goto.mockRejectedValueOnce(new Error('timeout'))
               .mockResolvedValue(undefined);
      const logger = makeLogger();

      const result = await discoverModals({
        sitemap,
        page: page as any,
        logger,
      });

      // First route fails nav, second succeeds
      expect(result.routesProbed).toBe(1);
    });
  });
});
