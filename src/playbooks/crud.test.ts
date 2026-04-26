/**
 * crud.ts integration tests. Each test launches a real chromium, sets synthetic
 * HTML via page.setContent(), then invokes the playbook with a fake
 * PlaybookContext. We avoid running a server: anything stateful (row removal,
 * field persistence, validation errors) is implemented in inline scripts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

// `page.evaluate` callbacks run in the browser, but TypeScript checks them
// in this file's scope which does not include the DOM lib. Declare a minimal
// ambient `document` so the callbacks typecheck without pulling in `lib.dom`.
declare const document: {
  body: { dataset: Record<string, string | undefined> };
  getElementById(id: string): { hidden: boolean; dataset: Record<string, string> } | null;
  querySelectorAll(sel: string): Array<{ checked: boolean; closest(s: string): { remove(): void } | null }>;
};
import {
  crudArchiveUnarchive,
  crudBulkAction,
  crudCreateForm,
  crudDeleteFirstRow,
  crudDuplicateRow,
  crudEditFirstRow,
  crudEditSpecificRow,
  registerCrudPlaybooks,
} from './crud.ts';
import { PlaybookRegistry } from './framework.ts';
import type { PlaybookContext } from './framework.ts';
import type { NetworkAnomaly, PageModel } from '../page-model/types.ts';
import type { SiteMapAccessor } from '../crawler/types.ts';
import { createLogger } from '../logging/logger.ts';

let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

// ---------- Test harness ----------------------------------------------------

function noopSiteMap(): SiteMapAccessor {
  return {
    getRoute: () => undefined,
    getPageModel: () => undefined,
    listAllRoutes: () => [],
    listUnvisitedRoutes: () => [],
    listFormsUntested: () => [],
    listTablesUntested: () => [],
    listModalsUntested: () => [],
    listWizardsUntested: () => [],
    recordVisit: () => {},
    recordPlaybookOutcome: () => {},
    upsertRoute: () => {},
    serialize: () => ({
      startedAt: new Date().toISOString(),
      rootUrl: 'about:blank',
      routes: {},
      pageModels: {},
    }),
  };
}

function makeContext(page: Page, network: NetworkAnomaly[] = []): PlaybookContext {
  const pageModel = async (): Promise<PageModel> => ({
    url: page.url(),
    route: page.url(),
    title: await page.title().catch(() => ''),
    forms: [],
    tables: [],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareInteractives: [],
    network,
    console: [],
    textHash: '',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
  });
  return {
    page,
    pageModel,
    siteMap: noopSiteMap(),
    agentId: 'test-agent',
    persona: '',
    runDir: '/tmp/test',
    logger: createLogger({ level: 'error' }),
  };
}

async function fresh(html: string): Promise<Page> {
  const p = await context.newPage();
  await p.setContent(html, { waitUntil: 'domcontentloaded' });
  return p;
}

// ---------- crud_create_form -----------------------------------------------

describe('crud_create_form', () => {
  it('fills labelled fields, clicks submit, returns ok', async () => {
    const html = `
      <!doctype html><html><body>
        <form id="f">
          <label>Name <input name="Name" /></label>
          <label>Email <input name="Email" type="email" /></label>
          <button type="submit" id="submit">Save</button>
        </form>
        <script>
          document.getElementById('f').addEventListener('submit', (e) => {
            e.preventDefault();
            document.body.dataset.submitted = '1';
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await crudCreateForm.run(
        {
          formId: 'f',
          valuesByLabel: { Name: 'Alice', Email: 'a@example.com' },
        },
        ctx,
      );
      expect(out.status).toBe('ok');
      expect(out.steps.find((s) => s.label === 'click submit')?.ok).toBe(true);
      // Field values should have been filled.
      expect(await page.locator('input[name="Name"]').inputValue()).toBe('Alice');
      expect(await page.locator('input[name="Email"]').inputValue()).toBe('a@example.com');
      // Submit handler ran.
      expect(await page.evaluate(() => document.body.dataset.submitted)).toBe('1');
      // Evidence bookkeeping.
      expect((out.evidence as { filledFields: string[] }).filledFields).toEqual([
        'Name',
        'Email',
      ]);
    } finally {
      await page.close();
    }
  });

  it('returns failed when a required field cannot be located', async () => {
    const html = `
      <!doctype html><html><body>
        <form id="f">
          <label>Name <input name="Name" /></label>
          <button type="submit">Save</button>
        </form>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await crudCreateForm.run(
        {
          formId: 'f',
          valuesByLabel: { Name: 'Alice', Email: 'a@example.com' },
        },
        ctx,
      );
      expect(out.status).toBe('failed');
      const missing = out.steps.find((s) => s.label === 'fill field "Email"');
      expect(missing?.ok).toBe(false);
      expect(missing?.detail).toContain('field not found');
      expect((out.evidence as { missingFields: string[] }).missingFields).toContain('Email');
    } finally {
      await page.close();
    }
  });

  it('returns suspicious when a 4xx network anomaly occurred during the run', async () => {
    const html = `
      <!doctype html><html><body>
        <form id="f">
          <label>Name <input name="Name" /></label>
          <button type="submit">Save</button>
        </form>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      // Synthetic network log: a 500 fired during the run.
      const network: NetworkAnomaly[] = [
        {
          ts: Date.now() + 100, // future-relative; freshAnomalies filters >= startedAt
          status: 500,
          method: 'POST',
          url: 'https://example.test/api/items',
          resourceType: 'fetch',
        },
      ];
      const ctx = makeContext(page, network);
      const out = await crudCreateForm.run(
        { formId: 'f', valuesByLabel: { Name: 'Alice' } },
        ctx,
      );
      expect(out.status).toBe('suspicious');
      expect(out.signals.networkAnomalies).toHaveLength(1);
      expect(out.signals.networkAnomalies[0].status).toBe(500);
    } finally {
      await page.close();
    }
  });
});

// ---------- crud_edit_first_row --------------------------------------------

describe('crud_edit_first_row', () => {
  it('opens edit on row 1, modifies a field, clicks save, returns ok', async () => {
    const html = `
      <!doctype html><html><body>
        <table>
          <tbody>
            <tr><td>Alice</td><td><button aria-label="Edit">Edit</button></td></tr>
            <tr><td>Bob</td><td><button aria-label="Edit">Edit</button></td></tr>
          </tbody>
        </table>
        <div id="editor" hidden>
          <label>Name <input name="Name" value="" /></label>
          <button type="submit" id="save">Save</button>
        </div>
        <script>
          document.querySelectorAll('button[aria-label="Edit"]').forEach((b, i) => {
            b.addEventListener('click', () => {
              const editor = document.getElementById('editor');
              editor.hidden = false;
              editor.dataset.row = String(i + 1);
            });
          });
          document.getElementById('save').addEventListener('click', (e) => {
            e.preventDefault();
            document.body.dataset.saved = '1';
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await crudEditFirstRow.run(
        {
          tableId: 't',
          fieldUpdates: { Name: 'Alice (edited)' },
          verifyPersistence: false,
        },
        ctx,
      );
      expect(out.status).toBe('ok');
      const openStep = out.steps.find((s) => s.label.startsWith('open edit on row 1'));
      expect(openStep?.ok).toBe(true);
      expect(await page.locator('input[name="Name"]').inputValue()).toBe('Alice (edited)');
      expect(await page.evaluate(() => document.body.dataset.saved)).toBe('1');
    } finally {
      await page.close();
    }
  });
});

// ---------- crud_edit_specific_row -----------------------------------------

describe('crud_edit_specific_row', () => {
  it('targets a specific row index', async () => {
    const html = `
      <!doctype html><html><body>
        <table>
          <tbody>
            <tr><td>Alice</td><td><button aria-label="Edit">Edit</button></td></tr>
            <tr><td>Bob</td><td><button aria-label="Edit">Edit</button></td></tr>
            <tr><td>Carol</td><td><button aria-label="Edit">Edit</button></td></tr>
          </tbody>
        </table>
        <div id="editor" hidden>
          <label>Name <input name="Name" /></label>
          <button type="submit">Save</button>
        </div>
        <script>
          document.querySelectorAll('button[aria-label="Edit"]').forEach((b, i) => {
            b.addEventListener('click', () => {
              document.body.dataset.editedRow = String(i + 1);
              document.getElementById('editor').hidden = false;
            });
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await crudEditSpecificRow.run(
        {
          tableId: 't',
          rowIndex: 3,
          fieldUpdates: { Name: 'Carol (edited)' },
          verifyPersistence: false,
        },
        ctx,
      );
      expect(out.status).toBe('ok');
      expect(await page.evaluate(() => document.body.dataset.editedRow)).toBe('3');
    } finally {
      await page.close();
    }
  });
});

// ---------- crud_delete_first_row ------------------------------------------

describe('crud_delete_first_row', () => {
  it('clicks delete, confirms, verifies row removed', async () => {
    const html = `
      <!doctype html><html><body>
        <table>
          <tbody>
            <tr><td>Alice</td><td><button aria-label="Delete">Delete</button></td></tr>
            <tr><td>Bob</td><td><button aria-label="Delete">Delete</button></td></tr>
          </tbody>
        </table>
        <div id="confirm" hidden>
          <button type="button">Confirm</button>
        </div>
        <script>
          let pending = null;
          document.querySelectorAll('button[aria-label="Delete"]').forEach((b) => {
            b.addEventListener('click', () => {
              pending = b.closest('tr');
              document.getElementById('confirm').hidden = false;
            });
          });
          document.querySelector('#confirm button').addEventListener('click', () => {
            if (pending) pending.remove();
            document.getElementById('confirm').hidden = true;
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await crudDeleteFirstRow.run({ tableId: 't' }, ctx);
      expect(out.status).toBe('ok');
      expect(out.steps.find((s) => s.label === 'verify row removed')?.ok).toBe(true);
      expect(await page.locator('tbody tr').count()).toBe(1);
      // The remaining row should be Bob.
      expect(await page.locator('tbody tr td').first().textContent()).toBe('Bob');
    } finally {
      await page.close();
    }
  });
});

// ---------- crud_duplicate_row ----------------------------------------------

describe('crud_duplicate_row', () => {
  it('adds a duplicated row when Duplicate is clicked', async () => {
    const html = `
      <!doctype html><html><body>
        <table>
          <tbody>
            <tr><td>Alice</td><td><button aria-label="Duplicate">Duplicate</button></td></tr>
          </tbody>
        </table>
        <script>
          document.querySelectorAll('button[aria-label="Duplicate"]').forEach((b) => {
            b.addEventListener('click', () => {
              const tr = b.closest('tr');
              const copy = tr.cloneNode(true);
              tr.parentNode.appendChild(copy);
            });
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await crudDuplicateRow.run({ tableId: 't', rowIndex: 1 }, ctx);
      expect(out.status).toBe('ok');
      expect(await page.locator('tbody tr').count()).toBe(2);
    } finally {
      await page.close();
    }
  });
});

// ---------- crud_archive_unarchive -----------------------------------------

describe('crud_archive_unarchive', () => {
  it('archives then unarchives the row when both affordances are present', async () => {
    const html = `
      <!doctype html><html><body>
        <table>
          <tbody>
            <tr>
              <td>Alice</td>
              <td>
                <button aria-label="Archive">Archive</button>
                <button aria-label="Unarchive" hidden>Unarchive</button>
              </td>
            </tr>
          </tbody>
        </table>
        <script>
          const archiveBtn = document.querySelector('button[aria-label="Archive"]');
          const unarchiveBtn = document.querySelector('button[aria-label="Unarchive"]');
          archiveBtn.addEventListener('click', () => {
            document.body.dataset.archived = '1';
            archiveBtn.hidden = true;
            unarchiveBtn.hidden = false;
          });
          unarchiveBtn.addEventListener('click', () => {
            document.body.dataset.unarchived = '1';
            unarchiveBtn.hidden = true;
            archiveBtn.hidden = false;
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await crudArchiveUnarchive.run({ tableId: 't', rowIndex: 1 }, ctx);
      expect(out.status).toBe('ok');
      expect(await page.evaluate(() => document.body.dataset.archived)).toBe('1');
      expect(await page.evaluate(() => document.body.dataset.unarchived)).toBe('1');
    } finally {
      await page.close();
    }
  });
});

// ---------- crud_bulk_action ------------------------------------------------

describe('crud_bulk_action', () => {
  it('selects rows and applies the named bulk action', async () => {
    const html = `
      <!doctype html><html><body>
        <button id="bulk-delete">Delete</button>
        <table>
          <tbody>
            <tr><td><input type="checkbox" /></td><td>Alice</td></tr>
            <tr><td><input type="checkbox" /></td><td>Bob</td></tr>
            <tr><td><input type="checkbox" /></td><td>Carol</td></tr>
          </tbody>
        </table>
        <script>
          document.getElementById('bulk-delete').addEventListener('click', () => {
            document.querySelectorAll('tbody tr').forEach((tr) => {
              const cb = tr.querySelector('input[type="checkbox"]');
              if (cb && cb.checked) tr.remove();
            });
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await crudBulkAction.run(
        { tableId: 't', action: 'Delete', rowIndices: [1, 3] },
        ctx,
      );
      expect(out.status).toBe('ok');
      expect((out.evidence as { rowsSelected: number }).rowsSelected).toBe(2);
      const remaining = await page.locator('tbody tr').count();
      expect(remaining).toBe(1);
      expect(await page.locator('tbody tr td').nth(1).textContent()).toBe('Bob');
    } finally {
      await page.close();
    }
  });
});

// ---------- registry --------------------------------------------------------

describe('registerCrudPlaybooks', () => {
  it('registers all 7 playbooks', () => {
    const r = new PlaybookRegistry();
    registerCrudPlaybooks(r);
    expect(r.size()).toBe(7);
    const names = r.list().map((p) => p.name).sort();
    expect(names).toEqual(
      [
        'crud_archive_unarchive',
        'crud_bulk_action',
        'crud_create_form',
        'crud_delete_first_row',
        'crud_duplicate_row',
        'crud_edit_first_row',
        'crud_edit_specific_row',
      ].sort(),
    );
  });
});
