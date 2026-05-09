/**
 * Test Plan generator. After crawl + Application Model, produces a structured
 * checklist of what needs testing. The supervisor tracks completion and spawns
 * agents to fill gaps.
 *
 * The plan is a waterfall-style list: each item has a category, route, target,
 * suggested persona, and completion status. The supervisor periodically checks
 * the plan against the event stream and spawns gap-filling agents when items
 * remain uncovered.
 */

import type { SiteMap } from '../crawler/types.ts';
import type { PageModel } from '../page-model/types.ts';
import type { Skill } from '../skills/loader.ts';
import type { ApplicationModel } from './app-model.ts';

export type TestCategory =
  | 'form-validation'
  | 'form-persistence'
  | 'table-interaction'
  | 'navigation'
  | 'security-probe'
  | 'accessibility'
  | 'auth-boundary'
  | 'error-handling'
  | 'data-persistence'
  | 'modal-lifecycle'
  | 'wizard-flow'
  | 'data-lifecycle'
  | 'performance'
  | 'responsive';

export interface TestPlanItem {
  id: string;
  category: TestCategory;
  route: string;
  description: string;
  targetId?: string;
  suggestedPersona?: string;
  completed: boolean;
  completedBy?: string;
  completedAt?: string;
}

export interface TestPlan {
  items: TestPlanItem[];
  generatedAt: string;
  totalItems: number;
}

const FORM_PERSONAS: Record<string, string> = {
  'form-validation': 'all-your-base',
  'form-persistence': 'mulder',
  'error-handling': 'wreck-it-ralph',
};

const TABLE_PERSONA = 'karen';
const ACCESSIBILITY_PERSONA = 'sheldon';
const SECURITY_PERSONAS = ['bobby-tables', 'zero-cool', 'johnny-five'];

/**
 * Generate a test plan deterministically from the sitemap and page models.
 * No LLM call — pure heuristic analysis of the crawled surface.
 */
