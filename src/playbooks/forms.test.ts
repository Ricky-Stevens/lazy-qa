import { type Browser, chromium, type Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteMapAccessor } from '../crawler/types.ts';
import { createLogger } from '../logging/logger.ts';
import type { FormFieldSpec, FormSpec, PageModel } from '../page-model/types.ts';
import { FUZZ_VECTORS, fieldTypeVectors, fillAndVerify, formRequiredFieldCheck } from './forms.ts';
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
    bareFields: [],
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

// ---------------------------------------------------------------------------
// Bug-fix regression tests
// ---------------------------------------------------------------------------

describe('FUZZ_VECTORS — static shape assertions (no browser needed)', () => {
  // (a) null-byte vector is an actual NUL byte, not the original 'hello world'
  it('null-byte vector contains an actual NUL byte (\\x00)', () => {
    const v = FUZZ_VECTORS.find((v) => v.id === 'null-byte');
    expect(v).toBeDefined();
    // Use charCodeAt to avoid regex control-char lint; \x00 is codepoint 0.
    expect(v?.value.split('').some((c) => c.charCodeAt(0) === 0)).toBe(true);
    expect(v?.value).not.toBe('hello world');
  });

  // (d) unicode-emoji vector is present in the list
  it('unicode-emoji vector is present', () => {
    const v = FUZZ_VECTORS.find((v) => v.id === 'unicode-emoji');
    expect(v).toBeDefined();
    // Should contain at least one emoji code point.
    expect(v?.value).toMatch(/\p{Emoji}/u);
  });

  it('unicode-zero-width vector is present', () => {
    const v = FUZZ_VECTORS.find((v) => v.id === 'unicode-zero-width');
    expect(v).toBeDefined();
  });

  it('unicode-control vector is present and contains a control char', () => {
    const v = FUZZ_VECTORS.find((v) => v.id === 'unicode-control');
    expect(v).toBeDefined();
    // Should contain at least one ASCII control character (codepoint < 32, not tab/CR/LF).
    const hasControl = v?.value
      .split('')
      .some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)));
    expect(hasControl).toBe(true);
  });

  // (g) valid happy-path vector exists
  it('valid happy-path vector is present with expectError=false', () => {
    const v = FUZZ_VECTORS.find((v) => v.id === 'valid');
    expect(v).toBeDefined();
    expect(v?.expectError).toBe(false);
  });
});

describe('fieldTypeVectors — email field (Bug 5)', () => {
  function makeEmailField(overrides: Partial<FormFieldSpec> = {}): FormFieldSpec {
    return {
      locator: '#email',
      label: 'Email',
      type: 'email',
      required: true,
      constraints: {},
      ...overrides,
    };
  }

  // (b) email field gets format-violation vectors
  it('produces format-violation vectors for email-typed field', () => {
    const vectors = fieldTypeVectors(makeEmailField());
    const ids = vectors.map((v) => v.id);
    expect(ids).toContain('email-no-at');
    expect(ids).toContain('email-no-domain');
    expect(ids).toContain('email-no-local');
    expect(ids).toContain('email-space');
  });

  it('all email format-violation vectors have expectError=true', () => {
    const vectors = fieldTypeVectors(makeEmailField());
    const errorVectors = vectors.filter((v) => v.id !== 'email-valid');
    expect(errorVectors.every((v) => v.expectError)).toBe(true);
  });

  it('includes a valid email happy-path probe with expectError=false', () => {
    const vectors = fieldTypeVectors(makeEmailField());
    const valid = vectors.find((v) => v.id === 'email-valid');
    expect(valid).toBeDefined();
    expect(valid?.expectError).toBe(false);
    expect(valid?.value).toMatch(/@/);
  });

  it('also fires for fields labelled "email" even if type is not email', () => {
    const vectors = fieldTypeVectors(makeEmailField({ type: 'textbox' }));
    expect(vectors.some((v) => v.id === 'email-no-at')).toBe(true);
  });
});

describe('fieldTypeVectors — number field with min/max (Bug 5)', () => {
  function makeNumberField(min?: number, max?: number): FormFieldSpec {
    return {
      locator: '#qty',
      label: 'Quantity',
      type: 'number',
      required: true,
      constraints: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) },
    };
  }

  // (c) number field with declared min/max gets boundary vectors
  it('produces below-min and above-max vectors when constraints present', () => {
    const vectors = fieldTypeVectors(makeNumberField(0, 100));
    const ids = vectors.map((v) => v.id);
    expect(ids).toContain('number-below-min');
    expect(ids).toContain('number-above-max');
    expect(ids).toContain('number-at-min');
    expect(ids).toContain('number-at-max');
  });

  it('below-min and above-max have expectError=true, boundary values have expectError=false', () => {
    const vectors = fieldTypeVectors(makeNumberField(10, 50));
    const belowMin = vectors.find((v) => v.id === 'number-below-min');
    const aboveMax = vectors.find((v) => v.id === 'number-above-max');
    const atMin = vectors.find((v) => v.id === 'number-at-min');
    const atMax = vectors.find((v) => v.id === 'number-at-max');
    expect(belowMin?.expectError).toBe(true);
    expect(aboveMax?.expectError).toBe(true);
    expect(atMin?.expectError).toBe(false);
    expect(atMax?.expectError).toBe(false);
    expect(belowMin?.value).toBe('9'); // 10 - 1
    expect(aboveMax?.value).toBe('51'); // 50 + 1
  });

  it('falls back to generic probes when min/max are absent', () => {
    const vectors = fieldTypeVectors(makeNumberField());
    const ids = vectors.map((v) => v.id);
    expect(ids).toContain('number-zero');
    expect(ids).toContain('number-large');
  });

  it('always includes non-numeric string probe with expectError=true', () => {
    const vectors = fieldTypeVectors(makeNumberField(0, 100));
    const nonnumeric = vectors.find((v) => v.id === 'number-nonnumeric');
    expect(nonnumeric).toBeDefined();
    expect(nonnumeric?.expectError).toBe(true);
  });
});

