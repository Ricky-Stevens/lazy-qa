/**
 * Table playbook tests. Each playbook gets:
 *   1. A happy-path scenario where the orchestrated action visibly works.
 *   2. A broken-app scenario that should produce a `suspicious` outcome
 *      (or `failed` if the affordance is entirely missing).
 *
 * We drive a real Chromium via Playwright + `setContent`, and stub out the
 * `PlaybookContext` with a hand-built `PageModel` containing one `TableSpec`.
 */

import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PageModel, TableSpec } from '../page-model/types.ts';
import type { PlaybookContext } from './framework.ts';
import { PlaybookRegistry } from './framework.ts';
import {
  registerTablePlaybooks,
  tableColumnVisibility,
  tableExportDownload,
  tableFilterSearch,
  tablePaginateWalk,
  tableRowActionsAudit,
  tableSelectAllBulk,
  tableSortEachColumn,
} from './tables.ts';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

function makeTableSpec(overrides: Partial<TableSpec> = {}): TableSpec {
  return {
    id: 't1',
    tableLocator: 'table',
    name: 'Test table',
    columns: [],
    rowCount: 0,
    rowActions: [],
    bulkActions: [],
    filters: [],
    ...overrides,
  };
}

function makePageModel(table: TableSpec): PageModel {
  return {
    url: 'about:blank',
    route: 'about:blank',
    title: 'test',
    forms: [],
    tables: [table],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareInteractives: [],
    network: [],
    console: [],
    textHash: 'x',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
  };
}

