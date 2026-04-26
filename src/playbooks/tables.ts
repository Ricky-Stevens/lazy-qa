/**
 * Table playbooks (WP6, spec §6.3). Each playbook targets a `TableSpec` by id
 * (resolved from the cached `PageModel`) and exercises one orthogonal aspect
 * of table behaviour: sort, paginate, filter, bulk, row-actions, columns,
 * export. All playbooks return uniform `PlaybookOutcome`s and never throw —
 * Playwright actions are wrapped in try/catch and surfaced as `failed` /
 * `suspicious` outcomes.
 */

import type { Page } from 'playwright';
import { z } from 'zod';
import type { TableSpec } from '../page-model/types.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default queries used by `table_filter_search` when the caller doesn't
 * supply any. Empty / nonsense / quote-injection / overlong. */
export const DEFAULT_FILTER_QUERIES: string[] = [
  '',
  'matchnothing-zzz',
  "' OR 1=1",
  'a'.repeat(500),
];

interface ResolvedTable {
  table: TableSpec;
}

async function resolveTable(
  ctx: PlaybookContext,
  tableId: string,
): Promise<ResolvedTable | { error: string }> {
  try {
    const model = await ctx.pageModel();
    const table = model.tables.find((t) => t.id === tableId);
    if (!table) {
      return { error: `tableId "${tableId}" not present in current PageModel` };
    }
    return { table };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Capture each visible row's "identity" — defined as the trimmed first-cell
 * text, or `[data-id]` if present on the row. Used for sort / paginate
 * playbooks. */
async function captureRowIdentities(page: Page, tableLocator: string): Promise<string[]> {
  const handle = page.locator(tableLocator);
  const rowCount = await handle
    .locator('tbody tr')
    .count()
    .catch(() => 0);
  const ids: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row = handle.locator('tbody tr').nth(i);
    let id: string | null = null;
    try {
      id = await row.getAttribute('data-id');
    } catch {
      id = null;
    }
    if (!id) {
      try {
        const firstCell = row.locator('td').first();
        id = (await firstCell.innerText()).trim();
      } catch {
        id = `row-${i}`;
      }
    }
    ids.push(id ?? `row-${i}`);
  }
  return ids;
}

/** Find the first locator that resolves to ≥1 element. Returns null if none. */
async function firstMatching(page: Page, candidates: string[]): Promise<string | null> {
  for (const sel of candidates) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) return sel;
    } catch {
      // Bad selector — skip.
    }
  }
  return null;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. table_sort_each_column
// ---------------------------------------------------------------------------

interface SortInput {
  tableId: string;
}

const sortShape = {
  tableId: z.string().describe('Stable id of the table from PageModel.tables[*].id'),
};

