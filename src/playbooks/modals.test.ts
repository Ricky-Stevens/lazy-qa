/**
 * Tests for modal playbooks. Uses Playwright `setContent` to render small HTML
 * harnesses; no external server needed.
 */

import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SiteMapAccessor } from '../crawler/types.ts';
import type { ModalSpec, PageModel } from '../page-model/types.ts';
import type { PlaybookContext } from './framework.ts';
import { __modalPlaybooks } from './modals.ts';

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

function modalSpec(partial: Partial<ModalSpec> & { id: string; modalLocator: string }): ModalSpec {
  return {
    name: partial.name ?? 'Test Modal',
    closers: {
      escapeWorks: true,
      clickOutsideCloses: true,
      ...(partial.closers ?? {}),
    },
    isEditScreenLike: false,
    ...partial,
  } as ModalSpec;
}

describe('modal_lifecycle', () => {
  it('closes a well-behaved HTML modal via Escape and returns ok', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="open">Open</button>
      <dialog id="m" role="dialog" aria-label="Test Modal">
        <h2>Test Modal</h2>
        <button id="x" aria-label="Close">×</button>
        <button id="cancel">Cancel</button>
      </dialog>
      <script>
        const dlg = document.getElementById('m');
        document.getElementById('open').onclick = () => dlg.showModal();
        document.getElementById('x').onclick = () => dlg.close();
        document.getElementById('cancel').onclick = () => dlg.close();
        dlg.addEventListener('cancel', (e) => { /* native Escape handler */ });
      </script>
    `);

    const spec = modalSpec({
      id: 'test-modal',
      modalLocator: 'dialog#m',
      name: 'Test Modal',
      closers: {
        escapeWorks: true,
        clickOutsideCloses: false,
        x: { locator: '#x', label: 'Close', type: 'button', disabled: false, intent: 'navigate' },
        cancel: {
          locator: '#cancel',
          label: 'Cancel',
          type: 'button',
          disabled: false,
          intent: 'navigate',
        },
      },
    });
    const model = blankPageModel({ modals: [spec] });
    const ctx = makeCtx(page, model);

    const outcome = await __modalPlaybooks.lifecycle.run(
      { modalId: 'test-modal', trigger: '#open' },
      ctx,
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.steps.some((s) => s.label === 'close via Escape key' && s.ok)).toBe(true);
    expect(outcome.steps.some((s) => s.label === 'close via X button' && s.ok)).toBe(true);
    expect(outcome.evidence.dismissedCount).toBeGreaterThanOrEqual(2);

    await page.close();
  });

  it('records failures when Escape does not close, but ok when other closers succeed', async () => {
    const page = await browser.newPage();
    // A non-native modal that ignores Escape but honours an X button click.
    await page.setContent(`
      <button id="open">Open</button>
      <div id="m" role="dialog" aria-label="Sticky Modal" style="display:none;position:fixed;top:200px;left:200px;width:200px;height:200px;background:#eee;">
        <h2>Sticky Modal</h2>
        <button id="x">×</button>
      </div>
      <script>
        const dlg = document.getElementById('m');
        document.getElementById('open').onclick = () => { dlg.style.display = 'block'; };
        document.getElementById('x').onclick = () => { dlg.style.display = 'none'; };
      </script>
    `);

    const spec = modalSpec({
      id: 'sticky',
      modalLocator: 'div#m',
      name: 'Sticky Modal',
      closers: {
        escapeWorks: false,
        clickOutsideCloses: false,
        x: { locator: '#x', label: 'Close', type: 'button', disabled: false, intent: 'navigate' },
      },
    });
    const model = blankPageModel({ modals: [spec] });
    const ctx = makeCtx(page, model);

    const outcome = await __modalPlaybooks.lifecycle.run(
      { modalId: 'sticky', trigger: '#open' },
      ctx,
    );

    // X removed the dialog, so the lifecycle is overall ok.
    expect(outcome.status).toBe('ok');
    const escapeStep = outcome.steps.find((s) => s.label === 'close via Escape key');
    expect(escapeStep?.ok).toBe(false);
    const xStep = outcome.steps.find((s) => s.label === 'close via X button');
    expect(xStep?.ok).toBe(true);

    await page.close();
  });
});

describe('modal_form_inside_save', () => {
  it('fills a modal form, submits, and verifies dismissal', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="open">New Item</button>
      <dialog id="m" role="dialog" aria-label="Create Item">
        <h2>Create Item</h2>
        <form id="f">
          <label>Name <input id="name" name="name"></label>
          <label>Description <textarea id="desc" name="desc"></textarea></label>
          <button type="submit" id="save">Save</button>
          <button type="button" id="cancel">Cancel</button>
        </form>
      </dialog>
      <script>
        const dlg = document.getElementById('m');
        document.getElementById('open').onclick = () => dlg.showModal();
        document.getElementById('cancel').onclick = (e) => { e.preventDefault(); dlg.close(); };
        document.getElementById('f').addEventListener('submit', (e) => {
          e.preventDefault();
          window.__lastSubmit = {
            name: document.getElementById('name').value,
            desc: document.getElementById('desc').value,
          };
          dlg.close();
        });
      </script>
    `);

    const spec = modalSpec({
      id: 'create-item',
      modalLocator: 'dialog#m',
      name: 'Create Item',
      primaryAction: {
        locator: '#save',
        label: 'Save',
        type: 'button',
        disabled: false,
        intent: 'action',
      },
    });
    const model = blankPageModel({ modals: [spec] });
    const ctx = makeCtx(page, model);

    const outcome = await __modalPlaybooks.formInsideSave.run(
      {
        modalId: 'create-item',
        trigger: '#open',
        valuesByLabel: { Name: 'Hello world', Description: 'Test description' },
      },
      ctx,
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.evidence.dismissed).toBe(true);
    const stored = await page.evaluate(
      () => (globalThis as unknown as { __lastSubmit?: unknown }).__lastSubmit,
    );
    expect(stored).toEqual({ name: 'Hello world', desc: 'Test description' });

    await page.close();
  });
});
