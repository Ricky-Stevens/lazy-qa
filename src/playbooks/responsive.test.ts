/**
 * Tests for responsive.ts — responsiveCheck playbook metadata,
 * viewport switching, element disappearance detection, hamburger
 * menu fallback, and overflow detection.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PageModel } from '../page-model/types.ts';
import type { PlaybookContext } from './framework.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePageModel(overrides: Partial<PageModel> = {}): PageModel {
  return {
    url: 'http://localhost:3000/page',
    route: '/page',
    title: 'Test Page',
    forms: [],
    tables: [],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareInteractives: [],
    bareFields: [],
    network: [],
    console: [],
    textHash: 'abc123',
    looksBroken: false,
    interactiveCount: 0,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockPage(opts: {
  gotoThrows?: Error | null;
  hasOverflow?: boolean;
  hamburgerSelectors?: string[];
}) {
  const { gotoThrows = null, hasOverflow = false, hamburgerSelectors = [] } = opts;
  let currentViewport = { width: 1280, height: 720 };

  return {
    goto: vi.fn().mockImplementation(() => {
      if (gotoThrows) throw gotoThrows;
      return Promise.resolve();
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    viewportSize: vi.fn().mockImplementation(() => ({ ...currentViewport })),
    setViewportSize: vi.fn().mockImplementation((v: { width: number; height: number }) => {
      currentViewport = v;
      return Promise.resolve();
    }),
    evaluate: vi.fn().mockResolvedValue(hasOverflow),
    locator: vi.fn().mockImplementation((sel: string) => ({
      count: vi.fn().mockImplementation(() => {
        return Promise.resolve(hamburgerSelectors.includes(sel) ? 1 : 0);
      }),
    })),
  };
}

function makeMockContext(
  page: ReturnType<typeof makeMockPage>,
  pageModelSequence: PageModel[],
): PlaybookContext {
  let modelIdx = 0;
  return {
    page: page as unknown as PlaybookContext['page'],
    pageModel: vi.fn().mockImplementation(() => {
      const model = pageModelSequence[modelIdx] ?? pageModelSequence[pageModelSequence.length - 1]!;
      modelIdx++;
      return Promise.resolve(model);
    }),
    siteMap: {} as PlaybookContext['siteMap'],
    agentId: 'test-agent',
    persona: 'test',
    runDir: '/tmp/test-run',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as PlaybookContext['logger'],
    allowedHosts: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('responsiveCheck', () => {
  describe('metadata', () => {
    it('has correct name', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      expect(responsiveCheck.name).toBe('responsive_check');
    });

    it('is categorized as responsive', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      expect(responsiveCheck.categories).toContain('responsive');
    });

    it('has estimatedDurationMs set', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      expect(responsiveCheck.estimatedDurationMs).toBeGreaterThan(0);
    });

    it('requires route in inputShape', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      expect(responsiveCheck.inputShape).toHaveProperty('route');
    });
  });

  describe('run — navigation failure', () => {
    it('returns failed outcome when goto throws', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      const page = makeMockPage({ gotoThrows: new Error('timeout') });
      const desktopModel = makePageModel();
      const ctx = makeMockContext(page, [desktopModel]);

      const result = await responsiveCheck.run({ route: 'http://localhost:3000/page' }, ctx);

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('Failed to navigate');
    });
  });

  describe('run — all structure preserved', () => {
    it('returns ok when forms/tables/nav are present at all viewports', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      const model = makePageModel({
        forms: [{ id: 'f1', formLocator: 'form', name: 'Form 1', fields: [], extraActions: [], inModal: false }],
        tables: [{ id: 't1', tableLocator: 'table', name: 'Table 1', columns: [], rowCount: 5, rowActions: [], bulkActions: [], filters: [] }],
        navLinks: [{ locator: 'a', label: 'Home', type: 'link', disabled: false, intent: 'navigate' }],
        toolbars: [],
        bareInteractives: [],
      });
      const page = makeMockPage({ hasOverflow: false });
      // Desktop, mobile, tablet — all same model
      const ctx = makeMockContext(page, [model, model, model]);

      const result = await responsiveCheck.run({ route: 'http://localhost:3000/page' }, ctx);

      expect(result.status).toBe('ok');
      expect(result.summary).toContain('preserved');
    });
  });

  describe('run — forms disappear at mobile', () => {
    it('returns suspicious when forms disappear at mobile', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      const desktopModel = makePageModel({
        forms: [{ id: 'f1', formLocator: 'form', name: 'Form 1', fields: [], extraActions: [], inModal: false }],
      });
      const mobileModel = makePageModel({ forms: [] });
      const tabletModel = makePageModel({
        forms: [{ id: 'f1', formLocator: 'form', name: 'Form 1', fields: [], extraActions: [], inModal: false }],
      });
      const page = makeMockPage({ hasOverflow: false });
      const ctx = makeMockContext(page, [desktopModel, mobileModel, tabletModel]);

      const result = await responsiveCheck.run({ route: 'http://localhost:3000/page' }, ctx);

      expect(result.status).toBe('suspicious');
      expect(result.summary).toContain('form(s) disappeared');
    });
  });

  describe('run — tables disappear at tablet', () => {
    it('returns suspicious when tables disappear at tablet', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      const desktopModel = makePageModel({
        tables: [{ id: 't1', tableLocator: 'table', name: 'Table 1', columns: [], rowCount: 5, rowActions: [], bulkActions: [], filters: [] }],
      });
      const mobileModel = makePageModel({
        tables: [{ id: 't1', tableLocator: 'table', name: 'Table 1', columns: [], rowCount: 5, rowActions: [], bulkActions: [], filters: [] }],
      });
      const tabletModel = makePageModel({ tables: [] });
      const page = makeMockPage({ hasOverflow: false });
      const ctx = makeMockContext(page, [desktopModel, mobileModel, tabletModel]);

      const result = await responsiveCheck.run({ route: 'http://localhost:3000/page' }, ctx);

      expect(result.status).toBe('suspicious');
      expect(result.summary).toContain('table(s) disappeared');
    });
  });

  describe('run — nav links with hamburger', () => {
    it('does not flag nav link disappearance when hamburger toggle exists', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      const desktopModel = makePageModel({
        navLinks: [
          { locator: 'a', label: 'Home', type: 'link', disabled: false, intent: 'navigate' },
          { locator: 'a', label: 'About', type: 'link', disabled: false, intent: 'navigate' },
        ],
      });
      const mobileModel = makePageModel({ navLinks: [] });
      const tabletModel = makePageModel({
        navLinks: [
          { locator: 'a', label: 'Home', type: 'link', disabled: false, intent: 'navigate' },
        ],
      });
      const page = makeMockPage({
        hasOverflow: false,
        hamburgerSelectors: ['[aria-label*="menu" i]'],
      });
      const ctx = makeMockContext(page, [desktopModel, mobileModel, tabletModel]);

      const result = await responsiveCheck.run({ route: 'http://localhost:3000/page' }, ctx);

      expect(result.status).toBe('ok');
      expect(result.steps.some((s) => s.label.includes('mobile menu toggle'))).toBe(true);
    });
  });

  describe('run — horizontal overflow', () => {
    it('returns suspicious when horizontal overflow detected at mobile', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      const model = makePageModel();
      const page = makeMockPage({ hasOverflow: true });
      const ctx = makeMockContext(page, [model, model, model]);

      const result = await responsiveCheck.run({ route: 'http://localhost:3000/page' }, ctx);

      expect(result.status).toBe('suspicious');
      expect(result.summary).toContain('overflow');
    });
  });

  describe('viewport restoration', () => {
    it('restores original viewport after checks', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      const model = makePageModel();
      const page = makeMockPage({ hasOverflow: false });
      const ctx = makeMockContext(page, [model, model, model]);

      await responsiveCheck.run({ route: 'http://localhost:3000/page' }, ctx);

      // setViewportSize should have been called to restore viewport
      const calls = page.setViewportSize.mock.calls;
      // Last call should restore original viewport (1280x720)
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toEqual({ width: 1280, height: 720 });
    });
  });

  describe('evidence shape', () => {
    it('includes desktop, mobile, tablet snapshots', async () => {
      const { responsiveCheck } = await import('./responsive.ts');
      const model = makePageModel({
        forms: [{ id: 'f1', formLocator: 'form', name: 'Form 1', fields: [], extraActions: [], inModal: false }],
      });
      const page = makeMockPage({ hasOverflow: false });
      const ctx = makeMockContext(page, [model, model, model]);

      const result = await responsiveCheck.run({ route: 'http://localhost:3000/page' }, ctx);

      expect(result.evidence).toHaveProperty('desktop');
      expect(result.evidence).toHaveProperty('mobile');
      expect(result.evidence).toHaveProperty('tablet');
      expect(result.evidence).toHaveProperty('desktopElementCount');
    });
  });
});
