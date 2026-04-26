/**
 * async.ts integration tests.
 */

// Ambient `document` for browser-side evaluate callbacks (lib.dom not in tsconfig).
declare const document: {
  body: { dataset: Record<string, string | undefined> };
  getElementById(id: string): { addEventListener(t: string, h: () => void): void } | null;
  createElement(tag: string): { setAttribute(k: string, v: string): void; textContent: string };
};

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import {
  asyncActionPolling,
  liveUpdatesAudit,
  notificationLifecycle,
  registerAsyncPlaybooks,
} from './async.ts';
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
  };
}

async function fresh(html: string): Promise<Page> {
  const p = await context.newPage();
  await p.setContent(html, { waitUntil: 'domcontentloaded' });
  return p;
}

// ─── notification_lifecycle ──────────────────────────────────────────────────

describe('notification_lifecycle', () => {
  it('returns ok when a toast appears and disappears after click', async () => {
    const html = `
      <!doctype html><html><body>
        <button id="trigger">Save</button>
        <div id="container"></div>
        <script>
          document.getElementById('trigger').addEventListener('click', () => {
            const c = document.getElementById('container');
            const toast = document.createElement('div');
            toast.setAttribute('role', 'alert');
            toast.setAttribute('data-testid', 'toast');
            toast.innerHTML = 'Saved!<button aria-label="Close" type="button">x</button>';
            c.appendChild(toast);
            toast.querySelector('[aria-label="Close"]').addEventListener('click', () => {
              toast.remove();
            });
          });
        </script>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await notificationLifecycle.run({ triggerLocator: '#trigger' }, ctx);
      expect((out.evidence as { toastAppeared: boolean }).toastAppeared).toBe(true);
      expect((out.evidence as { toastDismissed: boolean }).toastDismissed).toBe(true);
      expect(out.status).toBe('ok');
    } finally {
      await page.close();
    }
  }, 20_000);

  it('returns failed when the trigger locator does not resolve', async () => {
    const html = `<!doctype html><html><body><h1>x</h1></body></html>`;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await notificationLifecycle.run({ triggerLocator: '#nope' }, ctx);
      expect(out.status).toBe('failed');
    } finally {
      await page.close();
    }
  });
});

// ─── async_action_polling ────────────────────────────────────────────────────

describe('async_action_polling', () => {
  it('returns suspicious when state never changes within maxWaitMs', async () => {
    const html = `<!doctype html><html><body>
      <button id="b">Do nothing</button>
    </body></html>`;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await asyncActionPolling.run(
        { actionLocator: '#b', maxWaitMs: 1_500 },
        ctx,
      );
      expect(out.status).toBe('suspicious');
      expect((out.evidence as { stateChanged: boolean }).stateChanged).toBe(false);
    } finally {
      await page.close();
    }
  }, 10_000);
});

// ─── live_updates_audit ──────────────────────────────────────────────────────

describe('live_updates_audit', () => {
  it('records 0 activity on a page with no live updates within a short observe window', async () => {
    const html = `<!doctype html><html><body><h1>Static</h1></body></html>`;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await liveUpdatesAudit.run(
        { route: page.url(), observeMs: 500 },
        ctx,
      );
      expect(['ok', 'suspicious']).toContain(out.status);
      expect((out.evidence as { observedCount: number }).observedCount).toBe(0);
    } finally {
      await page.close();
    }
  }, 10_000);
});

// ─── registry ────────────────────────────────────────────────────────────────

describe('registerAsyncPlaybooks', () => {
  it('registers all 3 async playbooks', () => {
    const r = new PlaybookRegistry();
    registerAsyncPlaybooks(r);
    expect(r.size()).toBe(3);
    const names = r.list().map((p) => p.name).sort();
    expect(names).toEqual(['async_action_polling', 'live_updates_audit', 'notification_lifecycle']);
  });
});
