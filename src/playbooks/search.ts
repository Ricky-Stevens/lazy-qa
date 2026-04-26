/**
 * Search playbooks — global search bar exercise, table filter combinations,
 * and saved-view round-trip. Each playbook captures observed result counts as
 * structured evidence so the agent / critic can spot impossible math (a
 * combined filter producing more rows than either single filter).
 */

import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { NetworkAnomaly } from '../page-model/types.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

const ACTION_TIMEOUT_MS = 5_000;

interface AttemptResult {
  ok: boolean;
  detail?: string;
}

async function attempt(fn: () => Promise<void>): Promise<AttemptResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function record(steps: PlaybookStep[], label: string, result: AttemptResult): boolean {
  steps.push({ label, ok: result.ok, detail: result.detail });
  return result.ok;
}

async function safeCount(loc: Locator): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return 0;
  }
}

async function firstAvailableLocator(
  factories: Array<() => Locator>,
): Promise<Locator | null> {
  for (const factory of factories) {
    try {
      const loc = factory().first();
      if ((await safeCount(loc)) > 0) return loc;
    } catch {
      // try next
    }
  }
  return null;
}

function isAnomalous(a: NetworkAnomaly): boolean {
  return a.status >= 400 && a.status < 600;
}

async function freshAnomalies(
  ctx: PlaybookContext,
  sinceMs: number,
): Promise<NetworkAnomaly[]> {
  try {
    const model = await ctx.pageModel();
    return model.network.filter((a) => a.ts >= sinceMs && isAnomalous(a));
  } catch {
    return [];
  }
}

function decide(
  playbookName: string,
  summary: string,
  steps: PlaybookStep[],
  evidence: Record<string, unknown>,
  anomalies: NetworkAnomaly[],
): PlaybookOutcome {
  const anyFail = steps.some((s) => !s.ok);
  if (anyFail) {
    const out = fail(playbookName, summary, evidence, steps);
    out.signals.networkAnomalies = anomalies;
    return out;
  }
  if (anomalies.length > 0) {
    const out = suspicious(
      playbookName,
      `${summary} — ${anomalies.length} HTTP error(s) fired during the run`,
      { ...evidence, anomalies },
      steps,
    );
    out.signals.networkAnomalies = anomalies;
    return out;
  }
  return ok(playbookName, summary, evidence, steps);
}

/** Resolve a global search input. */
async function resolveGlobalSearchInput(page: Page): Promise<Locator | null> {
  return firstAvailableLocator([
    () => page.locator('[role=search] input'),
    () => page.locator('input[aria-label*="search" i]'),
    () => page.locator('input[placeholder*="search" i]'),
    () => page.locator('input[type="search"]'),
  ]);
}

/** Best-effort row count across common table/list shapes. */
async function captureResultCount(page: Page): Promise<number> {
  const selectors = ['tbody tr', '[role=row]:not([aria-rowindex="1"])', '[data-testid*=row]'];
  for (const sel of selectors) {
    const c = await safeCount(page.locator(sel));
    if (c > 0) return c;
  }
  return 0;
}

// ─── global_search ───────────────────────────────────────────────────────────

export interface GlobalSearchInput {
  queries?: string[];
}

const globalSearchShape = {
  queries: z.array(z.string()).optional(),
} satisfies z.ZodRawShape;

const DEFAULT_QUERIES = ['', 'matchnothing-zzz', "'", 'a'.repeat(500)];

