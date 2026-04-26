/**
 * chaos.ts integration tests. Each test launches a real chromium and uses
 * page.setContent() to construct a synthetic UI; the playbooks are run with a
 * fake PlaybookContext.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import {
  backForwardChaos,
  keyboardShortcuts,
  refreshDuringSave,
  registerChaosPlaybooks,
  tabCloseDuringSave,
  zoomLevelsAudit,
} from './chaos.ts';
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

// ─── refresh_during_save ─────────────────────────────────────────────────────

/** Mock page.route() so that fetching the test URL returns the supplied HTML. */
async function freshOnRoute(html: string, url: string): Promise<Page> {
  const p = await context.newPage();
  // Match anything on the same host so form-submit navigations re-serve.
  const pattern = new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*`);
  await p.route(pattern, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  return p;
}

describe('refresh_during_save', () => {
  it('records observedState=lost (suspicious) when the form is still visible after reload', async () => {
    const html = `<!doctype html><html><body>
      <form id="myform">
        <label>Name <input name="Name" /></label>
        <button type="submit">Save</button>
      </form>
    </body></html>`;
    const page = await freshOnRoute(html, 'https://chaos-test.local/refresh');
    try {
      const ctx = makeContext(page);
      const out = await refreshDuringSave.run(
        { formId: 'myform', valuesByLabel: { Name: 'Alice' } },
        ctx,
      );
      // After reload the form is still there (mocked HTML re-served) — that's "lost".
      expect(out.status).toBe('suspicious');
      expect((out.evidence as { observedState: string }).observedState).toBe('lost');
      expect(out.steps.find((s) => s.label === 'reload mid-save')?.ok).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('returns failed when no submit affordance exists', async () => {
    const html = `<!doctype html><html><body>
      <form id="f">
        <label>Name <input name="Name" /></label>
      </form>
    </body></html>`;
    const page = await freshOnRoute(html, 'https://chaos-test.local/no-submit');
    try {
      const ctx = makeContext(page);
      const out = await refreshDuringSave.run(
        { formId: 'f', valuesByLabel: { Name: 'Alice' } },
        ctx,
      );
      expect(out.status).toBe('failed');
      const submitStep = out.steps.find((s) => s.label === 'click submit');
      expect(submitStep?.ok).toBe(false);
    } finally {
      await page.close();
    }
  });
});

// ─── back_forward_chaos ──────────────────────────────────────────────────────

describe('back_forward_chaos', () => {
  it('runs without throwing on a single-page document', async () => {
    const html = `<!doctype html><html><body><button>Hi</button></body></html>`;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await backForwardChaos.run({ flow: 'simple flow' }, ctx);
      // No history → goBack/goForward will error, but we capture, not throw.
      expect(['ok', 'failed', 'suspicious']).toContain(out.status);
      expect(out.steps.length).toBeGreaterThanOrEqual(2);
    } finally {
      await page.close();
    }
  });
});

// ─── tab_close_during_save ───────────────────────────────────────────────────

describe('tab_close_during_save', () => {
  it('returns suspicious when no beforeunload warning is observed', async () => {
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
      const out = await tabCloseDuringSave.run({ formId: 'f' }, ctx);
      expect(out.status).toBe('suspicious');
      expect((out.evidence as { beforeUnloadObserved: boolean }).beforeUnloadObserved).toBe(false);
    } finally {
      await page.close();
    }
  });
});

// ─── keyboard_shortcuts ──────────────────────────────────────────────────────

describe('keyboard_shortcuts', () => {
  it('always returns ok and records an observed effect for each shortcut', async () => {
    const html = `<!doctype html><html><body><input id="i" /></body></html>`;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await keyboardShortcuts.run({ scope: 'global' }, ctx);
      expect(out.status).toBe('ok');
      const observed = (out.evidence as { observed: Record<string, string> }).observed;
      expect(Object.keys(observed)).toEqual(
        expect.arrayContaining(['Enter', 'Escape', 'Tab', 'Control+s', 'Control+z']),
      );
    } finally {
      await page.close();
    }
  });
});

// ─── zoom_levels_audit ───────────────────────────────────────────────────────

describe('zoom_levels_audit', () => {
  it('records per-level dims and returns a status (ok|suspicious)', async () => {
    const html = `
      <!doctype html><html><body>
        <button>One</button><button>Two</button>
      </body></html>
    `;
    const page = await fresh(html);
    try {
      const ctx = makeContext(page);
      const out = await zoomLevelsAudit.run({ levels: [100, 110] }, ctx);
      expect(['ok', 'suspicious']).toContain(out.status);
      const perLevel = (out.evidence as { perLevel: Record<string, { count: number }> }).perLevel;
      expect(perLevel['100']).toBeDefined();
      expect(perLevel['110']).toBeDefined();
    } finally {
      await page.close();
    }
  });
});

// ─── registry ────────────────────────────────────────────────────────────────

describe('registerChaosPlaybooks', () => {
  it('registers all 6 chaos playbooks', () => {
    const r = new PlaybookRegistry();
    registerChaosPlaybooks(r);
    expect(r.size()).toBe(6);
    const names = r.list().map((p) => p.name).sort();
    expect(names).toEqual(
      [
        'back_forward_chaos',
        'concurrent_edits_simulator',
        'keyboard_shortcuts',
        'refresh_during_save',
        'tab_close_during_save',
        'zoom_levels_audit',
      ].sort(),
    );
  });
});