function makeContext(page: Page, table: TableSpec): PlaybookContext {
  return {
    page,
    pageModel: async () => makePageModel(table),
    siteMap: {
      // Only the methods used by playbooks need real implementations; we don't
      // touch siteMap in any of the seven table playbooks, so stubs that throw
      // would be louder, but stubs that no-op are friendlier when we add new
      // callers later. They are typed as never-callable in this test scope.
    } as unknown as PlaybookContext['siteMap'],
    agentId: 'test-agent',
    persona: 'test',
    runDir: '/tmp/regress-test',
    logger: noopLogger,
    allowedHosts: [],
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registerTablePlaybooks', () => {
  it('registers all seven table playbooks', () => {
    const r = new PlaybookRegistry();
    registerTablePlaybooks(r);
    const names = r.list().map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'table_sort_each_column',
        'table_paginate_walk',
        'table_filter_search',
        'table_select_all_bulk',
        'table_row_actions_audit',
        'table_column_visibility',
        'table_export_download',
      ]),
    );
    expect(r.size()).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 1. table_sort_each_column
// ---------------------------------------------------------------------------

describe('table_sort_each_column', () => {
  it('returns ok when clicking the header reorders rows', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <table>
          <thead>
            <tr><th id="hName" data-sort-state="0">Name</th></tr>
          </thead>
          <tbody>
            <tr><td>Charlie</td></tr>
            <tr><td>Alice</td></tr>
            <tr><td>Bob</td></tr>
          </tbody>
        </table>
        <script>
          document.getElementById('hName').addEventListener('click', () => {
            const tbody = document.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            rows.sort((a, b) => a.cells[0].textContent.localeCompare(b.cells[0].textContent));
            for (const r of rows) tbody.appendChild(r);
          });
        </script>
      `);
      const table = makeTableSpec({
        columns: [{ label: 'Name', headerLocator: '#hName', sortable: true }],
        rowCount: 3,
      });
      const ctx = makeContext(page, table);
      const outcome = await tableSortEachColumn.run({ tableId: 't1' }, ctx);
      expect(outcome.status).toBe('ok');
      const ev = outcome.evidence as { perColumn: Array<{ changed: boolean }> };
      expect(ev.perColumn[0].changed).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('returns suspicious when header click does nothing', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <table>
          <thead>
            <tr><th id="hName">Name</th></tr>
          </thead>
          <tbody>
            <tr><td>Charlie</td></tr>
            <tr><td>Alice</td></tr>
            <tr><td>Bob</td></tr>
          </tbody>
        </table>
      `);
      const table = makeTableSpec({
        columns: [{ label: 'Name', headerLocator: '#hName', sortable: true }],
        rowCount: 3,
      });
      const ctx = makeContext(page, table);
      const outcome = await tableSortEachColumn.run({ tableId: 't1' }, ctx);
      expect(outcome.status).toBe('suspicious');
      expect(outcome.summary).toMatch(/no effect/i);
    } finally {
      await page.close();
    }
  });

  it('returns ok with note when no sortable columns exist', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<table><thead><tr><th>x</th></tr></thead><tbody></tbody></table>');
      const table = makeTableSpec({
        columns: [{ label: 'x', headerLocator: 'th', sortable: false }],
      });
      const outcome = await tableSortEachColumn.run({ tableId: 't1' }, makeContext(page, table));
      expect(outcome.status).toBe('ok');
      expect(outcome.summary).toMatch(/no sortable/i);
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. table_paginate_walk
// ---------------------------------------------------------------------------

describe('table_paginate_walk', () => {
  it('returns ok when each page shows distinct rows', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <table id="t">
          <thead><tr><th>id</th></tr></thead>
          <tbody id="body">
            <tr><td>p1-row1</td></tr>
            <tr><td>p1-row2</td></tr>
          </tbody>
        </table>
        <div id="pg">
          <button data-page="1">1</button>
          <button data-page="2">2</button>
          <button data-page="3">3</button>
          <button aria-label="Last page">Last</button>
        </div>
        <script>
          const pages = {
            1: ['p1-row1', 'p1-row2'],
            2: ['p2-row1', 'p2-row2'],
            3: ['p3-row1', 'p3-row2'],
          };
          function render(p) {
            const body = document.getElementById('body');
            body.innerHTML = '';
            for (const r of pages[p]) {
              const tr = document.createElement('tr');
              const td = document.createElement('td');
              td.textContent = r;
              tr.appendChild(td);
              body.appendChild(tr);
            }
          }
          for (const b of document.querySelectorAll('#pg button')) {
            b.addEventListener('click', () => {
              const p = b.getAttribute('data-page');
              if (p) render(p);
              else if (b.getAttribute('aria-label') === 'Last page') render(3);
            });
          }
        </script>
      `);
      const table = makeTableSpec({
        tableLocator: '#t',
        pagination: { locator: '#pg' },
        rowCount: 2,
      });
      const ctx = makeContext(page, table);
      const outcome = await tablePaginateWalk.run({ tableId: 't1' }, ctx);
      expect(outcome.status).toBe('ok');
      const ev = outcome.evidence as { overlaps: unknown[]; pagesVisited: unknown[] };
      expect(ev.overlaps).toHaveLength(0);
      expect(ev.pagesVisited.length).toBeGreaterThanOrEqual(2);
    } finally {
      await page.close();
    }
  });

  it('returns suspicious when the same row appears on two pages', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <table id="t">
          <thead><tr><th>id</th></tr></thead>
          <tbody id="body">
            <tr><td>shared-row</td></tr>
            <tr><td>p1-only</td></tr>
          </tbody>
        </table>
        <div id="pg">
          <button data-page="1">1</button>
          <button data-page="2">2</button>
        </div>
        <script>
          const pages = {
            1: ['shared-row', 'p1-only'],
            2: ['shared-row', 'p2-only'],
          };
          function render(p) {
            const body = document.getElementById('body');
            body.innerHTML = '';
            for (const r of pages[p]) {
              const tr = document.createElement('tr');
              const td = document.createElement('td');
              td.textContent = r;
              tr.appendChild(td);
              body.appendChild(tr);
            }
          }
          for (const b of document.querySelectorAll('#pg button')) {
            b.addEventListener('click', () => {
              const p = b.getAttribute('data-page');
              if (p) render(p);
            });
          }
        </script>
      `);
      const table = makeTableSpec({
        tableLocator: '#t',
        pagination: { locator: '#pg' },
        rowCount: 2,
      });
      const ctx = makeContext(page, table);
      const outcome = await tablePaginateWalk.run({ tableId: 't1', maxPages: 3 }, ctx);
      expect(outcome.status).toBe('suspicious');
      const ev = outcome.evidence as { overlaps: Array<{ rowId: string }> };
      expect(ev.overlaps.length).toBeGreaterThan(0);
      expect(ev.overlaps[0].rowId).toBe('shared-row');
    } finally {
      await page.close();
    }
  });

  it('returns ok with note when no pagination exists', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<table><tbody><tr><td>a</td></tr></tbody></table>');
      const outcome = await tablePaginateWalk.run(
        { tableId: 't1' },
        makeContext(page, makeTableSpec()),
      );
      expect(outcome.status).toBe('ok');
      expect(outcome.summary).toMatch(/no pagination/i);
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. table_filter_search
// ---------------------------------------------------------------------------

describe('table_filter_search', () => {
  it('captures rowCount per query when filter input changes visible rows', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <input type="search" id="filter" placeholder="Filter">
        <table id="t">
          <thead><tr><th>name</th></tr></thead>
          <tbody id="body">
            <tr><td>Apple</td></tr>
            <tr><td>Banana</td></tr>
            <tr><td>Cherry</td></tr>
          </tbody>
        </table>
        <script>
          const all = ['Apple', 'Banana', 'Cherry'];
          const input = document.getElementById('filter');
          input.addEventListener('input', () => {
            const q = input.value.toLowerCase();
            const body = document.getElementById('body');
            body.innerHTML = '';
            for (const v of all) {
              if (!q || v.toLowerCase().includes(q)) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.textContent = v;
                tr.appendChild(td);
                body.appendChild(tr);
              }
            }
          });
        </script>
      `);
      const table = makeTableSpec({
        tableLocator: '#t',
        filters: [
          {
            locator: '#filter',
            label: 'Filter',
            type: 'input',
            disabled: false,
            intent: 'action',
          },
        ],
      });
      const ctx = makeContext(page, table);
      const outcome = await tableFilterSearch.run(
        { tableId: 't1', queries: ['', 'app', 'zzz-no-match'] },
        ctx,
      );
      expect(outcome.status).toBe('ok');
      const ev = outcome.evidence as {
        perQuery: Array<{ query: string; rowCount: number }>;
      };
      const byQuery = Object.fromEntries(ev.perQuery.map((p) => [p.query, p.rowCount]));
      expect(byQuery['']).toBe(3);
      expect(byQuery.app).toBe(1);
      expect(byQuery['zzz-no-match']).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('returns ok with note when no filter input is present', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<table id="t"><tbody><tr><td>a</td></tr></tbody></table>');
      const outcome = await tableFilterSearch.run(
        { tableId: 't1' },
        makeContext(page, makeTableSpec({ tableLocator: '#t' })),
      );
      expect(outcome.status).toBe('ok');
      expect(outcome.summary).toMatch(/no filter/i);
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. table_select_all_bulk
// ---------------------------------------------------------------------------

describe('table_select_all_bulk', () => {
  it('clicks select-all and the named bulk action', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <table id="t">
          <thead>
            <tr>
              <th><input type="checkbox" data-testid="select-all" id="sa"></th>
              <th>name</th>
            </tr>
          </thead>
          <tbody id="body">
            <tr><td><input type="checkbox" class="rb"></td><td>r1</td></tr>
            <tr><td><input type="checkbox" class="rb"></td><td>r2</td></tr>
          </tbody>
        </table>
        <button id="bulk-delete">Delete selected</button>
        <script>
          document.getElementById('sa').addEventListener('change', (e) => {
            for (const cb of document.querySelectorAll('.rb')) cb.checked = e.target.checked;
          });
          document.getElementById('bulk-delete').addEventListener('click', () => {
            for (const cb of document.querySelectorAll('.rb')) {
              if (cb.checked) cb.closest('tr').remove();
            }
          });
        </script>
      `);
      const table = makeTableSpec({
        tableLocator: '#t',
        bulkActions: [
          {
            locator: '#bulk-delete',
            label: 'Delete selected',
            type: 'button',
            disabled: false,
            intent: 'action',
          },
        ],
        rowCount: 2,
      });
      const ctx = makeContext(page, table);
      const outcome = await tableSelectAllBulk.run({ tableId: 't1', action: 'Delete' }, ctx);
      expect(outcome.status).toBe('ok');
      const ev = outcome.evidence as { beforeRowCount: number; afterRowCount: number };
      expect(ev.beforeRowCount).toBe(2);
      expect(ev.afterRowCount).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('returns suspicious when no matching bulk action is found', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <table id="t">
          <thead><tr><th><input type="checkbox" data-testid="select-all"></th></tr></thead>
          <tbody><tr><td><input type="checkbox"></td></tr></tbody>
        </table>
      `);
      const table = makeTableSpec({ tableLocator: '#t', rowCount: 1 });
      const outcome = await tableSelectAllBulk.run(
        { tableId: 't1', action: 'NoSuchAction' },
        makeContext(page, table),
      );
      expect(outcome.status).toBe('suspicious');
      expect(outcome.summary).toMatch(/no bulk action/i);
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. table_row_actions_audit
// ---------------------------------------------------------------------------

describe('table_row_actions_audit', () => {
  it('opens kebab menus and records menu items as evidence', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <style>
          [role=menu] { display: none; }
          [role=menu][data-state=open] { display: block; }
        </style>
        <table id="t">
          <thead><tr><th>name</th><th>actions</th></tr></thead>
          <tbody>
            <tr>
              <td>r1</td>
              <td>
                <button aria-label="Open menu" data-row="1">⋮</button>
                <div role="menu" data-row="1">
                  <button role="menuitem">Edit</button>
                  <button role="menuitem">Delete</button>
                  <button role="menuitem">Duplicate</button>
                </div>
              </td>
            </tr>
            <tr>
              <td>r2</td>
              <td>
                <button aria-label="Open menu" data-row="2">⋮</button>
                <div role="menu" data-row="2">
                  <button role="menuitem">Edit</button>
                  <button role="menuitem">Delete</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <script>
          document.addEventListener('click', (e) => {
            const t = e.target;
            if (t && t.getAttribute && t.getAttribute('aria-label') === 'Open menu') {
              for (const m of document.querySelectorAll('[role=menu]')) {
                m.removeAttribute('data-state');
              }
              const row = t.getAttribute('data-row');
              const menu = document.querySelector('[role=menu][data-row="' + row + '"]');
              if (menu) menu.setAttribute('data-state', 'open');
            }
          });
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
              for (const m of document.querySelectorAll('[role=menu]')) m.removeAttribute('data-state');
            }
          });
        </script>
      `);
      const table = makeTableSpec({ tableLocator: '#t', rowCount: 2 });
      const outcome = await tableRowActionsAudit.run(
        { tableId: 't1', maxRows: 2 },
        makeContext(page, table),
      );
      expect(outcome.status).toBe('ok');
      const ev = outcome.evidence as {
        perRow: Array<{ rowIndex: number; menuOpened: boolean; menuItems: string[] }>;
      };
      expect(ev.perRow).toHaveLength(2);
      expect(ev.perRow[0].menuOpened).toBe(true);
      expect(ev.perRow[0].menuItems).toEqual(
        expect.arrayContaining(['Edit', 'Delete', 'Duplicate']),
      );
      expect(ev.perRow[1].menuItems).toEqual(expect.arrayContaining(['Edit', 'Delete']));
    } finally {
      await page.close();
    }
  });

  it('records error when no row-actions trigger exists', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <table id="t">
          <tbody><tr><td>r1</td></tr></tbody>
        </table>
      `);
      const outcome = await tableRowActionsAudit.run(
        { tableId: 't1', maxRows: 1 },
        makeContext(page, makeTableSpec({ tableLocator: '#t', rowCount: 1 })),
      );
      expect(outcome.status).toBe('ok');
      const ev = outcome.evidence as {
        perRow: Array<{ menuOpened: boolean; error?: string }>;
      };
      expect(ev.perRow[0].menuOpened).toBe(false);
      expect(ev.perRow[0].error).toBeDefined();
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. table_column_visibility
// ---------------------------------------------------------------------------

describe('table_column_visibility', () => {
  it('toggles columns and reports a changed visible-set', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <button data-testid="column-toggle" id="ct">Columns</button>
        <div role="menu" id="cmenu" style="display:none">
          <button role="menuitemcheckbox" data-col="A">A</button>
          <button role="menuitemcheckbox" data-col="B">B</button>
        </div>
        <table id="t">
          <thead><tr><th data-col="A">A</th><th data-col="B">B</th></tr></thead>
          <tbody><tr><td>1</td><td>2</td></tr></tbody>
        </table>
        <script>
          document.getElementById('ct').addEventListener('click', () => {
            document.getElementById('cmenu').style.display = 'block';
          });
          for (const b of document.querySelectorAll('#cmenu [role=menuitemcheckbox]')) {
            b.addEventListener('click', () => {
              const c = b.getAttribute('data-col');
              for (const el of document.querySelectorAll('[data-col="' + c + '"]')) {
                if (el.tagName === 'TH' || el.tagName === 'TD') {
                  el.style.display = el.style.display === 'none' ? '' : 'none';
                }
              }
            });
          }
        </script>
      `);
      const table = makeTableSpec({ tableLocator: '#t', rowCount: 1 });
      const outcome = await tableColumnVisibility.run({ tableId: 't1' }, makeContext(page, table));
      expect(outcome.status).toBe('ok');
      const ev = outcome.evidence as {
        perToggle: Array<{ before: number; after: number; changed: boolean }>;
      };
      expect(ev.perToggle.some((t) => t.changed)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('returns ok with note when no column-visibility control exists', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<table id="t"><thead><tr><th>x</th></tr></thead><tbody></tbody></table>',
      );
      const outcome = await tableColumnVisibility.run(
        { tableId: 't1' },
        makeContext(page, makeTableSpec({ tableLocator: '#t' })),
      );
      expect(outcome.status).toBe('ok');
      expect(outcome.summary).toMatch(/no column-visibility/i);
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. table_export_download
// ---------------------------------------------------------------------------

describe('table_export_download', () => {
  it('captures filename when export triggers a download', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <table id="t"><tbody><tr><td>r1</td></tr></tbody></table>
        <a id="dl" download="export.csv" href="data:text/csv;charset=utf-8,foo%2Cbar%0A1%2C2">Export</a>
        <script>
          // Wrap the link so the playbook's button-text matcher finds it:
          const wrap = document.createElement('button');
          wrap.textContent = 'Export';
          wrap.addEventListener('click', () => document.getElementById('dl').click());
          document.body.appendChild(wrap);
        </script>
      `);
      const table = makeTableSpec({ tableLocator: '#t', rowCount: 1 });
      const outcome = await tableExportDownload.run({ tableId: 't1' }, makeContext(page, table));
      expect(outcome.status).toBe('ok');
      const ev = outcome.evidence as { suggestedFilename?: string };
      expect(ev.suggestedFilename).toBe('export.csv');
    } finally {
      await page.close();
    }
  });

  it('returns suspicious when click does not produce a download', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <table id="t"><tbody><tr><td>r1</td></tr></tbody></table>
        <button id="dl">Export</button>
        <script>
          // Click does nothing — no download fires.
          document.getElementById('dl').addEventListener('click', () => {});
        </script>
      `);
      const table = makeTableSpec({ tableLocator: '#t', rowCount: 1 });
      const outcome = await tableExportDownload.run({ tableId: 't1' }, makeContext(page, table));
      expect(outcome.status).toBe('suspicious');
      expect(outcome.summary).toMatch(/no download event/i);
    } finally {
      await page.close();
    }
  }, 15_000);
});
