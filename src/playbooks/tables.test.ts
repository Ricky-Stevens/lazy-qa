/**
 * Tests for the `walk_pagination` table playbook (WP2.D).
 *
 * Uses real Chromium via Playwright + `setContent`. The `PlaybookContext` is
 * stubbed following the same pattern as forms.test.ts.
 */

import { type Browser, chromium, type Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteMapAccessor } from '../crawler/types.ts';
import { createLogger } from '../logging/logger.ts';
import type { PageModel, TableSpec } from '../page-model/types.ts';
import type { PlaybookContext } from './framework.ts';
import { walkPagination } from './tables.ts';

// ---------------------------------------------------------------------------
// Stub SiteMapAccessor — pattern-matched from forms.test.ts
// ---------------------------------------------------------------------------

const stubSitemap: SiteMapAccessor = {
  listUnvisitedRoutes: () => [],
  listAllRoutes: () => [],
  listFormsUntested: () => [],
  listTablesUntested: () => [],
  listModalsUntested: () => [],
  listWizardsUntested: () => [],
  getRoute: () => undefined,
  getPageModel: () => undefined,
  upsertRoute: () => {},
  recordVisit: () => {},
  recordPlaybookOutcome: () => {},
  serialize: () => ({
    startedAt: new Date().toISOString(),
    rootUrl: 'about:blank',
    routes: {},
    pageModels: {},
  }),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// TableSpec uses `tableLocator` (not `selector`).
// TableSpec.pagination is `{ locator: string; currentPage?: number; totalPages?: number }`.
// There is no `pagination.next` ActionRef — next-button detection is heuristic.
function makeTable(overrides: Partial<TableSpec> = {}): TableSpec {
  return {
    id: 'tbl-1',
    tableLocator: '#data-table',
    name: 'Test table',
    columns: [],
    rowCount: 0,
    rowActions: [],
    bulkActions: [],
    filters: [],
    ...overrides,
  };
}

function makeContext(page: Page, table: TableSpec): PlaybookContext {
  const model: PageModel = {
    url: page.url(),
    route: page.url(),
    title: 'Test',
    forms: [],
    tables: [table],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareInteractives: [],
    network: [],
    console: [],
    textHash: '',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
  };
  return {
    page,
    pageModel: () => Promise.resolve(model),
    siteMap: stubSitemap,
    agentId: 'test',
    persona: 'test',
    runDir: '/tmp',
    logger: createLogger(),
    allowedHosts: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('walk_pagination', () => {
  let browser: Browser;
  let page: Page;

  beforeEach(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterEach(async () => {
    await browser.close();
  });

  it('returns failed when tableId is not in the page model', async () => {
    await page.setContent('<div>no tables here</div>');
    const table = makeTable();
    const ctx = makeContext(page, table);
    const result = await walkPagination.run({ tableId: 'nonexistent-table' }, ctx);
    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/not found/);
    expect(result.summary).toContain('nonexistent-table');
  });

  it('walks 3 pages and returns ok when content changes each page', async () => {
    // Each click on Next replaces tbody content with distinct rows.
    await page.setContent(`
      <table id="data-table">
        <tbody id="tbody">
          <tr><td>page-1-row-A</td></tr>
          <tr><td>page-1-row-B</td></tr>
        </tbody>
      </table>
      <nav id="pagination">
        <button id="next-btn" aria-label="Next page">Next</button>
      </nav>
      <script>
        let currentPage = 1;
        const pages = {
          1: [['page-1-row-A'], ['page-1-row-B']],
          2: [['page-2-row-A'], ['page-2-row-B']],
          3: [['page-3-row-A'], ['page-3-row-B']],
        };
        function render(p) {
          const tbody = document.getElementById('tbody');
          tbody.innerHTML = '';
          for (const cells of pages[p]) {
            const tr = document.createElement('tr');
            for (const text of cells) {
              const td = document.createElement('td');
              td.textContent = text;
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
        }
        document.getElementById('next-btn').addEventListener('click', () => {
          if (currentPage < 3) {
            currentPage++;
            render(currentPage);
          }
          if (currentPage >= 3) {
            document.getElementById('next-btn').setAttribute('disabled', 'disabled');
          }
        });
      </script>
    `);

    const table = makeTable({
      pagination: { locator: '#pagination' },
      rowCount: 2,
    });
    const ctx = makeContext(page, table);
    const result = await walkPagination.run({ tableId: 'tbl-1', maxPages: 3 }, ctx);

    expect(result.status).toBe('ok');
    expect(result.summary).toMatch(/3 page\(s\)/);
    const snapshots = result.evidence.snapshots as Array<{
      index: number;
      rowCount: number;
      firstRowText: string;
    }>;
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].firstRowText).toContain('page-1-row-A');
    expect(snapshots[1].firstRowText).toContain('page-2-row-A');
    expect(snapshots[2].firstRowText).toContain('page-3-row-A');
    expect(result.evidence.duplicatePages).toEqual([]);
    expect(result.evidence.emptyAfterNonempty).toBe(false);
  });

  it('flags suspicious when Next button is present but clicking it does not change rows', async () => {
    // Next button exists and is enabled, but clicking it does nothing —
    // the rows stay identical across pages.
    await page.setContent(`
      <table id="data-table">
        <tbody>
          <tr><td>frozen-row-A</td></tr>
          <tr><td>frozen-row-B</td></tr>
        </tbody>
      </table>
      <nav id="pagination">
        <button id="next-btn" aria-label="Next page">Next</button>
      </nav>
      <script>
        // Intentionally does nothing on click.
        document.getElementById('next-btn').addEventListener('click', () => {});
      </script>
    `);

    const table = makeTable({
      pagination: { locator: '#pagination' },
      rowCount: 2,
    });
    const ctx = makeContext(page, table);
    // maxPages=3 so it attempts to click Next twice; both clicks leave rows unchanged.
    const result = await walkPagination.run({ tableId: 'tbl-1', maxPages: 3 }, ctx);

    expect(result.status).toBe('suspicious');
    expect(result.summary).toMatch(/anomaly/i);
    const dupes = result.evidence.duplicatePages as number[];
    expect(dupes.length).toBeGreaterThan(0);
  });

  it('returns ok when no Next button exists at all (single-page table)', async () => {
    // A table with no pagination whatsoever — single-page, normal terminal state.
    await page.setContent(`
      <table id="data-table">
        <tbody>
          <tr><td>only-row-A</td></tr>
          <tr><td>only-row-B</td></tr>
        </tbody>
      </table>
    `);

    const table = makeTable({ rowCount: 2 });
    const ctx = makeContext(page, table);
    const result = await walkPagination.run({ tableId: 'tbl-1' }, ctx);

    expect(result.status).toBe('ok');
    // Should walk 1 page and stop cleanly.
    const snapshots = result.evidence.snapshots as Array<{ rowCount: number }>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].rowCount).toBe(2);
    // Steps should mention pagination ended.
    expect(result.steps.some((s) => s.label.includes('pagination ended'))).toBe(true);
  });
});
