/**
 * Tests for test-plan.ts — deterministic test plan generation and event matching.
 *
 * Covers:
 *   - generateTestPlan (heuristic plan from sitemap)
 *   - matchEventToTestPlan (event-driven completion)
 *   - getUncoveredItems
 *   - getPlanSummary
 */

import { describe, expect, it } from 'vitest';
import type { SiteMap } from '../crawler/types.ts';
import type { PageModel } from '../page-model/types.ts';
import {
  generateTestPlan,
  getUncoveredItems,
  getPlanSummary,
  matchEventToTestPlan,
  type TestPlan,
} from './test-plan.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePageModel(overrides: Partial<PageModel> = {}): PageModel {
  return {
    url: 'http://test.local/',
    route: '/',
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
    textHash: 'abc',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSitemap(routes: Record<string, { model: PageModel; title?: string }>): SiteMap {
  const sm: SiteMap = {
    rootUrl: 'http://test.local/',
    startedAt: new Date().toISOString(),
    routes: {},
    pageModels: {},
  };
  for (const [route, config] of Object.entries(routes)) {
    sm.routes[route] = {
      url: `http://test.local${route}`,
      route,
      title: config.title ?? route,
      formIds: config.model.forms.map((f) => f.id),
      tableIds: config.model.tables.map((t) => t.id),
      modalIds: config.model.modals.map((m) => m.id),
      wizardIds: config.model.wizards.map((w) => w.id),
      source: 'crawler',
      discoveredAt: new Date().toISOString(),
      visited: false,
    };
    sm.pageModels[route] = config.model;
  }
  return sm;
}

// ---------------------------------------------------------------------------
// generateTestPlan
// ---------------------------------------------------------------------------

describe('generateTestPlan', () => {
  it('generates items for forms: validation + persistence + error handling', () => {
    const model = makePageModel({
      forms: [
        {
          id: 'form_1',
          name: 'Login',
          fields: [],
          submit: null,
          extraActions: [],
          inModal: false,
        } as never,
      ],
    });
    const sitemap = makeSitemap({ '/login': { model } });
    const plan = generateTestPlan({ sitemap, personas: new Map() });

    const formItems = plan.items.filter((i) => i.targetId === 'form_1');
    // form-validation + form-persistence + error-handling = 3 items per form
    expect(formItems.length).toBeGreaterThanOrEqual(3);
    expect(formItems.some((i) => i.category === 'form-validation')).toBe(true);
    expect(formItems.some((i) => i.category === 'form-persistence')).toBe(true);
    expect(formItems.some((i) => i.category === 'error-handling')).toBe(true);
  });

  it('generates items for tables: sort + pagination + filters', () => {
    const model = makePageModel({
      tables: [
        {
          id: 'tbl_1',
          name: 'Users',
          columns: [],
          rowCount: 10,
          rowActions: [],
          bulkActions: [],
          filters: [{ name: 'Status' }],
          pagination: { locator: '#pager' },
        } as never,
      ],
    });
    const sitemap = makeSitemap({ '/users': { model } });
    const plan = generateTestPlan({ sitemap, personas: new Map() });

    const tableItems = plan.items.filter(
      (i) => i.targetId === 'tbl_1' && i.category === 'table-interaction',
    );
    expect(tableItems.length).toBeGreaterThanOrEqual(3); // sort + pagination + filter
  });

  it('generates accessibility item for every route', () => {
    const sitemap = makeSitemap({
      '/a': { model: makePageModel() },
      '/b': { model: makePageModel() },
    });
    const plan = generateTestPlan({ sitemap, personas: new Map() });
    const a11y = plan.items.filter((i) => i.category === 'accessibility');
    expect(a11y).toHaveLength(2);
    expect(a11y[0]?.suggestedPersona).toBe('sheldon');
  });

  it('generates security items for admin routes', () => {
    const sitemap = makeSitemap({
      '/admin/users': { model: makePageModel(), title: 'Admin Dashboard' },
    });
    const plan = generateTestPlan({ sitemap, personas: new Map() });
    const auth = plan.items.filter((i) => i.category === 'auth-boundary');
    expect(auth.length).toBeGreaterThanOrEqual(1);
  });

  it('generates global security probe items', () => {
    const sitemap = makeSitemap({
      '/': { model: makePageModel() },
    });
    const plan = generateTestPlan({ sitemap, personas: new Map() });
    const security = plan.items.filter((i) => i.category === 'security-probe');
    expect(security.length).toBeGreaterThanOrEqual(3); // header + sensitive path + rate limit
  });

  it('generates data-lifecycle items when forms + tables coexist', () => {
    const model = makePageModel({
      forms: [
        { id: 'form_1', name: 'Add User', fields: [], submit: null, extraActions: [], inModal: false } as never,
      ],
      tables: [
        { id: 'tbl_1', name: 'Users', columns: [], rowCount: 5, rowActions: [], bulkActions: [], filters: [] } as never,
      ],
    });
    const sitemap = makeSitemap({ '/users': { model } });
    const plan = generateTestPlan({ sitemap, personas: new Map() });
    const lifecycle = plan.items.filter((i) => i.category === 'data-lifecycle');
    expect(lifecycle.length).toBeGreaterThanOrEqual(1);
  });

  it('generates wizard items', () => {
    const model = makePageModel({
      wizards: [
        {
          id: 'wiz_1',
          name: 'Onboarding',
          steps: [
            { label: 'Step 1', index: 0, isCurrent: true },
            { label: 'Step 2', index: 1, isCurrent: false },
          ],
        } as never,
      ],
    });
    const sitemap = makeSitemap({ '/onboard': { model } });
    const plan = generateTestPlan({ sitemap, personas: new Map() });
    const wizard = plan.items.filter((i) => i.category === 'wizard-flow');
    expect(wizard.length).toBeGreaterThanOrEqual(2); // walk + back-navigation
  });

  it('generates performance and responsive items per route', () => {
    const sitemap = makeSitemap({
      '/a': { model: makePageModel() },
      '/b': { model: makePageModel() },
    });
    const plan = generateTestPlan({ sitemap, personas: new Map() });
    const perf = plan.items.filter((i) => i.category === 'performance');
    const resp = plan.items.filter((i) => i.category === 'responsive');
    expect(perf).toHaveLength(2);
    expect(resp).toHaveLength(2);
  });

  it('returns empty plan for empty sitemap', () => {
    const sitemap: SiteMap = {
      rootUrl: 'http://test.local/',
      startedAt: '',
      routes: {},
      pageModels: {},
    };
    const plan = generateTestPlan({ sitemap, personas: new Map() });
    expect(plan.items).toHaveLength(0);
    expect(plan.totalItems).toBe(0);
  });

  it('assigns unique ids to all items', () => {
    const model = makePageModel({
      forms: [
        { id: 'f1', name: 'Form', fields: [], submit: null, extraActions: [], inModal: false } as never,
      ],
    });
    const sitemap = makeSitemap({ '/a': { model } });
    const plan = generateTestPlan({ sitemap, personas: new Map() });
    const ids = plan.items.map((i) => i.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// matchEventToTestPlan
// ---------------------------------------------------------------------------

describe('matchEventToTestPlan', () => {
  function makePlan(): TestPlan {
    const model = makePageModel({
      forms: [
        { id: 'f1', name: 'Login', fields: [], submit: null, extraActions: [], inModal: false } as never,
      ],
      tables: [
        { id: 't1', name: 'Users', columns: [], rowCount: 5, rowActions: [], bulkActions: [], filters: [] } as never,
      ],
    });
    const sitemap = makeSitemap({ '/login': { model } });
    return generateTestPlan({ sitemap, personas: new Map() });
  }

  it('matches a form_fuzz_validation event to form-validation items', () => {
    const plan = makePlan();
    const uncoveredBefore = getUncoveredItems(plan).length;
    const matched = matchEventToTestPlan(plan, {
      type: 'playbook.outcome',
      agentId: 'a1',
      playbookName: 'form_fuzz_validation',
      route: '/login',
      targetId: 'f1',
    });
    expect(matched).toBeGreaterThanOrEqual(1);
    expect(getUncoveredItems(plan).length).toBeLessThan(uncoveredBefore);
  });

  it('matches table_sort_each_column to table-interaction items', () => {
    const plan = makePlan();
    const matched = matchEventToTestPlan(plan, {
      type: 'playbook.outcome',
      agentId: 'a1',
      playbookName: 'table_sort_each_column',
      route: '/login',
      targetId: 't1',
    });
    expect(matched).toBeGreaterThanOrEqual(1);
  });

  it('ignores non-playbook.outcome events', () => {
    const plan = makePlan();
    const matched = matchEventToTestPlan(plan, {
      type: 'agent.turn.end',
      agentId: 'a1',
    });
    expect(matched).toBe(0);
  });

  it('does not double-match already-completed items', () => {
    const plan = makePlan();
    matchEventToTestPlan(plan, {
      type: 'playbook.outcome',
      agentId: 'a1',
      playbookName: 'form_fuzz_validation',
      route: '/login',
      targetId: 'f1',
    });
    const matched2 = matchEventToTestPlan(plan, {
      type: 'playbook.outcome',
      agentId: 'a2',
      playbookName: 'form_fuzz_validation',
      route: '/login',
      targetId: 'f1',
    });
    expect(matched2).toBe(0);
  });

  it('records completedBy and completedAt', () => {
    const plan = makePlan();
    matchEventToTestPlan(plan, {
      type: 'playbook.outcome',
      agentId: 'agent-x',
      playbookName: 'form_fuzz_validation',
      route: '/login',
      targetId: 'f1',
    });
    const completed = plan.items.filter((i) => i.completed);
    expect(completed.length).toBeGreaterThan(0);
    expect(completed[0]?.completedBy).toBe('agent-x');
    expect(completed[0]?.completedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// getUncoveredItems / getPlanSummary
// ---------------------------------------------------------------------------

describe('getUncoveredItems', () => {
  it('returns only uncompleted items', () => {
    const plan: TestPlan = {
      items: [
        { id: '1', category: 'form-validation', route: '/a', description: 'd', completed: true },
        { id: '2', category: 'form-validation', route: '/b', description: 'd', completed: false },
      ],
      generatedAt: '',
      totalItems: 2,
    };
    const uncovered = getUncoveredItems(plan);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.id).toBe('2');
  });
});

describe('getPlanSummary', () => {
  it('renders a summary with completion ratio', () => {
    const plan: TestPlan = {
      items: [
        { id: '1', category: 'form-validation', route: '/a', description: 'item 1', completed: true },
        { id: '2', category: 'accessibility', route: '/b', description: 'item 2', completed: false, suggestedPersona: 'sheldon' },
      ],
      generatedAt: '',
      totalItems: 2,
    };
    const summary = getPlanSummary(plan);
    expect(summary).toContain('1/2 items completed');
    expect(summary).toContain('Uncovered (1)');
    expect(summary).toContain('accessibility');
    expect(summary).toContain('sheldon');
  });

  it('does not show uncovered section when all complete', () => {
    const plan: TestPlan = {
      items: [
        { id: '1', category: 'form-validation', route: '/a', description: 'd', completed: true },
      ],
      generatedAt: '',
      totalItems: 1,
    };
    const summary = getPlanSummary(plan);
    expect(summary).toContain('1/1');
    expect(summary).not.toContain('Uncovered');
  });
});
