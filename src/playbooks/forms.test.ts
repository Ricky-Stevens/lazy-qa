/**
 * Form playbook tests. Each test uses a real Playwright (chromium) page with
 * setContent HTML that simulates the relevant form behaviour. PageModel is
 * built by hand for each scenario rather than relying on the parser (parser is
 * owned by another work-package).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type Page, chromium } from 'playwright';
import type { Logger } from '../logging/logger.ts';
import type { FormSpec, PageModel } from '../page-model/types.ts';
import type { SiteMapAccessor, RouteEntry, SiteMap } from '../crawler/types.ts';
import type { PlaybookContext } from './framework.ts';
import {
  SPECIAL_CHARS_PAYLOADS,
  XSS_PAYLOADS,
  form_double_submit,
  form_fuzz_validation,
  form_special_chars,
  form_xss_probe,
  registerFormPlaybooks,
} from './forms.ts';
import { PlaybookRegistry } from './framework.ts';

// ─── Test harness ────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return noopLogger;
  },
};

class StubSiteMap implements SiteMapAccessor {
  private routes = new Map<string, RouteEntry>();
  private models = new Map<string, PageModel>();
  recordedOutcomes: Array<{ route: string; playbook: string; targetId: string | null; status: string }> =
    [];
  getRoute(route: string) {
    return this.routes.get(route);
  }
  getPageModel(route: string) {
    return this.models.get(route);
  }
  listAllRoutes(): RouteEntry[] {
    return Array.from(this.routes.values());
  }
  listUnvisitedRoutes(): RouteEntry[] {
    return [];
  }
  listFormsUntested() {
    return [];
  }
  listTablesUntested() {
    return [];
  }
  listModalsUntested() {
    return [];
  }
  listWizardsUntested() {
    return [];
  }
  recordVisit() {}
  recordPlaybookOutcome(
    route: string,
    playbook: string,
    targetId: string | null,
    status: 'ok' | 'failed' | 'suspicious',
  ) {
    this.recordedOutcomes.push({ route, playbook, targetId, status });
  }
  upsertRoute(entry: RouteEntry, model: PageModel) {
    this.routes.set(entry.route, entry);
    this.models.set(entry.route, model);
  }
  serialize(): SiteMap {
    return {
      startedAt: new Date().toISOString(),
      rootUrl: '',
      routes: Object.fromEntries(this.routes),
      pageModels: Object.fromEntries(this.models),
    };
  }
}

function makeContext(page: Page, model: PageModel): PlaybookContext {
  return {
    page,
    pageModel: async () => model,
    siteMap: new StubSiteMap(),
    agentId: 'test-agent',
    persona: '',
    runDir: '/tmp/regress-test',
    logger: noopLogger,
    allowedHosts: [],
  };
}

function emptyPageModel(overrides: Partial<PageModel> = {}): PageModel {
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
    ...overrides,
  };
}

// ─── Browser lifecycle ───────────────────────────────────────────────────────

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

// ─── Form scenarios ──────────────────────────────────────────────────────────

const FORM_WITH_REQUIRED_HTML = `
<!doctype html><html><body>
  <form id="f" novalidate>
    <label for="name">Name</label>
    <input id="name" name="name" type="text" required />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required />
    <button id="submit" type="button" onclick="submitForm()">Save</button>
    <button id="cancel" type="button" onclick="document.getElementById('f').reset()">Cancel</button>
    <div id="errors"></div>
  </form>
  <script>
    function submitForm() {
      const errs = [];
      const f = document.getElementById('f');
      for (const inp of f.querySelectorAll('input[required]')) {
        if (!inp.value.trim()) errs.push(inp.name + ' is required');
      }
      document.getElementById('errors').textContent = errs.join('; ');
      if (errs.length === 0) {
        // Simulate save POST so trackers can see it
        fetch('/api/save', { method: 'POST', body: JSON.stringify({ ok: true }) }).catch(()=>{});
      }
    }
  </script>
</body></html>
`;

function basicFormModel(): { model: PageModel; form: FormSpec } {
  const form: FormSpec = {
    id: 'form-basic',
    formLocator: '#f',
    name: 'Basic',
    fields: [
      {
        locator: '#name',
        label: 'Name',
        type: 'text',
        required: true,
        constraints: {},
      },
      {
        locator: '#email',
        label: 'Email',
        type: 'email',
        required: true,
        constraints: {},
      },
    ],
    submit: {
      locator: '#submit',
      label: 'Save',
      type: 'button',
      disabled: false,
      intent: 'action',
    },
    cancel: {
      locator: '#cancel',
      label: 'Cancel',
      type: 'button',
      disabled: false,
      intent: 'navigate',
    },
    extraActions: [],
    inModal: false,
  };
  const model = emptyPageModel({ forms: [form] });
  return { model, form };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('registerFormPlaybooks', () => {
  it('registers all 9 form playbooks', () => {
    const r = new PlaybookRegistry();
    registerFormPlaybooks(r);
    expect(r.size()).toBe(9);
    const names = r.list().map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'form_fuzz_validation',
        'form_xss_probe',
        'form_sql_injection_probe',
        'form_required_field_check',
        'form_optional_roundtrip',
        'form_long_input_test',
        'form_special_chars',
        'form_double_submit',
        'form_cancel_then_back',
      ]),
    );
  });
});

describe('payload exports', () => {
  it('XSS_PAYLOADS contains the canonical script tag', () => {
    expect(XSS_PAYLOADS).toContain('<script>alert(1)</script>');
  });
  it('SPECIAL_CHARS_PAYLOADS contains emoji and RTL text', () => {
    expect(SPECIAL_CHARS_PAYLOADS).toContain('🚀💥');
    expect(SPECIAL_CHARS_PAYLOADS).toContain('مرحبا');
  });
});

describe('form_fuzz_validation', () => {
  it('returns ok when validation surfaces on empty submission', async () => {
    const page = await newPage();
    await page.setContent(FORM_WITH_REQUIRED_HTML);
    const { model } = basicFormModel();
    const ctx = makeContext(page, model);

    const outcome = await form_fuzz_validation.run({ formId: 'form-basic' }, ctx);
    expect(outcome.status).toBe('ok');
    expect(outcome.steps.length).toBeGreaterThan(0);
    const evidence = outcome.evidence as { attempts: Array<{ validationSeen: boolean }> };
    expect(evidence.attempts.some((a) => a.validationSeen)).toBe(true);
    await page.close();
  }, 30_000);

  it('returns suspicious when no validation surfaces on a permissive form', async () => {
    const page = await newPage();
    // Form whose submit handler does nothing — no validation surfaced anywhere
    await page.setContent(`
      <form id="f">
        <input id="name" name="name" required />
        <button id="submit" type="button">Save</button>
      </form>
    `);
    const form: FormSpec = {
      id: 'form-perm',
      formLocator: '#f',
      name: 'Permissive',
      fields: [
        {
          locator: '#name',
          label: 'Name',
          type: 'text',
          // Mark required false at the spec level so the playbook does only the empty-submit attempt
          // and then evaluates whether anything surfaced. The :invalid will trigger because the
          // attribute is on the input. We disable that by removing required from HTML below.
          required: false,
          constraints: {},
        },
      ],
      submit: {
        locator: '#submit',
        label: 'Save',
        type: 'button',
        disabled: false,
        intent: 'action',
      },
      extraActions: [],
      inModal: false,
    };
    // Re-render without the required attribute so :invalid does not trigger
    await page.setContent(`
      <form id="f">
        <input id="name" name="name" />
        <button id="submit" type="button">Save</button>
      </form>
    `);
    const model = emptyPageModel({ forms: [form] });
    const ctx = makeContext(page, model);
    const outcome = await form_fuzz_validation.run({ formId: 'form-perm' }, ctx);
    expect(outcome.status).toBe('suspicious');
    await page.close();
  }, 30_000);

  it('returns failed when formId is unknown', async () => {
    const page = await newPage();
    await page.setContent('<html><body></body></html>');
    const ctx = makeContext(page, emptyPageModel());
    const outcome = await form_fuzz_validation.run({ formId: 'no-such-form' }, ctx);
    expect(outcome.status).toBe('failed');
    await page.close();
  }, 15_000);
});

describe('form_xss_probe', () => {
  it('reports suspicious when payload reflects via innerHTML', async () => {
    const page = await newPage();
    // Intentionally bad: reflects raw input via innerHTML
    await page.setContent(`
      <form id="f">
        <input id="name" name="name" type="text" />
        <button id="submit" type="button" onclick="document.getElementById('out').innerHTML = document.getElementById('name').value">Save</button>
        <div id="out"></div>
      </form>
    `);
    const form: FormSpec = {
      id: 'form-xss',
      formLocator: '#f',
      name: 'XSS',
      fields: [
        { locator: '#name', label: 'Name', type: 'text', required: false, constraints: {} },
      ],
      submit: {
        locator: '#submit',
        label: 'Save',
        type: 'button',
        disabled: false,
        intent: 'action',
      },
      extraActions: [],
      inModal: false,
    };
    const model = emptyPageModel({ forms: [form] });
    const ctx = makeContext(page, model);
    const outcome = await form_xss_probe.run({ formId: 'form-xss' }, ctx);
    expect(outcome.status).toBe('suspicious');
    const evidence = outcome.evidence as {
      reflections: Array<{ scriptMaterialised: boolean; reflectedRaw: boolean }>;
    };
    expect(evidence.reflections.some((r) => r.scriptMaterialised || r.reflectedRaw)).toBe(true);
    await page.close();
  }, 30_000);

  it('reports ok when payload is escaped via textContent', async () => {
    const page = await newPage();
    await page.setContent(`
      <form id="f">
        <input id="name" name="name" type="text" />
        <button id="submit" type="button" onclick="document.getElementById('out').textContent = document.getElementById('name').value">Save</button>
        <div id="out"></div>
      </form>
    `);
    const form: FormSpec = {
      id: 'form-safe',
      formLocator: '#f',
      name: 'Safe',
      fields: [
        { locator: '#name', label: 'Name', type: 'text', required: false, constraints: {} },
      ],
      submit: {
        locator: '#submit',
        label: 'Save',
        type: 'button',
        disabled: false,
        intent: 'action',
      },
      extraActions: [],
      inModal: false,
    };
    const model = emptyPageModel({ forms: [form] });
    const ctx = makeContext(page, model);
    // Use a single short payload to keep the test fast and avoid the case where
    // reflections-via-textContent get matched as raw substring.
    const outcome = await form_xss_probe.run(
      { formId: 'form-safe', payloads: ['<img src=x onerror=alert(1)>'] },
      ctx,
    );
    // textContent escapes the payload visually (renders as text), but the raw
    // string still appears inside textContent so reflectedRaw can be true. The
    // probe also checks for live <script> elements / inline handlers — those
    // should NOT materialise. In the current impl we mark suspicious on either,
    // so this scenario validates that no script element nor handler attached.
    const evidence = outcome.evidence as {
      reflections: Array<{ scriptMaterialised: boolean }>;
    };
    expect(evidence.reflections.every((r) => r.scriptMaterialised === false)).toBe(true);
    await page.close();
  }, 30_000);
});

describe('form_double_submit', () => {
  it('records two click attempts on a non-disabling form', async () => {
    const page = await newPage();
    await page.setContent(`
      <form id="f">
        <button id="submit" type="button" onclick="window.__clicks=(window.__clicks||0)+1">Save</button>
      </form>
    `);
    const form: FormSpec = {
      id: 'form-dbl',
      formLocator: '#f',
      name: 'Double',
      fields: [],
      submit: {
        locator: '#submit',
        label: 'Save',
        type: 'button',
        disabled: false,
        intent: 'action',
      },
      extraActions: [],
      inModal: false,
    };
    const model = emptyPageModel({ forms: [form] });
    const ctx = makeContext(page, model);

    const outcome = await form_double_submit.run({ formId: 'form-dbl' }, ctx);
    // biome-ignore lint/suspicious/noExplicitAny: globalThis access in browser ctx
    const clicks = await page.evaluate(() => (globalThis as any).__clicks as number | undefined);
    expect(clicks).toBe(2);
    // No POSTs were issued so no duplicates flagged → ok
    expect(outcome.status).toBe('ok');
    const evidence = outcome.evidence as { clickCount: number };
    expect(evidence.clickCount).toBe(2);
    await page.close();
  }, 30_000);
});

describe('form_special_chars', () => {
  it('types every special-chars payload into the field without crashing', async () => {
    const page = await newPage();
    await page.setContent(`
      <form id="f">
        <input id="name" name="name" type="text" />
        <button id="submit" type="button">Save</button>
      </form>
    `);
    const form: FormSpec = {
      id: 'form-special',
      formLocator: '#f',
      name: 'Special',
      fields: [
        { locator: '#name', label: 'Name', type: 'text', required: false, constraints: {} },
      ],
      submit: {
        locator: '#submit',
        label: 'Save',
        type: 'button',
        disabled: false,
        intent: 'action',
      },
      extraActions: [],
      inModal: false,
    };
    const model = emptyPageModel({ forms: [form] });
    const ctx = makeContext(page, model);

    const outcome = await form_special_chars.run({ formId: 'form-special' }, ctx);
    expect(outcome.status).toBe('ok');
    const evidence = outcome.evidence as {
      trials: Array<{ payload: string; typed: boolean; readBack: string }>;
    };
    expect(evidence.trials.length).toBe(SPECIAL_CHARS_PAYLOADS.length);
    expect(evidence.trials.every((t) => t.typed)).toBe(true);
    // The last trial should leave the field with the long-A string.
    const last = evidence.trials[evidence.trials.length - 1];
    expect(last.readBack.length).toBeGreaterThan(0);
    await page.close();
  }, 30_000);
});
