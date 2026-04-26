/**
 * Tests for button playbooks.
 */

import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SiteMapAccessor } from '../crawler/types.ts';
import type { ActionRef, PageModel } from '../page-model/types.ts';
import { __buttonPlaybooks } from './buttons.ts';
import type { PlaybookContext } from './framework.ts';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

function blankPageModel(extra: Partial<PageModel> = {}): PageModel {
  return {
    url: 'about:blank',
    route: 'about:blank',
    title: '',
    forms: [],
    tables: [],
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
    ...extra,
  };
}

function stubSiteMap(): SiteMapAccessor {
  return {
    getRoute: () => undefined,
    getPageModel: () => undefined,
    listAllRoutes: () => [],
    listUnvisitedRoutes: () => [],
    listFormsUntested: () => [],
    listTablesUntested: () => [],
    listModalsUntested: () => [],
    listWizardsUntested: () => [],
    recordVisit: () => undefined,
    recordPlaybookOutcome: () => undefined,
    upsertRoute: () => undefined,
    serialize: () => ({
      startedAt: new Date().toISOString(),
      rootUrl: '',
      routes: {},
      pageModels: {},
    }),
  };
}

function noopLogger() {
  const fn = () => undefined;
  const logger = { debug: fn, info: fn, warn: fn, error: fn, child: () => logger };
  return logger;
}

function makeCtx(page: Page, model: PageModel): PlaybookContext {
  return {
    page,
    pageModel: async () => model,
    siteMap: stubSiteMap(),
    agentId: 'test',
    persona: '',
    runDir: '/tmp/regress-test',
    logger: noopLogger(),
  };
}

function actionRef(partial: Partial<ActionRef> & { locator: string; label: string }): ActionRef {
  return {
    type: 'button',
    disabled: false,
    intent: 'navigate',
    ...partial,
  };
}

describe('button_navigation_audit', () => {
  it('clicks each navigation link, records URL change, navigates back', async () => {
    const page = await browser.newPage();
    // Use a single-document app that swaps the URL via history.pushState +
    // history.back, so we don't need a real HTTP server.
    await page.goto('https://example.com/regress/home');
    await page.route('**/*', (route) => {
      const url = route.request().url();
      const path = new URL(url).pathname;
      const heading = path.split('/').pop() ?? 'Home';
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<html><body>
          <h1 id="h">${heading}</h1>
          <a id="a1" href="/regress/alpha">Alpha</a>
          <a id="a2" href="/regress/beta">Beta</a>
          <a id="a3" href="/regress/gamma">Gamma</a>
        </body></html>`,
      });
    });
    await page.goto('https://example.com/regress/home');

    const navLinks: ActionRef[] = [
      actionRef({ locator: '#a1', label: 'Alpha', type: 'link', intent: 'navigate' }),
      actionRef({ locator: '#a2', label: 'Beta', type: 'link', intent: 'navigate' }),
      actionRef({ locator: '#a3', label: 'Gamma', type: 'link', intent: 'navigate' }),
    ];
    const model = blankPageModel({ navLinks });
    const ctx = makeCtx(page, model);

    const outcome = await __buttonPlaybooks.navigationAudit.run({ scope: 'nav' }, ctx);

    expect(outcome.status).toBe('ok');
    const results = (outcome.evidence as { results: Array<{ status: string; label: string }> })
      .results;
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(results.map((r) => r.label).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);

    await page.close();
  });
});

describe('button_double_click_audit', () => {
  it('double-clicking an instrumented Save button records 2 clicks', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <button id="save" data-clicks="0">Save</button>
        <script>
          const btn = document.getElementById('save');
          btn.addEventListener('click', () => {
            const n = Number(btn.dataset.clicks ?? '0') + 1;
            btn.dataset.clicks = String(n);
          });
        </script>
      </body></html>
    `);

    const bareInteractives: ActionRef[] = [
      actionRef({
        locator: '#save',
        label: 'Save',
        type: 'button',
        intent: 'action',
      }),
    ];
    const model = blankPageModel({ bareInteractives });
    const ctx = makeCtx(page, model);

    const outcome = await __buttonPlaybooks.doubleClickAudit.run(
      { scope: 'page', primaryOnly: true },
      ctx,
    );

    // No network mutations fired, so the audit should be ok.
    expect(outcome.status).toBe('ok');
    const results = (
      outcome.evidence as {
        results: Array<{ label: string; clickCount: number; duplicateMutations: unknown[] }>;
      }
    ).results;
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('Save');
    // Native dblclick fires 2 click events on the button.
    expect(results[0].clickCount).toBe(2);
    expect(results[0].duplicateMutations).toEqual([]);

    await page.close();
  });

  it('skips non-primary action buttons when primaryOnly=true', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="export">Export</button>
      <button id="save">Save</button>
    `);

    const bareInteractives: ActionRef[] = [
      actionRef({ locator: '#export', label: 'Export', type: 'button', intent: 'action' }),
      actionRef({ locator: '#save', label: 'Save', type: 'button', intent: 'action' }),
    ];
    const model = blankPageModel({ bareInteractives });
    const ctx = makeCtx(page, model);

    const outcome = await __buttonPlaybooks.doubleClickAudit.run({ scope: 'page' }, ctx);

    expect(outcome.status).toBe('ok');
    const results = (outcome.evidence as { results: Array<{ label: string }> }).results;
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('Save');

    await page.close();
  });
});