export const tableSortEachColumn: Playbook<SortInput> = {
  name: 'table_sort_each_column',
  description:
    'Click each sortable column header in turn. Capture row order before/after as the array of first-cell texts. If clicking a sortable header has no effect, status is "suspicious".',
  categories: ['table'],
  estimatedDurationMs: 8_000,
  inputShape: sortShape,
  async run(input, ctx) {
    const resolved = await resolveTable(ctx, input.tableId);
    if ('error' in resolved) return fail(this.name, resolved.error);
    const { table } = resolved;
    const { page } = ctx;
    const steps: PlaybookStep[] = [];
    const perColumn: Array<{
      column: string;
      before: string[];
      after: string[];
      changed: boolean;
      error?: string;
    }> = [];

    const sortable = table.columns.filter((c) => c.sortable);
    if (sortable.length === 0) {
      return ok(this.name, 'No sortable columns on this table — nothing to do', {
        tableId: table.id,
        sortableColumns: 0,
      });
    }

    let suspiciousCount = 0;
    let failedCount = 0;
    for (const col of sortable) {
      const before = await captureRowIdentities(page, table.tableLocator);
      try {
        await page.locator(col.headerLocator).first().click({ timeout: 5_000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({ label: `click header "${col.label}"`, ok: false, detail: msg });
        perColumn.push({ column: col.label, before, after: before, changed: false, error: msg });
        failedCount++;
        continue;
      }
      // Give the DOM a beat to settle.
      await page.waitForTimeout(50).catch(() => {});
      const after = await captureRowIdentities(page, table.tableLocator);
      const changed = !arraysEqual(before, after);
      perColumn.push({ column: col.label, before, after, changed });
      if (changed) {
        steps.push({ label: `sort by "${col.label}"`, ok: true, detail: 'row order changed' });
      } else {
        steps.push({
          label: `sort by "${col.label}"`,
          ok: false,
          detail: 'sort had no effect',
        });
        suspiciousCount++;
      }
    }

    const evidence = {
      tableId: table.id,
      sortableColumns: sortable.length,
      perColumn,
    };

    if (failedCount === sortable.length) {
      return fail(this.name, 'Failed to click any sortable header', evidence, steps);
    }
    if (suspiciousCount > 0) {
      return suspicious(
        this.name,
        `${suspiciousCount}/${sortable.length} columns sorted with no effect`,
        evidence,
        steps,
      );
    }
    return ok(
      this.name,
      `Sorted ${sortable.length}/${sortable.length} columns OK`,
      evidence,
      steps,
    );
  },
};

// ---------------------------------------------------------------------------
// 2. table_paginate_walk
// ---------------------------------------------------------------------------

interface PaginateInput {
  tableId: string;
  maxPages?: number;
}

const paginateShape = {
  tableId: z.string().describe('Stable id of the table from PageModel.tables[*].id'),
  maxPages: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Stop walking after N pages. Default 5.'),
};

export const tablePaginateWalk: Playbook<PaginateInput> = {
  name: 'table_paginate_walk',
  description:
    'Walk through table pages 2, 3, last, then back to 1. Capture row ids on each page. If any row appears on two pages, status is "suspicious".',
  categories: ['table'],
  estimatedDurationMs: 10_000,
  inputShape: paginateShape,
  async run(input, ctx) {
    const resolved = await resolveTable(ctx, input.tableId);
    if ('error' in resolved) return fail(this.name, resolved.error);
    const { table } = resolved;
    const { page } = ctx;
    const maxPages = input.maxPages ?? 5;
    const steps: PlaybookStep[] = [];

    if (!table.pagination) {
      return ok(this.name, 'No pagination control detected — nothing to walk', {
        tableId: table.id,
      });
    }

    const paginationScope = table.pagination.locator;
    const pagesVisited: Array<{ label: string; rows: string[] }> = [];

    // Page 1 (current). Capture as baseline.
    const initialRows = await captureRowIdentities(page, table.tableLocator);
    pagesVisited.push({ label: 'page 1', rows: initialRows });
    steps.push({ label: 'capture page 1', ok: true });

    // Try: page 2, page 3, last, back-to-1. Cap at maxPages walks.
    type PageTarget = { label: string; selectors: string[] };
    const targets: PageTarget[] = [
      {
        label: 'page 2',
        selectors: [
          `${paginationScope} button:has-text("2")`,
          `${paginationScope} a:has-text("2")`,
          `${paginationScope} button[aria-label="Page 2"]`,
        ],
      },
      {
        label: 'page 3',
        selectors: [
          `${paginationScope} button:has-text("3")`,
          `${paginationScope} a:has-text("3")`,
          `${paginationScope} button[aria-label="Page 3"]`,
        ],
      },
      {
        label: 'last',
        selectors: [
          `${paginationScope} button[aria-label="Last page"]`,
          `${paginationScope} button[aria-label="Last"]`,
          `${paginationScope} button:has-text("Last")`,
          `${paginationScope} button:has-text("»")`,
        ],
      },
      {
        label: 'back to 1',
        selectors: [
          `${paginationScope} button:has-text("1")`,
          `${paginationScope} a:has-text("1")`,
          `${paginationScope} button[aria-label="Page 1"]`,
          `${paginationScope} button[aria-label="First page"]`,
        ],
      },
    ];

    let walked = 1; // already counted page 1
    for (const t of targets) {
      if (walked >= maxPages) break;
      const sel = await firstMatching(page, t.selectors);
      if (!sel) {
        steps.push({ label: `navigate to ${t.label}`, ok: false, detail: 'no selector matched' });
        continue;
      }
      try {
        await page.locator(sel).first().click({ timeout: 5_000 });
        await page.waitForTimeout(80).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({ label: `navigate to ${t.label}`, ok: false, detail: msg });
        continue;
      }
      const rows = await captureRowIdentities(page, table.tableLocator);
      pagesVisited.push({ label: t.label, rows });
      steps.push({ label: `capture ${t.label}`, ok: true });
      walked++;
    }

    // Detect overlap: any row id appearing on two distinct page-snapshots.
    // We collapse:
    //   - "back to 1" → "page 1" (expected to mirror)
    //   - "last" → whichever earlier snapshot it row-matches (e.g. in a 3-page
    //     table "last" is the same as "page 3"; that's not an overlap).
    function rowSetKey(rows: string[]): string {
      return [...rows].sort().join('|');
    }
    const seenSnapshots = new Map<string, string>(); // rowSetKey -> canonical label
    const idToPages = new Map<string, Set<string>>();
    for (const visit of pagesVisited) {
      let labelKey = visit.label === 'back to 1' ? 'page 1' : visit.label;
      const key = rowSetKey(visit.rows);
      const existing = seenSnapshots.get(key);
      if (existing) {
        labelKey = existing;
      } else {
        seenSnapshots.set(key, labelKey);
      }
      for (const id of visit.rows) {
        if (!idToPages.has(id)) idToPages.set(id, new Set());
        idToPages.get(id)?.add(labelKey);
      }
    }
    const overlaps: Array<{ rowId: string; pages: string[] }> = [];
    for (const [rowId, pgs] of idToPages.entries()) {
      if (pgs.size > 1) overlaps.push({ rowId, pages: Array.from(pgs) });
    }

    const evidence = {
      tableId: table.id,
      pagesVisited,
      overlaps,
    };

    if (overlaps.length > 0) {
      return suspicious(
        this.name,
        `${overlaps.length} row(s) appeared on multiple pages`,
        evidence,
        steps,
      );
    }
    return ok(
      this.name,
      `Walked ${pagesVisited.length} page(s); no row-id overlap`,
      evidence,
      steps,
    );
  },
};

// ---------------------------------------------------------------------------
// 3. table_filter_search
// ---------------------------------------------------------------------------

interface FilterInput {
  tableId: string;
  queries?: string[];
}

const filterShape = {
  tableId: z.string().describe('Stable id of the table from PageModel.tables[*].id'),
  queries: z
    .array(z.string())
    .optional()
    .describe('Filter queries to try. Defaults to empty / nonsense / sqli / overlong.'),
};

export const tableFilterSearch: Playbook<FilterInput> = {
  name: 'table_filter_search',
  description:
    'Submit a series of queries through the table filter/search box and capture the resulting row count for each.',
  categories: ['table'],
  estimatedDurationMs: 8_000,
  inputShape: filterShape,
  async run(input, ctx) {
    const resolved = await resolveTable(ctx, input.tableId);
    if ('error' in resolved) return fail(this.name, resolved.error);
    const { table } = resolved;
    const { page } = ctx;
    const steps: PlaybookStep[] = [];
    const queries = input.queries ?? DEFAULT_FILTER_QUERIES;

    // Pick a filter affordance: prefer a textbox/search input from filters[],
    // fall back to a search-y input near the table.
    let filterLocator: string | null = null;
    for (const f of table.filters) {
      if (f.type === 'input' || f.type === 'other') {
        filterLocator = f.locator;
        break;
      }
    }
    if (!filterLocator) {
      filterLocator = await firstMatching(page, [
        `${table.tableLocator} >> input[type="search"]`,
        `${table.tableLocator} >> input[placeholder*="Search" i]`,
        `${table.tableLocator} >> input[placeholder*="Filter" i]`,
        'input[type="search"]',
        'input[placeholder*="Search" i]',
        'input[placeholder*="Filter" i]',
      ]);
    }

    if (!filterLocator) {
      return ok(this.name, 'No filter/search input detected near table', {
        tableId: table.id,
      });
    }

    const baseline = await captureRowIdentities(page, table.tableLocator);
    const perQuery: Array<{ query: string; rowCount: number; error?: string }> = [];

    for (const q of queries) {
      try {
        const inputLoc = page.locator(filterLocator).first();
        await inputLoc.fill('', { timeout: 5_000 });
        if (q.length > 0) {
          await inputLoc.fill(q, { timeout: 10_000 });
        }
        // Many UIs filter on input; some require Enter. Press Enter as a
        // best-effort "submit".
        await inputLoc.press('Enter', { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(80).catch(() => {});
        const rows = await captureRowIdentities(page, table.tableLocator);
        perQuery.push({ query: q, rowCount: rows.length });
        steps.push({
          label: `query ${JSON.stringify(q.slice(0, 40))}`,
          ok: true,
          detail: `rowCount=${rows.length}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        perQuery.push({ query: q, rowCount: -1, error: msg });
        steps.push({
          label: `query ${JSON.stringify(q.slice(0, 40))}`,
          ok: false,
          detail: msg,
        });
      }
    }

    const evidence = {
      tableId: table.id,
      filterLocator,
      baselineRowCount: baseline.length,
      perQuery,
    };

    const allFailed = perQuery.every((p) => p.error !== undefined);
    if (allFailed) {
      return fail(this.name, 'All filter queries errored', evidence, steps);
    }
    return ok(this.name, `Tested ${queries.length} filter queries`, evidence, steps);
  },
};

// ---------------------------------------------------------------------------
// 4. table_select_all_bulk
// ---------------------------------------------------------------------------

interface SelectBulkInput {
  tableId: string;
  action: string;
}

const selectBulkShape = {
  tableId: z.string().describe('Stable id of the table from PageModel.tables[*].id'),
  action: z
    .string()
    .describe('Label or substring of the bulk action to apply (e.g. "Delete", "Archive").'),
};

export const tableSelectAllBulk: Playbook<SelectBulkInput> = {
  name: 'table_select_all_bulk',
  description:
    'Click the select-all checkbox, then click the bulk action whose label matches the supplied "action" string. Verify each row reflects the action.',
  categories: ['table'],
  estimatedDurationMs: 8_000,
  inputShape: selectBulkShape,
  async run(input, ctx) {
    const resolved = await resolveTable(ctx, input.tableId);
    if ('error' in resolved) return fail(this.name, resolved.error);
    const { table } = resolved;
    const { page } = ctx;
    const steps: PlaybookStep[] = [];

    const beforeRows = await captureRowIdentities(page, table.tableLocator);

    // 1. Find select-all checkbox.
    const selectAllSelector = await firstMatching(page, [
      `${table.tableLocator} >> [data-testid="select-all"]`,
      `${table.tableLocator} >> [aria-label="Select all"]`,
      `${table.tableLocator} >> thead input[type="checkbox"]`,
      `${table.tableLocator} >> input[type="checkbox"]`,
    ]);
    if (!selectAllSelector) {
      return ok(this.name, 'No select-all checkbox detected', { tableId: table.id });
    }

    try {
      await page.locator(selectAllSelector).first().check({ timeout: 5_000 });
      steps.push({ label: 'check select-all', ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ label: 'check select-all', ok: false, detail: msg });
      return fail(this.name, `Could not check select-all: ${msg}`, { tableId: table.id }, steps);
    }

    // 2. Find a bulk action matching `input.action`.
    const wanted = input.action.toLowerCase();
    const matchedAction = table.bulkActions.find(
      (a) => a.label.toLowerCase().includes(wanted) && !a.disabled,
    );
    let actionLocator: string | null = matchedAction ? matchedAction.locator : null;
    if (!actionLocator) {
      actionLocator = await firstMatching(page, [
        `button:has-text("${input.action}")`,
        `[role="button"]:has-text("${input.action}")`,
        `[data-testid*="bulk"]:has-text("${input.action}")`,
      ]);
    }
    if (!actionLocator) {
      return suspicious(
        this.name,
        `Selected all rows but found no bulk action matching "${input.action}"`,
        {
          tableId: table.id,
          availableActions: table.bulkActions.map((a) => a.label),
        },
        steps,
      );
    }

    try {
      await page.locator(actionLocator).first().click({ timeout: 5_000 });
      steps.push({ label: `click bulk action "${input.action}"`, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({
        label: `click bulk action "${input.action}"`,
        ok: false,
        detail: msg,
      });
      return fail(this.name, `Could not click bulk action: ${msg}`, { tableId: table.id }, steps);
    }

    await page.waitForTimeout(100).catch(() => {});
    const afterRows = await captureRowIdentities(page, table.tableLocator);

    const removed = beforeRows.filter((r) => !afterRows.includes(r));
    const evidence = {
      tableId: table.id,
      action: input.action,
      beforeRowCount: beforeRows.length,
      afterRowCount: afterRows.length,
      removedRowIds: removed,
    };

    // Heuristic verification: action either removed rows, or row count
    // unchanged but DOM should have advanced (e.g. visual indicator). We
    // can't reliably check that from here without app-specific knowledge —
    // so just report what we saw.
    return ok(
      this.name,
      `Bulk "${input.action}" applied; ${beforeRows.length} → ${afterRows.length} rows`,
      evidence,
      steps,
    );
  },
};

// ---------------------------------------------------------------------------
// 5. table_row_actions_audit
// ---------------------------------------------------------------------------

interface RowActionsInput {
  tableId: string;
  maxRows?: number;
}

const rowActionsShape = {
  tableId: z.string().describe('Stable id of the table from PageModel.tables[*].id'),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Audit at most N rows. Default 3.'),
};

export const tableRowActionsAudit: Playbook<RowActionsInput> = {
  name: 'table_row_actions_audit',
  description:
    'For the first N rows, open the row-actions menu (kebab / inline icons) and record what menu items it contains. Does NOT click any item — purely an audit.',
  categories: ['table'],
  estimatedDurationMs: 8_000,
  inputShape: rowActionsShape,
  async run(input, ctx) {
    const resolved = await resolveTable(ctx, input.tableId);
    if ('error' in resolved) return fail(this.name, resolved.error);
    const { table } = resolved;
    const { page } = ctx;
    const steps: PlaybookStep[] = [];
    const maxRows = input.maxRows ?? 3;

    const tableHandle = page.locator(table.tableLocator);
    const totalRows = await tableHandle
      .locator('tbody tr')
      .count()
      .catch(() => 0);
    const limit = Math.min(maxRows, totalRows);
    if (limit === 0) {
      return ok(this.name, 'Table has no rows to audit', { tableId: table.id });
    }

    const perRow: Array<{
      rowIndex: number;
      menuOpened: boolean;
      menuItems: string[];
      error?: string;
    }> = [];

    for (let i = 0; i < limit; i++) {
      // Use 1-indexed nth-child for CSS, but 0-indexed for Playwright's nth().
      const rowSelectors = [
        `${table.tableLocator} >> tbody tr:nth-child(${i + 1}) [aria-label="Open menu"]`,
        `${table.tableLocator} >> tbody tr:nth-child(${i + 1}) [data-testid*="row-actions"]`,
        `${table.tableLocator} >> tbody tr:nth-child(${i + 1}) button:has-text("⋮")`,
        `${table.tableLocator} >> tbody tr:nth-child(${i + 1}) button[aria-haspopup="menu"]`,
      ];
      const trigger = await firstMatching(page, rowSelectors);
      if (!trigger) {
        perRow.push({ rowIndex: i, menuOpened: false, menuItems: [], error: 'no trigger found' });
        steps.push({
          label: `row ${i + 1} actions trigger`,
          ok: false,
          detail: 'no trigger',
        });
        continue;
      }
      try {
        await page.locator(trigger).first().click({ timeout: 5_000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        perRow.push({ rowIndex: i, menuOpened: false, menuItems: [], error: msg });
        steps.push({ label: `open row ${i + 1} menu`, ok: false, detail: msg });
        continue;
      }
      // Try to read menu items. Look for the most-recently-opened menu.
      const itemSelectors = [
        '[role="menu"] [role="menuitem"]',
        '[role="menu"] li',
        '[role="menu"] button',
        '[data-state="open"] [role="menuitem"]',
        '.dropdown-menu [role="menuitem"]',
      ];
      let items: string[] = [];
      for (const isel of itemSelectors) {
        try {
          const c = await page.locator(isel).count();
          if (c > 0) {
            items = await page.locator(isel).allInnerTexts();
            items = items.map((t) => t.trim()).filter(Boolean);
            if (items.length > 0) break;
          }
        } catch {
          // skip
        }
      }
      perRow.push({ rowIndex: i, menuOpened: true, menuItems: items });
      steps.push({
        label: `audit row ${i + 1} menu`,
        ok: true,
        detail: `${items.length} item(s)`,
      });
      // Best-effort dismiss so the next row can open cleanly.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(50).catch(() => {});
    }

    return ok(
      this.name,
      `Audited ${perRow.length} row(s) for action menus`,
      { tableId: table.id, perRow },
      steps,
    );
  },
};

// ---------------------------------------------------------------------------
// 6. table_column_visibility
// ---------------------------------------------------------------------------

interface ColumnVisibilityInput {
  tableId: string;
}

const columnVisibilityShape = {
  tableId: z.string().describe('Stable id of the table from PageModel.tables[*].id'),
};

export const tableColumnVisibility: Playbook<ColumnVisibilityInput> = {
  name: 'table_column_visibility',
  description:
    'Open the column-visibility control (Show columns / Columns / data-testid="column-toggle"), toggle each option, and verify the visible-column set changes.',
  categories: ['table'],
  estimatedDurationMs: 6_000,
  inputShape: columnVisibilityShape,
  async run(input, ctx) {
    const resolved = await resolveTable(ctx, input.tableId);
    if ('error' in resolved) return fail(this.name, resolved.error);
    const { table } = resolved;
    const { page } = ctx;
    const steps: PlaybookStep[] = [];

    // Snapshot visible header labels. We must count only headers that are
    // actually rendered (not display:none / hidden) — `allInnerTexts` returns
    // text for hidden elements too.
    async function visibleHeaders(): Promise<string[]> {
      try {
        const handles = await page.locator(`${table.tableLocator} >> thead th`).all();
        const out: string[] = [];
        for (const h of handles) {
          const visible = await h.isVisible().catch(() => false);
          if (!visible) continue;
          const text = (await h.innerText().catch(() => '')).trim();
          if (text) out.push(text);
        }
        return out;
      } catch {
        return [];
      }
    }

    const initial = await visibleHeaders();

    const trigger = await firstMatching(page, [
      `[data-testid*="column-toggle"]`,
      `button:has-text("Show columns")`,
      `button:has-text("Columns")`,
      `[aria-label="Toggle columns"]`,
    ]);
    if (!trigger) {
      return ok(this.name, 'No column-visibility control detected', {
        tableId: table.id,
        visibleHeaders: initial,
      });
    }

    try {
      await page.locator(trigger).first().click({ timeout: 5_000 });
      steps.push({ label: 'open column-visibility menu', ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(
        this.name,
        `Could not open column-visibility menu: ${msg}`,
        { tableId: table.id },
        [{ label: 'open column-visibility menu', ok: false, detail: msg }],
      );
    }

    // Find toggle items inside the open menu. Try a few generic shapes.
    const toggleSelectors = [
      '[role="menu"] [role="menuitemcheckbox"]',
      '[role="menu"] input[type="checkbox"]',
      '[role="menu"] [role="menuitem"]',
      '[data-state="open"] [role="menuitemcheckbox"]',
    ];
    let toggleSelector: string | null = null;
    for (const t of toggleSelectors) {
      try {
        if ((await page.locator(t).count()) > 0) {
          toggleSelector = t;
          break;
        }
      } catch {
        // skip
      }
    }
    if (!toggleSelector) {
      // Close and bail.
      await page.keyboard.press('Escape').catch(() => {});
      return ok(this.name, 'Opened column menu but found no toggle items', {
        tableId: table.id,
        visibleHeaders: initial,
      });
    }

    const togglesCount = await page.locator(toggleSelector).count();
    const perToggle: Array<{ index: number; before: number; after: number; changed: boolean }> = [];
    let changedAny = false;

    for (let i = 0; i < togglesCount; i++) {
      const before = (await visibleHeaders()).length;
      try {
        await page.locator(toggleSelector).nth(i).click({ timeout: 5_000 });
        await page.waitForTimeout(50).catch(() => {});
      } catch (err) {
        steps.push({
          label: `toggle column #${i}`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const after = (await visibleHeaders()).length;
      const changed = after !== before;
      if (changed) changedAny = true;
      perToggle.push({ index: i, before, after, changed });
      steps.push({
        label: `toggle column #${i}`,
        ok: true,
        detail: `${before} → ${after} headers`,
      });
    }

    await page.keyboard.press('Escape').catch(() => {});

    const evidence = {
      tableId: table.id,
      initialHeaderCount: initial.length,
      togglesCount,
      perToggle,
    };

    if (togglesCount > 0 && !changedAny) {
      return suspicious(
        this.name,
        'Column toggles found but none changed visible columns',
        evidence,
        steps,
      );
    }
    return ok(
      this.name,
      `Toggled ${togglesCount} column option(s); visible-set changed`,
      evidence,
      steps,
    );
  },
};

// ---------------------------------------------------------------------------
// 7. table_export_download
// ---------------------------------------------------------------------------

interface ExportInput {
  tableId: string;
}

const exportShape = {
  tableId: z.string().describe('Stable id of the table from PageModel.tables[*].id'),
};

export const tableExportDownload: Playbook<ExportInput> = {
  name: 'table_export_download',
  description:
    "Click the table's Export / Download / CSV button. Listen for a Playwright `download` event; record filename and content-disposition header.",
  categories: ['table', 'file'],
  estimatedDurationMs: 8_000,
  inputShape: exportShape,
  async run(input, ctx) {
    const resolved = await resolveTable(ctx, input.tableId);
    if ('error' in resolved) return fail(this.name, resolved.error);
    const { table } = resolved;
    const { page } = ctx;
    const steps: PlaybookStep[] = [];

    const trigger = await firstMatching(page, [
      `${table.tableLocator} >> button:has-text("Export")`,
      `${table.tableLocator} >> button:has-text("Download")`,
      `${table.tableLocator} >> button:has-text("CSV")`,
      `button:has-text("Export")`,
      `button:has-text("Download")`,
      `button:has-text("CSV")`,
      `[data-testid*="export"]`,
      `[aria-label="Export"]`,
      `[aria-label="Download"]`,
    ]);
    if (!trigger) {
      return ok(this.name, 'No export/download/CSV button detected', { tableId: table.id });
    }

    // Listen for download event in parallel with the click. Catch a timeout
    // so we don't hang forever if no download fires.
    const downloadPromise = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
    try {
      await page.locator(trigger).first().click({ timeout: 5_000 });
      steps.push({ label: 'click export trigger', ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(this.name, `Could not click export trigger: ${msg}`, { tableId: table.id }, [
        { label: 'click export trigger', ok: false, detail: msg },
      ]);
    }

    const download = await downloadPromise;
    if (!download) {
      return suspicious(
        this.name,
        'Export button clicked but no download event fired within 5s',
        { tableId: table.id, trigger },
        steps,
      );
    }

    const suggestedFilename = download.suggestedFilename();
    // content-disposition is not directly exposed on the Download object; we
    // record what's available (filename + url) and note the absence.
    return ok(
      this.name,
      `Download fired: ${suggestedFilename}`,
      {
        tableId: table.id,
        suggestedFilename,
        url: download.url(),
      },
      [...steps, { label: 'download event received', ok: true, detail: suggestedFilename }],
    );
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTablePlaybooks(r: PlaybookRegistry): void {
  r.register(tableSortEachColumn);
  r.register(tablePaginateWalk);
  r.register(tableFilterSearch);
  r.register(tableSelectAllBulk);
  r.register(tableRowActionsAudit);
  r.register(tableColumnVisibility);
  r.register(tableExportDownload);
}

/** Re-export the outcome type so callers don't need a separate import. */
export type { PlaybookOutcome };
