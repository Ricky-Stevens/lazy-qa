/**
 * search.ts integration tests. Use real chromium + setContent + page.route()
 * mocks for any reload-based playbooks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { globalSearch, registerSearchPlaybooks, savedViews } from './search.ts';
import { PlaybookRegistry, type PlaybookContext } from './framework.ts';
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
    allowedHosts: [],
  };
}

async function fresh(html: string): Promise<Page> {
  const p = await context.newPage();
  await p.setContent(html, { waitUntil: 'domcontentloaded' });
  return p;
}

// ─── global_search ───────────────────────────────────────────────────────────

describe('global_search', () => {
  it('records count 0 for a query that produces no rows', async () => {
    const html = `
      <!doctype html><html><body>
        <div role="search">
          <input aria-label="Search" />
        </div>
        <table>
          <tbody id="rows"></tbody>
        </table>
        <script>
          const input = document.querySelector('input[aria-label="Search"]');
          const rows = document.getElementById('rows');
          input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const q = input.value;
            // Render 2 rows for any non-empty query that contains the letter 'z',
            // otherwise render 0 rows. Default-queries include 'matchnothing-zzz'
            // which we deliberately want to produce 0 rows even though it has 'z'.
            rows.innerHTML = '';
            if (q && q !== 'matchnothing-zzz' && /z/.test(q)) {
              rows.innerHTML = '<tr><td>x</td></tr><tr><td>y</td></tr>';
            }
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await globalSearch.run({ queries: ['matchnothing-zzz'] }, ctx);
      expect(out.status).toBe('ok');
      const results = (out.evidence as { results: Array<{ query: string; count: number }> }).results;
      expect(results).toHaveLength(1);
      expect(results[0].query).toBe('matchnothing-zzz');
      expect(results[0].count).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('returns failed when no global search input is present', async () => {
    const html = `<!doctype html><html><body><h1>hi</h1></body></html>`;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await globalSearch.run({ queries: ['anything'] }, ctx);
      expect(out.status).toBe('failed');
      const step = out.steps.find((s) => s.label === 'locate global search input');
      expect(step?.ok).toBe(false);
    } finally {
      await page.close();
    }
  });
});

// ─── saved_views ─────────────────────────────────────────────────────────────

describe('saved_views', () => {
  it('returns suspicious when row count after reload differs from before', async () => {
    // After reload the route mock returns HTML with 0 rows, so view appears not restored.
    const beforeHtml = `
      <!doctype html><html><body>
        <button>Save view</button>
        <table><tbody>
          <tr><td>a</td></tr>
          <tr><td>b</td></tr>
        </tbody></table>
      </body></html>
    `;
    const afterReloadHtml = `
      <!doctype html><html><body>
        <button>Save view</button>
        <table><tbody></tbody></table>
      </body></html>
    `;
    const url = 'https://search-test.local/views';
    const page = await context.newPage();
    let served = 0;
    await page.route(/^https:\/\/search-test\.local\/views.*/, (route) => {
      served += 1;
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: served === 1 ? beforeHtml : afterReloadHtml,
      });
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const ctx = makeContext(page);
      const out = await savedViews.run({ tableId: 't', viewName: 'My View' }, ctx);
      expect(out.status).toBe('suspicious');
      expect((out.evidence as { viewRestored: boolean }).viewRestored).toBe(false);
    } finally {
      await page.close();
    }
  });
});

// ─── registry ────────────────────────────────────────────────────────────────

describe('registerSearchPlaybooks', () => {
  it('registers all 3 search playbooks', () => {
    const r = new PlaybookRegistry();
    registerSearchPlaybooks(r);
    expect(r.size()).toBe(3);
    const names = r.list().map((p) => p.name).sort();
    expect(names).toEqual(['filter_combinations', 'global_search', 'saved_views']);
  });
});
