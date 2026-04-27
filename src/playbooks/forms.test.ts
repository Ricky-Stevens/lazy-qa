import { type Browser, chromium, type Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteMapAccessor } from '../crawler/types.ts';
import { createLogger } from '../logging/logger.ts';
import type { FormSpec, PageModel } from '../page-model/types.ts';
import { fillAndVerify } from './forms.ts';
import type { PlaybookContext } from './framework.ts';

// SiteMapAccessor requires `recordVisit`, `recordPlaybookOutcome`, `serialize`,
// and `listXUntested` methods all accepting a `playbook: string` argument.
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

// FormSpec uses `formLocator` (not `selector`); submit/cancel are ActionRef with `.locator`.
// FormFieldSpec has `locator`, `label`, `type`, `required`, `constraints` — no `id` or `name`.
// Field matching in fill_and_verify is by `label` (case-insensitive).
function makeForm(overrides: Partial<FormSpec> = {}): FormSpec {
  return {
    id: 'frm-login',
    formLocator: '#login-form',
    name: 'Login',
    fields: [
      {
        locator: '#username',
        label: 'Username',
        type: 'text',
        required: true,
        constraints: {},
      },
      {
        locator: '#password',
        label: 'Password',
        type: 'password',
        required: true,
        constraints: {},
      },
    ],
    submit: {
      locator: '#submit-btn',
      label: 'Sign in',
      type: 'button',
      disabled: false,
      intent: 'action',
    },
    extraActions: [],
    inModal: false,
    ...overrides,
  };
}

function makeContext(page: Page, form: FormSpec): PlaybookContext {
  const model: PageModel = {
    url: page.url(),
    route: page.url(),
    title: 'Test',
    forms: [form],
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

describe('fill_and_verify — happy paths', () => {
  let browser: Browser;
  let page: Page;

  beforeEach(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterEach(async () => {
    await browser.close();
  });

  it('fills text fields and reports ok with no verify checks', async () => {
    await page.setContent(`
      <form id="login-form">
        <input id="username" name="username" />
        <input id="password" name="password" type="password" />
        <button id="submit-btn" type="submit">Sign in</button>
      </form>
    `);
    const form = makeForm();
    const ctx = makeContext(page, form);
    const result = await fillAndVerify.run(
      { formId: 'frm-login', values: { Username: 'alice', Password: 'secret' }, submit: false },
      ctx,
    );
    expect(result.status).toBe('ok');
    expect((result.evidence.valuesFilled as Record<string, string>).Username).toBe('alice');
    expect(await page.locator('#username').inputValue()).toBe('alice');
  });

  it('returns failed when formId is not in the page model', async () => {
    await page.setContent('<div>no forms here</div>');
    const ctx = makeContext(page, makeForm());
    const result = await fillAndVerify.run({ formId: 'frm-does-not-exist', values: {} }, ctx);
    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/not found/);
  });

  it('flags suspicious when a verify check fails', async () => {
    await page.setContent(`
      <form id="login-form" action="javascript:void(0)">
        <input id="username" name="username" />
        <button id="submit-btn" type="submit">Sign in</button>
      </form>
    `);
    const ctx = makeContext(page, makeForm());
    const result = await fillAndVerify.run(
      {
        formId: 'frm-login',
        values: { Username: 'alice' },
        verify: [{ kind: 'url-changed' }],
      },
      ctx,
    );
    expect(result.status).toBe('suspicious');
    const verifyResults = result.evidence.verifyResults as { ok: boolean }[];
    expect(verifyResults.some((r) => !r.ok)).toBe(true);
  });

  it('returns ok when all verify checks pass', async () => {
    // Route to a real origin so history.pushState('/dashboard') produces a
    // valid URL that the verify checks can match against.
    await page.route('**/test-app/login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <form id="login-form" onsubmit="event.preventDefault(); history.pushState({}, '', '/dashboard');">
            <input id="username" name="username" />
            <button id="submit-btn" type="submit">Sign in</button>
          </form>
        `,
      });
    });
    await page.goto('https://test-app.local/test-app/login', { waitUntil: 'domcontentloaded' });
    const ctx = makeContext(page, makeForm());
    const result = await fillAndVerify.run(
      {
        formId: 'frm-login',
        values: { Username: 'alice' },
        verify: [
          { kind: 'url-matches', pattern: '/dashboard' },
          { kind: 'redirect-to', pathContains: 'dashboard' },
        ],
      },
      ctx,
    );
    expect(result.status).toBe('ok');
    const verifyResults = result.evidence.verifyResults as { ok: boolean }[];
    expect(verifyResults.every((r) => r.ok)).toBe(true);
  });
});
