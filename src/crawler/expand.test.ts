/**
 * Tests for expand.ts — expandRoute function: idempotent upsert,
 * visit recording, affordance probing, and new route creation.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PageModel } from '../page-model/types.ts';
import type { RouteEntry, SiteMapAccessor } from './types.ts';
import type { Logger } from '../logging/logger.ts';

// ---------------------------------------------------------------------------
// Mocks — must be declared before module import
// ---------------------------------------------------------------------------

// We mock both parsePage and probeAffordances since they require real browser
vi.mock('../page-model/parser.ts', () => ({
  parsePage: vi.fn().mockResolvedValue({
    url: 'http://localhost:3000/new-page',
    route: '/new-page',
    title: 'New Page',
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
    textHash: 'abc',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
  } satisfies PageModel),
}));

vi.mock('./affordance-probe.ts', () => ({
  probeAffordances: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Route entries use full-origin keys (deriveRoute normalizes to origin+pathname). */
function makeRouteEntry(route: string, overrides: Partial<RouteEntry> = {}): RouteEntry {
  return {
    url: route,
    route,
    title: 'Page',
    formIds: [],
    tableIds: [],
    modalIds: [],
    wizardIds: [],
    source: 'crawler',
    visited: false,
    affordancesProbed: false,
    ...overrides,
  } as RouteEntry;
}

function makePageModel(): PageModel {
  return {
    url: 'http://localhost:3000/page',
    route: '/page',
    title: 'Page',
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
    textHash: 'abc',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
  };
}

function makeSiteMap(
  existingRoutes: Map<string, { entry: RouteEntry; model: PageModel | null }> = new Map(),
): SiteMapAccessor {
  return {
    getRoute: vi.fn().mockImplementation((r: string) => existingRoutes.get(r)?.entry ?? null),
    getPageModel: vi.fn().mockImplementation((r: string) => existingRoutes.get(r)?.model ?? null),
    recordVisit: vi.fn(),
    upsertRoute: vi.fn(),
    listAllRoutes: vi.fn().mockReturnValue([]),
    listFormsUntested: vi.fn().mockReturnValue([]),
    listTablesUntested: vi.fn().mockReturnValue([]),
    listModalsUntested: vi.fn().mockReturnValue([]),
    listWizardsUntested: vi.fn().mockReturnValue([]),
  } as unknown as SiteMapAccessor;
}

function makeMockPage() {
  return {
    url: vi.fn().mockReturnValue('http://localhost:3000/new-page'),
  };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('expandRoute', () => {
  it('records visit for existing route', async () => {
    const { expandRoute } = await import('./expand.ts');
    const fullRoute = 'http://localhost:3000/existing';
    const entry = makeRouteEntry(fullRoute, { visited: true, affordancesProbed: true });
    const siteMap = makeSiteMap(new Map([[fullRoute, { entry, model: null }]]));
    const page = makeMockPage();

    const result = await expandRoute(
      siteMap,
      page as any,
      fullRoute,
      { probe: false },
    );

    expect(siteMap.recordVisit).toHaveBeenCalled();
    expect(result.route).toBe(fullRoute);
  });

  it('creates new route entry for unknown route', async () => {
    const { expandRoute } = await import('./expand.ts');
    const siteMap = makeSiteMap();
    const page = makeMockPage();

    const result = await expandRoute(
      siteMap,
      page as any,
      'http://localhost:3000/new-page',
      { probe: false },
    );

    expect(siteMap.upsertRoute).toHaveBeenCalled();
    expect(result.source).toBe('agent');
    expect(result.visited).toBe(true);
  });

  it('sets affordancesProbed=true when probe is enabled for new route', async () => {
    const { expandRoute } = await import('./expand.ts');
    const siteMap = makeSiteMap();
    const page = makeMockPage();

    const result = await expandRoute(
      siteMap,
      page as any,
      'http://localhost:3000/new-page',
      { probe: true },
    );

    expect(result.affordancesProbed).toBe(true);
  });

  it('sets affordancesProbed=false when probe is disabled for new route', async () => {
    const { expandRoute } = await import('./expand.ts');
    const siteMap = makeSiteMap();
    const page = makeMockPage();

    const result = await expandRoute(
      siteMap,
      page as any,
      'http://localhost:3000/new-page',
      { probe: false },
    );

    expect(result.affordancesProbed).toBe(false);
  });

  it('probes existing route that lacks affordance data', async () => {
    const { expandRoute } = await import('./expand.ts');
    const fullRoute = 'http://localhost:3000/needs-probe';
    const entry = makeRouteEntry(fullRoute, { visited: true, affordancesProbed: false });
    const model = makePageModel();
    const siteMap = makeSiteMap(new Map([[fullRoute, { entry, model }]]));
    const page = makeMockPage();

    const result = await expandRoute(
      siteMap,
      page as any,
      fullRoute,
      { probe: true, logger: makeLogger() },
    );

    // Should have upserted with affordancesProbed: true
    expect(siteMap.upsertRoute).toHaveBeenCalled();
    const upsertCall = (siteMap.upsertRoute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(upsertCall[0]).toHaveProperty('affordancesProbed', true);
  });

  it('does not re-probe existing route already probed', async () => {
    const { expandRoute } = await import('./expand.ts');
    const fullRoute = 'http://localhost:3000/already-probed';
    const entry = makeRouteEntry(fullRoute, { visited: true, affordancesProbed: true });
    const siteMap = makeSiteMap(new Map([[fullRoute, { entry, model: null }]]));
    const page = makeMockPage();

    await expandRoute(
      siteMap,
      page as any,
      fullRoute,
      { probe: true },
    );

    // Should NOT have called upsertRoute (no probe needed)
    expect(siteMap.upsertRoute).not.toHaveBeenCalled();
  });

  it('defaults probe to true', async () => {
    const { expandRoute } = await import('./expand.ts');
    const siteMap = makeSiteMap();
    const page = makeMockPage();

    const result = await expandRoute(
      siteMap,
      page as any,
      'http://localhost:3000/new-page',
    );

    expect(result.affordancesProbed).toBe(true);
  });
});
