import { describe, expect, it } from 'vitest';
import type { PageModel } from '../page-model/types.ts';
import { buildRouteEntry, SiteMapImpl } from './sitemap.ts';

function makePageModel(route: string, overrides: Partial<PageModel> = {}): PageModel {
  return {
    url: `https://example.test${route}`,
    route: `https://example.test${route}`,
    title: 'Test',
    forms: [],
    tables: [],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareFields: [],
    bareInteractives: [],
    network: [],
    console: [],
    textHash: '',
    looksBroken: false,
    interactiveCount: 10,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SiteMapImpl', () => {
  it('round-trips upsertRoute → getRoute', () => {
    const sm = new SiteMapImpl({ rootUrl: 'https://example.test/' });
    const entry = buildRouteEntry({
      url: 'https://example.test/clients',
      route: 'https://example.test/clients',
      title: 'Clients',
      formIds: ['form_abc'],
      tableIds: ['table_xyz'],
      modalIds: [],
      wizardIds: [],
      source: 'crawler',
      visited: false,
    });
    sm.upsertRoute(entry, makePageModel('/clients'));

    const fetched = sm.getRoute('https://example.test/clients');
    expect(fetched).toBeDefined();
    expect(fetched?.title).toBe('Clients');
    expect(fetched?.formIds).toEqual(['form_abc']);
    expect(fetched?.tableIds).toEqual(['table_xyz']);
    expect(fetched?.source).toBe('crawler');
  });

  it('upsertRoute preserves discoveredAt for an existing route', () => {
    const sm = new SiteMapImpl({ rootUrl: 'https://example.test/' });
    const initial = buildRouteEntry({
      url: 'https://example.test/x',
      route: 'https://example.test/x',
      title: 'X',
      formIds: [],
      tableIds: [],
      modalIds: [],
      wizardIds: [],
      source: 'crawler',
      visited: false,
      discoveredAt: '2026-01-01T00:00:00.000Z',
    });
    sm.upsertRoute(initial, makePageModel('/x'));

    const updated = buildRouteEntry({
      url: 'https://example.test/x',
      route: 'https://example.test/x',
      title: 'X (updated)',
      formIds: ['form_new'],
      tableIds: [],
      modalIds: [],
      wizardIds: [],
      source: 'agent',
      visited: true,
      discoveredAt: '2030-01-01T00:00:00.000Z',
    });
    sm.upsertRoute(updated, makePageModel('/x'));

    const fetched = sm.getRoute('https://example.test/x');
    expect(fetched?.discoveredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(fetched?.title).toBe('X (updated)');
    expect(fetched?.formIds).toEqual(['form_new']);
    expect(fetched?.source).toBe('agent');
  });

  it('listUnvisitedRoutes returns only routes with visited=false', () => {
    const sm = new SiteMapImpl({ rootUrl: 'https://example.test/' });
    sm.upsertRoute(
      buildRouteEntry({
        url: 'https://example.test/a',
        route: 'https://example.test/a',
        title: 'A',
        formIds: [],
        tableIds: [],
        modalIds: [],
        wizardIds: [],
        source: 'crawler',
        visited: false,
      }),
      makePageModel('/a'),
    );
    sm.upsertRoute(
      buildRouteEntry({
        url: 'https://example.test/b',
        route: 'https://example.test/b',
        title: 'B',
        formIds: [],
        tableIds: [],
        modalIds: [],
        wizardIds: [],
        source: 'crawler',
        visited: false,
      }),
      makePageModel('/b'),
    );

    sm.recordVisit('https://example.test/a');
    const unvisited = sm.listUnvisitedRoutes();
    expect(unvisited.map((r) => r.route)).toEqual(['https://example.test/b']);

    const visited = sm.getRoute('https://example.test/a');
    expect(visited?.visited).toBe(true);
    expect(visited?.visitedAt).toBeTruthy();
  });

  it('listFormsUntested excludes a (playbook,formId) recorded as ok', () => {
    const sm = new SiteMapImpl({ rootUrl: 'https://example.test/' });
    sm.upsertRoute(
      buildRouteEntry({
        url: 'https://example.test/a',
        route: 'https://example.test/a',
        title: 'A',
        formIds: ['form_one', 'form_two'],
        tableIds: [],
        modalIds: [],
        wizardIds: [],
        source: 'crawler',
        visited: false,
      }),
      makePageModel('/a'),
    );

    let untested = sm.listFormsUntested('crud_create_form');
    expect(untested).toHaveLength(2);
    expect(untested.map((u) => u.formId).sort()).toEqual(['form_one', 'form_two']);

    sm.recordPlaybookOutcome('https://example.test/a', 'crud_create_form', 'form_one', 'ok');
    untested = sm.listFormsUntested('crud_create_form');
    expect(untested).toHaveLength(1);
    expect(untested[0]?.formId).toBe('form_two');

    // suspicious also bars retesting.
    sm.recordPlaybookOutcome(
      'https://example.test/a',
      'crud_create_form',
      'form_two',
      'suspicious',
    );
    expect(sm.listFormsUntested('crud_create_form')).toHaveLength(0);

    // A different playbook is still untested.
    expect(sm.listFormsUntested('form_xss_probe')).toHaveLength(2);
  });

  it('failed outcomes do not bar retesting', () => {
    const sm = new SiteMapImpl({ rootUrl: 'https://example.test/' });
    sm.upsertRoute(
      buildRouteEntry({
        url: 'https://example.test/a',
        route: 'https://example.test/a',
        title: 'A',
        formIds: ['form_x'],
        tableIds: [],
        modalIds: [],
        wizardIds: [],
        source: 'crawler',
        visited: false,
      }),
      makePageModel('/a'),
    );

    sm.recordPlaybookOutcome('https://example.test/a', 'crud_create_form', 'form_x', 'failed');
    expect(sm.listFormsUntested('crud_create_form')).toHaveLength(1);
  });

  it('listTablesUntested / listModalsUntested / listWizardsUntested follow the same pattern', () => {
    const sm = new SiteMapImpl({ rootUrl: 'https://example.test/' });
    sm.upsertRoute(
      buildRouteEntry({
        url: 'https://example.test/a',
        route: 'https://example.test/a',
        title: 'A',
        formIds: [],
        tableIds: ['table_a'],
        modalIds: ['modal_a'],
        wizardIds: ['wizard_a'],
        source: 'crawler',
        visited: false,
      }),
      makePageModel('/a'),
    );

    expect(sm.listTablesUntested('table_sort_each_column')).toHaveLength(1);
    expect(sm.listModalsUntested('modal_lifecycle')).toHaveLength(1);
    expect(sm.listWizardsUntested('wizard_full_walkthrough')).toHaveLength(1);

    sm.recordPlaybookOutcome('https://example.test/a', 'table_sort_each_column', 'table_a', 'ok');
    sm.recordPlaybookOutcome('https://example.test/a', 'modal_lifecycle', 'modal_a', 'ok');
    sm.recordPlaybookOutcome('https://example.test/a', 'wizard_full_walkthrough', 'wizard_a', 'ok');

    expect(sm.listTablesUntested('table_sort_each_column')).toHaveLength(0);
    expect(sm.listModalsUntested('modal_lifecycle')).toHaveLength(0);
    expect(sm.listWizardsUntested('wizard_full_walkthrough')).toHaveLength(0);
  });

  it('serialize emits a plain SiteMap object', () => {
    const sm = new SiteMapImpl({
      rootUrl: 'https://example.test/',
      startedAt: '2026-04-26T00:00:00.000Z',
    });
    sm.upsertRoute(
      buildRouteEntry({
        url: 'https://example.test/a',
        route: 'https://example.test/a',
        title: 'A',
        formIds: [],
        tableIds: [],
        modalIds: [],
        wizardIds: [],
        source: 'crawler',
        visited: false,
      }),
      makePageModel('/a'),
    );

    const data = sm.serialize();
    expect(data.startedAt).toBe('2026-04-26T00:00:00.000Z');
    expect(data.rootUrl).toBe('https://example.test/');
    expect(Object.keys(data.routes)).toEqual(['https://example.test/a']);
    expect(Object.keys(data.pageModels)).toEqual(['https://example.test/a']);
  });

  it('listAllRoutes returns shallow copies', () => {
    const sm = new SiteMapImpl({ rootUrl: 'https://example.test/' });
    sm.upsertRoute(
      buildRouteEntry({
        url: 'https://example.test/a',
        route: 'https://example.test/a',
        title: 'A',
        formIds: [],
        tableIds: [],
        modalIds: [],
        wizardIds: [],
        source: 'crawler',
        visited: false,
      }),
      makePageModel('/a'),
    );

    const all = sm.listAllRoutes();
    expect(all).toHaveLength(1);
    const first = all[0];
    expect(first).toBeDefined();
    if (first) first.title = 'mutated';
    const fetched = sm.getRoute('https://example.test/a');
    expect(fetched?.title).toBe('A');
  });
});