export const globalSearch: Playbook<GlobalSearchInput> = {
  name: 'global_search',
  description:
    'Submit a series of probing queries against the top-level search bar (empty / no-match / special char / huge string) and capture the result count for each. Inputs: queries (optional, default mixes empty / garbage / special / oversized).',
  categories: ['search'],
  estimatedDurationMs: 8_000,
  inputShape: globalSearchShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const queries = input.queries ?? DEFAULT_QUERIES;
    const evidence: Record<string, unknown> = {
      queries,
      results: [] as Array<{ query: string; count: number }>,
    };
    const results = evidence.results as Array<{ query: string; count: number }>;

    const search = await resolveGlobalSearchInput(ctx.page);
    if (!search) {
      record(steps, 'locate global search input', {
        ok: false,
        detail: 'no global search input found',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        globalSearch.name,
        'No global search bar was found on the page',
        steps,
        evidence,
        anomalies,
      );
    }
    record(steps, 'locate global search input', { ok: true });

    for (const q of queries) {
      const fillResult = await attempt(async () => {
        await search.fill(q, { timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, `fill query "${q.slice(0, 30)}${q.length > 30 ? '…' : ''}"`, fillResult);
      const submitResult = await attempt(async () => {
        await search.press('Enter', { timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, `submit query "${q.slice(0, 30)}${q.length > 30 ? '…' : ''}"`, submitResult);
      // Tiny settle window for client-side filtering.
      await ctx.page.waitForTimeout(150).catch(() => {});
      const count = await captureResultCount(ctx.page);
      results.push({ query: q, count });
    }

    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      globalSearch.name,
      `Submitted ${queries.length} probing query/queries to the global search bar`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// ─── filter_combinations ─────────────────────────────────────────────────────

export interface FilterCombinationsInput {
  tableId: string;
  filters: Array<{ label: string; value: string }>;
}

const filterCombinationsShape = {
  tableId: z.string(),
  filters: z.array(z.object({ label: z.string(), value: z.string() })),
} satisfies z.ZodRawShape;

export const filterCombinations: Playbook<FilterCombinationsInput> = {
  name: 'filter_combinations',
  description:
    'Apply each filter individually, capture the row count, then apply each pair of filters and verify the combination count is ≤ either individual count. Inputs: tableId, filters (array of {label, value}).',
  categories: ['search', 'table'],
  estimatedDurationMs: 12_000,
  inputShape: filterCombinationsShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      tableId: input.tableId,
      individualCounts: [] as Array<{ label: string; value: string; count: number }>,
      combinationCounts: [] as Array<{
        a: { label: string; value: string };
        b: { label: string; value: string };
        count: number;
        violatesMath: boolean;
      }>,
    };
    const individuals = evidence.individualCounts as Array<{
      label: string;
      value: string;
      count: number;
    }>;
    const combinations = evidence.combinationCounts as Array<{
      a: { label: string; value: string };
      b: { label: string; value: string };
      count: number;
      violatesMath: boolean;
    }>;

    async function applyFilter(label: string, value: string): Promise<AttemptResult> {
      const cssSafe = label.replace(/"/g, '\\"');
      const field = await firstAvailableLocator([
        () => ctx.page.getByLabel(label),
        () => ctx.page.locator(`[name="${cssSafe}"]`),
        () => ctx.page.getByPlaceholder(label),
        () => ctx.page.locator(`[aria-label="${cssSafe}"]`),
      ]);
      if (!field) return { ok: false, detail: 'filter input not found' };
      return attempt(async () => {
        await field.fill(value, { timeout: ACTION_TIMEOUT_MS });
        await field.press('Enter', { timeout: ACTION_TIMEOUT_MS });
      });
    }

    async function clearFilters(): Promise<void> {
      for (const f of input.filters) {
        const cssSafe = f.label.replace(/"/g, '\\"');
        const field = await firstAvailableLocator([
          () => ctx.page.getByLabel(f.label),
          () => ctx.page.locator(`[name="${cssSafe}"]`),
          () => ctx.page.getByPlaceholder(f.label),
          () => ctx.page.locator(`[aria-label="${cssSafe}"]`),
        ]);
        if (field) {
          await field.fill('', { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
          await field.press('Enter', { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
        }
      }
    }

    // Individual filters.
    for (const f of input.filters) {
      await clearFilters();
      const r = await applyFilter(f.label, f.value);
      record(steps, `apply filter ${f.label}=${f.value}`, r);
      await ctx.page.waitForTimeout(150).catch(() => {});
      const count = await captureResultCount(ctx.page);
      individuals.push({ label: f.label, value: f.value, count });
    }

    // Pairs.
    let violations = 0;
    for (let i = 0; i < input.filters.length; i++) {
      for (let j = i + 1; j < input.filters.length; j++) {
        await clearFilters();
        const a = input.filters[i];
        const b = input.filters[j];
        const r1 = await applyFilter(a.label, a.value);
        record(steps, `apply filter (combo) ${a.label}=${a.value}`, r1);
        const r2 = await applyFilter(b.label, b.value);
        record(steps, `apply filter (combo) ${b.label}=${b.value}`, r2);
        await ctx.page.waitForTimeout(150).catch(() => {});
        const comboCount = await captureResultCount(ctx.page);
        const aCount = individuals[i].count;
        const bCount = individuals[j].count;
        const violatesMath = comboCount > Math.min(aCount, bCount);
        if (violatesMath) violations += 1;
        combinations.push({ a, b, count: comboCount, violatesMath });
      }
    }
    evidence.violations = violations;

    const anomalies = await freshAnomalies(ctx, startedAt);
    if (violations > 0) {
      const out = suspicious(
        filterCombinations.name,
        `Filter combinations on ${input.tableId}: ${violations} pair(s) returned more rows than either single filter`,
        evidence,
        steps,
      );
      out.signals.networkAnomalies = anomalies;
      return out;
    }
    return decide(
      filterCombinations.name,
      `Filter combinations on ${input.tableId}: no math violations`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// ─── saved_views ─────────────────────────────────────────────────────────────

export interface SavedViewsInput {
  tableId: string;
  viewName: string;
}

const savedViewsShape = {
  tableId: z.string(),
  viewName: z.string(),
} satisfies z.ZodRawShape;

export const savedViews: Playbook<SavedViewsInput> = {
  name: 'saved_views',
  description:
    'Save the current filter set as a named view, reload, and verify the view restored the filter values. Inputs: tableId, viewName.',
  categories: ['search', 'table'],
  estimatedDurationMs: 10_000,
  inputShape: savedViewsShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      tableId: input.tableId,
      viewName: input.viewName,
    };

    const beforeCount = await captureResultCount(ctx.page);
    evidence.rowCountBeforeSave = beforeCount;

    const saveBtn = await firstAvailableLocator([
      () => ctx.page.getByRole('button', { name: 'Save view' }),
      () => ctx.page.getByRole('button', { name: 'Save filter' }),
      () => ctx.page.getByRole('button', { name: 'Save filters' }),
      () => ctx.page.getByRole('button', { name: 'Save' }),
    ]);
    if (!saveBtn) {
      record(steps, 'click Save view', {
        ok: false,
        detail: 'no Save view / Save filter button found',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        savedViews.name,
        `No Save view affordance found on ${input.tableId}`,
        steps,
        evidence,
        anomalies,
      );
    }
    const clickResult = await attempt(async () => {
      await saveBtn.click({ timeout: ACTION_TIMEOUT_MS });
    });
    record(steps, 'click Save view', clickResult);

    // If a name input appears, fill it.
    const nameInput = await firstAvailableLocator([
      () => ctx.page.getByLabel('View name'),
      () => ctx.page.getByPlaceholder('View name'),
      () => ctx.page.locator('[name="viewName"]'),
      () => ctx.page.locator('[name="name"]'),
    ]);
    if (nameInput) {
      const fillResult = await attempt(async () => {
        await nameInput.fill(input.viewName, { timeout: ACTION_TIMEOUT_MS });
        await nameInput.press('Enter', { timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'name the view', fillResult);
    }

    // Reload.
    const reloadResult = await attempt(async () => {
      await ctx.page.reload({ timeout: ACTION_TIMEOUT_MS });
    });
    record(steps, 'reload', reloadResult);

    const afterCount = await captureResultCount(ctx.page);
    evidence.rowCountAfterReload = afterCount;
    const restored = afterCount === beforeCount;
    evidence.viewRestored = restored;

    const anomalies = await freshAnomalies(ctx, startedAt);
    const summary = restored
      ? `Saved view "${input.viewName}" appears restored after reload (${afterCount} rows)`
      : `Saved view "${input.viewName}" did not restore the row count after reload (before=${beforeCount}, after=${afterCount})`;
    if (!restored) {
      const out = suspicious(savedViews.name, summary, evidence, steps);
      out.signals.networkAnomalies = anomalies;
      return out;
    }
    return decide(savedViews.name, summary, steps, evidence, anomalies);
  },
};

// ─── Registration ───────────────────────────────────────────────────────────

export function registerSearchPlaybooks(r: PlaybookRegistry): void {
  r.register(globalSearch);
  r.register(filterCombinations);
  r.register(savedViews);
}