export function generateTestPlan(opts: {
  sitemap: SiteMap;
  appModel?: ApplicationModel;
  personas: Map<string, Skill>;
}): TestPlan {
  const items: TestPlanItem[] = [];
  let nextId = 1;

  function addItem(
    category: TestCategory,
    route: string,
    description: string,
    targetId?: string,
    suggestedPersona?: string,
  ) {
    items.push({
      id: `tp-${String(nextId++).padStart(3, '0')}`,
      category,
      route,
      description,
      targetId,
      suggestedPersona,
      completed: false,
    });
  }

  for (const [route, entry] of Object.entries(opts.sitemap.routes)) {
    const model: PageModel | undefined = opts.sitemap.pageModels[route];
    if (!model) continue;

    for (const form of model.forms) {
      addItem(
        'form-validation',
        route,
        `Fuzz form '${form.name}' with boundary values and invalid input`,
        form.id,
        FORM_PERSONAS['form-validation'],
      );
      addItem(
        'form-persistence',
        route,
        `Fill form '${form.name}', submit, navigate away, return, verify data persisted`,
        form.id,
        FORM_PERSONAS['form-persistence'],
      );
      addItem(
        'error-handling',
        route,
        `Submit form '${form.name}' with empty/invalid data, verify error messages are clear and specific`,
        form.id,
        FORM_PERSONAS['error-handling'],
      );
    }

    for (const table of model.tables) {
      addItem(
        'table-interaction',
        route,
        `Test table '${table.name}': sort each column, verify row order changes`,
        table.id,
        TABLE_PERSONA,
      );
      if (table.pagination) {
        addItem(
          'table-interaction',
          route,
          `Test table '${table.name}' pagination: walk all pages, verify row counts`,
          table.id,
          TABLE_PERSONA,
        );
      }
      if (table.filters.length > 0) {
        addItem(
          'table-interaction',
          route,
          `Test table '${table.name}' filters: apply each filter, verify row filtering`,
          table.id,
          TABLE_PERSONA,
        );
      }
    }

    // Modal lifecycle — test open/close for each modal on this route.
    for (const modal of model.modals) {
      addItem(
        'modal-lifecycle',
        route,
        `Test modal '${modal.name}' lifecycle: open, verify content, close via Escape and close button`,
        modal.id,
        FORM_PERSONAS['form-validation'],
      );
      if (modal.form) {
        addItem(
          'modal-lifecycle',
          route,
          `Test modal '${modal.name}' form: fill fields, submit, verify success feedback`,
          modal.form.id,
          FORM_PERSONAS['form-persistence'],
        );
      }
    }

    // Wizard flow — walk each wizard's steps end-to-end.
    for (const wizard of model.wizards) {
      addItem(
        'wizard-flow',
        route,
        `Walk wizard '${wizard.name}' end-to-end: complete each step, verify final submission`,
        wizard.id,
        FORM_PERSONAS['form-persistence'],
      );
      if (wizard.steps.length > 1) {
        addItem(
          'wizard-flow',
          route,
          `Test wizard '${wizard.name}' back-navigation: walk forward, then back, verify state preserved`,
          wizard.id,
          FORM_PERSONAS['form-validation'],
        );
      }
    }

    // Data lifecycle — routes with both forms AND tables suggest CRUD.
    // Add a create-and-verify item: fill the form, submit, verify the
    // new record appears in the table.
    if (model.forms.length > 0 && model.tables.length > 0) {
      const primaryForm = model.forms[0];
      const primaryTable = model.tables[0];
      if (primaryForm && primaryTable) {
        addItem(
          'data-lifecycle',
          route,
          `CRUD lifecycle: fill form '${primaryForm.name}', submit, verify new record appears in table '${primaryTable.name}'`,
          primaryForm.id,
          FORM_PERSONAS['form-persistence'],
        );
      }
    }

    // Data lifecycle — modals with forms paired with a table on the same
    // route also suggest CRUD (the "Add" button opens a modal form, the
    // table shows the results).
    if (model.tables.length > 0) {
      for (const modal of model.modals) {
        if (modal.form) {
          addItem(
            'data-lifecycle',
            route,
            `CRUD lifecycle: open modal '${modal.name}', fill form, submit, verify new record in table '${model.tables[0]?.name}'`,
            modal.form.id,
            FORM_PERSONAS['form-persistence'],
          );
        }
      }
    }

    addItem(
      'accessibility',
      route,
      `Accessibility audit: check ARIA labels, tab order, heading hierarchy, keyboard navigation`,
      undefined,
      ACCESSIBILITY_PERSONA,
    );

    if (entry.title?.toLowerCase().includes('admin') || route.toLowerCase().includes('admin')) {
      addItem(
        'auth-boundary',
        route,
        `Test admin route access controls: verify non-admin users get 403/redirect`,
        undefined,
        SECURITY_PERSONAS[0],
      );
    }
  }

  const routes = Object.keys(opts.sitemap.routes);
  if (routes.length > 0) {
    addItem(
      'security-probe',
      routes[0] ?? '/',
      'Run header_audit: check security headers (CSP, HSTS, X-Frame-Options, cookie flags)',
      undefined,
      SECURITY_PERSONAS[2],
    );
    addItem(
      'security-probe',
      routes[0] ?? '/',
      'Run sensitive_path_audit: check for exposed admin/debug/config endpoints',
      undefined,
      SECURITY_PERSONAS[2],
    );
    addItem(
      'security-probe',
      routes[0] ?? '/',
      'Run rate_limit_probe on login and key API endpoints — verify 429 enforcement',
      undefined,
      SECURITY_PERSONAS[2],
    );
  }

  // Performance and responsive checks — one per distinct route.
  for (const route of routes) {
    addItem(
      'performance',
      route,
      `Measure Web Vitals (LCP, CLS, FCP, TTFB) on ${route}`,
      undefined,
      undefined,
    );
    addItem(
      'responsive',
      route,
      `Test responsive layout at mobile and tablet viewports on ${route}`,
      undefined,
      undefined,
    );
  }

  const idRoutes = routes.filter((r) => /\/\d+|\/[0-9a-f]{8}-[0-9a-f]{4}/.test(r));
  for (const route of idRoutes.slice(0, 10)) {
    addItem(
      'auth-boundary',
      route,
      `IDOR probe: test access to other users' resources by modifying the ID segment`,
      undefined,
      SECURITY_PERSONAS[0],
    );
  }

  return {
    items,
    generatedAt: new Date().toISOString(),
    totalItems: items.length,
  };
}