// (e) per-field error report distinguishes ok/suspicious/failed
describe('form_required_field_check — per-field error verdict (Bug 4)', () => {
  let browser: Browser;
  let page: Page;

  beforeEach(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterEach(async () => {
    await browser.close();
  });

  function makeRequiredFieldForm(overrides: Partial<FormSpec> = {}): FormSpec {
    return {
      id: 'frm-signup',
      formLocator: '#signup',
      name: 'Signup',
      fields: [
        { locator: '#name', label: 'Name', type: 'textbox', required: true, constraints: {} },
        { locator: '#email', label: 'Email', type: 'email', required: true, constraints: {} },
      ],
      submit: {
        locator: '#submit',
        label: 'Submit',
        type: 'button',
        disabled: false,
        intent: 'action',
      },
      extraActions: [],
      inModal: false,
      ...overrides,
    };
  }

  function makeRequiredCtx(page: Page, form: FormSpec): PlaybookContext {
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
      bareFields: [],
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
      siteMap: {
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
      },
      agentId: 'test',
      persona: 'test',
      runDir: '/tmp',
      logger: createLogger(),
      allowedHosts: [],
    };
  }

  it('returns failed-like suspicious when empty form is accepted (no errors shown)', async () => {
    // Form that submits without preventing default and navigates away.
    await page.route('**/test-signup', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <form id="signup" onsubmit="event.preventDefault(); history.pushState({}, '', '/done');">
            <input id="name" />
            <input id="email" type="email" />
            <button id="submit" type="submit">Submit</button>
          </form>
        `,
      });
    });
    await page.goto('https://test-app.local/test-signup', { waitUntil: 'domcontentloaded' });
    const ctx = makeRequiredCtx(page, makeRequiredFieldForm());
    const result = await formRequiredFieldCheck.run({ formId: 'frm-signup' }, ctx);
    // URL changed (pushState) → treated as "accepted empty submit" → suspicious.
    expect(result.status).toBe('suspicious');
    expect(result.summary).toMatch(/empty submit|accepted/i);
  });

  it('returns ok when every required field shows an aria-invalid error indicator', async () => {
    // Form that marks both fields aria-invalid on submit without navigating.
    await page.route('**/test-validate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <form id="signup" onsubmit="
            event.preventDefault();
            document.getElementById('name').setAttribute('aria-invalid','true');
            document.getElementById('email').setAttribute('aria-invalid','true');
          ">
            <input id="name" />
            <input id="email" type="email" />
            <button id="submit" type="submit">Submit</button>
          </form>
        `,
      });
    });
    await page.goto('https://test-app.local/test-validate', { waitUntil: 'domcontentloaded' });
    const ctx = makeRequiredCtx(page, makeRequiredFieldForm());
    const result = await formRequiredFieldCheck.run({ formId: 'frm-signup' }, ctx);
    expect(result.status).toBe('ok');
    const perField = result.evidence.perFieldErrors as Array<{ field: string; hasError: boolean }>;
    expect(perField).toBeDefined();
    expect(perField.every((f) => f.hasError)).toBe(true);
  });

  it('uses field.required as primary signal — skips fields with required=false', async () => {
    // Form where only the first field is HTML-required; second is optional.
    const form = makeRequiredFieldForm({
      fields: [
        { locator: '#name', label: 'Name', type: 'textbox', required: true, constraints: {} },
        // 'Email' is NOT required per HTML — should be excluded from candidate list.
        { locator: '#email', label: 'Email', type: 'email', required: false, constraints: {} },
      ],
    });
    await page.setContent(`
      <form id="signup">
        <input id="name" />
        <input id="email" type="email" />
        <button id="submit" type="submit">Submit</button>
      </form>
    `);
    const ctx = makeRequiredCtx(page, form);
    const result = await formRequiredFieldCheck.run({ formId: 'frm-signup' }, ctx);
    // Should only consider 'Name' as required — candidateRequiredLabels should be ['Name'].
    const labels = result.evidence.candidateRequiredLabels as string[];
    expect(labels).toContain('Name');
    expect(labels).not.toContain('Email');
  });
});
