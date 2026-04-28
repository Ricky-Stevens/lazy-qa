/**
 * Table playbook — `walk_pagination`. Replaces the previous tables.ts which
 * held 7 playbooks (sort, paginate, filter, select-all, row-actions, column-
 * visibility, export).
 *
 * The persona drives row-level interactions; this playbook handles the
 * mechanical "click Next a few times and check rows are consistent" loop.
 */

import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { TableSpec } from '../page-model/types.ts';
import type { Playbook } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

const STEP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PAGES = 5;

const walkPaginationShape = {
  tableId: z.string(),
  maxPages: z.number().int().min(1).max(20).optional(),
} satisfies z.ZodRawShape;

export interface WalkPaginationInput {
  tableId: string;
  maxPages?: number;
}

interface PageSnapshot {
  index: number;
  rowCount: number;
  firstRowText: string;
}

async function snapshotTable(page: Page, table: TableSpec, index: number): Promise<PageSnapshot> {
  // Target both classic <tbody><tr> and ARIA grids ([role="row"]).
  const rowLocator = page.locator(
    `${table.tableLocator} tbody tr, ${table.tableLocator} [role="row"]`,
  );
  const rowCount = await rowLocator.count().catch(() => 0);
  const firstRowText =
    rowCount > 0
      ? (
          await rowLocator
            .first()
            .innerText()
            .catch(() => '')
        )
          .trim()
          .slice(0, 200)
      : '';
  return { index, rowCount, firstRowText };
}

async function findNextButton(page: Page, table: TableSpec): Promise<Locator | null> {
  // TableSpec.pagination only exposes a container locator, not a next-button
  // ActionRef — so we scope fallback selectors to the pagination container if
  // available, then try document-level heuristics.
  const candidates: string[] = [];
  if (table.pagination?.locator) {
    const scope = table.pagination.locator;
    candidates.push(
      `${scope} [aria-label*="next" i]:not([disabled])`,
      `${scope} button:has-text("Next"):not([disabled])`,
      `${scope} .pagination-next:not([disabled])`,
      `${scope} [aria-label*="next page" i]:not([disabled])`,
    );
  }
  // Document-level fallbacks.
  candidates.push(
    `[aria-label*="next page" i]:not([disabled])`,
    `[aria-label*="Go to next page" i]:not([disabled])`,
    `button:has-text("Next"):not([disabled])`,
    `.pagination-next:not([disabled])`,
  );
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) return loc;
  }
  return null;
}

export const walkPagination: Playbook<WalkPaginationInput> = {
  name: 'walk_pagination',
  description:
    "Page through a table or paginated list. Provide `tableId` from the latest snapshot. Walks Next-buttons up to `maxPages` (default 5). Records row counts and first-row text per page; flags `suspicious` if duplicate or vanishing rows appear, or if Next is enabled but advancing it doesn't change the page. Returns `ok` if pagination behaved consistently.",
  categories: ['table'],
  estimatedDurationMs: 6_000,
  inputShape: walkPaginationShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { tableId: input.tableId };
    const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;

    const model = await ctx.pageModel();
    const table = model.tables.find((t) => t.id === input.tableId);
    if (!table) {
      return fail(
        walkPagination.name,
        `table '${input.tableId}' not found in current page model (${model.tables.length} table(s) on this page)`,
        evidence,
        steps,
      );
    }
    evidence.tableLocator = table.tableLocator;

    const snapshots: PageSnapshot[] = [await snapshotTable(ctx.page, table, 1)];
    steps.push({ label: `page 1: ${snapshots[0].rowCount} row(s)`, ok: true });

    for (let p = 2; p <= maxPages; p++) {
      const nextBtn = await findNextButton(ctx.page, table);
      if (!nextBtn) {
        steps.push({ label: `page ${p}: no Next button — pagination ended`, ok: true });
        break;
      }
      try {
        await nextBtn.click({ timeout: STEP_TIMEOUT_MS });
      } catch (err) {
        steps.push({
          label: `page ${p}: Next click failed`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      await ctx.page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS }).catch(() => {});
      const snap = await snapshotTable(ctx.page, table, p);
      snapshots.push(snap);
      steps.push({ label: `page ${p}: ${snap.rowCount} row(s)`, ok: true });
    }

    evidence.snapshots = snapshots;

    const seen = new Set<string>();
    const dupes: number[] = [];
    let emptyAfterNonempty = false;
    let prevNonEmpty = false;
    for (const s of snapshots) {
      const key = `${s.firstRowText}|${s.rowCount}`;
      if (s.rowCount > 0 && seen.has(key)) dupes.push(s.index);
      seen.add(key);
      if (prevNonEmpty && s.rowCount === 0) emptyAfterNonempty = true;
      if (s.rowCount > 0) prevNonEmpty = true;
    }
    evidence.duplicatePages = dupes;
    evidence.emptyAfterNonempty = emptyAfterNonempty;

    if (dupes.length > 0 || emptyAfterNonempty) {
      const issues: string[] = [];
      if (dupes.length > 0) issues.push(`page(s) ${dupes.join(', ')} duplicated earlier content`);
      if (emptyAfterNonempty) issues.push('a page returned 0 rows after a non-empty page');
      return suspicious(
        walkPagination.name,
        `Pagination anomaly: ${issues.join('; ')}`,
        evidence,
        steps,
      );
    }

    return ok(
      walkPagination.name,
      `Walked ${snapshots.length} page(s) of '${input.tableId}'; rows consistent.`,
      evidence,
      steps,
    );
  },
};

export type { PlaybookOutcome };