/**
 * Match an event from events.jsonl to test plan items and mark as completed.
 * Returns the number of items newly completed.
 */
export function matchEventToTestPlan(
  plan: TestPlan,
  event: {
    type: string;
    agentId?: string;
    playbookName?: string;
    route?: string;
    targetId?: string;
  },
): number {
  if (event.type !== 'playbook.outcome') return 0;

  let matched = 0;
  for (const item of plan.items) {
    if (item.completed) continue;

    const routeMatch = !item.route || event.route === item.route;
    const targetMatch = !item.targetId || event.targetId === item.targetId;

    if (!routeMatch || !targetMatch) continue;

    let categoryMatch = false;
    switch (event.playbookName) {
      case 'form_fuzz_validation':
      case 'form_required_field_check':
        categoryMatch = item.category === 'form-validation';
        break;
      case 'form_persistence_roundtrip':
      case 'fill_and_verify':
        categoryMatch = item.category === 'form-persistence' || item.category === 'data-lifecycle';
        break;
      case 'form_double_submit':
        categoryMatch = item.category === 'form-validation' || item.category === 'error-handling';
        break;
      case 'table_sort_each_column':
      case 'walk_pagination':
        categoryMatch = item.category === 'table-interaction';
        break;
      case 'header_audit':
      case 'sensitive_path_audit':
      case 'route_404_probe':
      case 'rate_limit_probe':
        categoryMatch = item.category === 'security-probe';
        break;
      case 'idor_probe':
        categoryMatch = item.category === 'auth-boundary';
        break;
      // No dedicated modal playbook exists — modal interactions are exercised
      // via discover_route_affordances or direct browser primitives. Match
      // discover_route_affordances to modal-lifecycle since it probes modals.
      case 'discover_route_affordances':
        categoryMatch = item.category === 'modal-lifecycle' || item.category === 'wizard-flow';
        break;
      case 'walk_wizard':
        categoryMatch = item.category === 'wizard-flow';
        break;
      case 'perf_web_vitals':
        categoryMatch = item.category === 'performance';
        break;
      case 'responsive_check':
        categoryMatch = item.category === 'responsive';
        break;
    }

    if (categoryMatch) {
      item.completed = true;
      item.completedBy = event.agentId;
      item.completedAt = new Date().toISOString();
      matched++;
    }
  }
  return matched;
}

export function getUncoveredItems(plan: TestPlan): TestPlanItem[] {
  return plan.items.filter((item) => !item.completed);
}

export function getPlanSummary(plan: TestPlan): string {
  const total = plan.items.length;
  const completed = plan.items.filter((i) => i.completed).length;
  const uncovered = getUncoveredItems(plan);

  const lines = [`Test plan: ${completed}/${total} items completed`];
  if (uncovered.length > 0) {
    lines.push(`Uncovered (${uncovered.length}):`);
    for (const item of uncovered.slice(0, 10)) {
      lines.push(
        `  - [${item.category}] ${item.description} (route: ${item.route}, suggest: ${item.suggestedPersona ?? 'any'})`,
      );
    }
    if (uncovered.length > 10) {
      lines.push(`  ... and ${uncovered.length - 10} more`);
    }
  }
  return lines.join('\n');
}
