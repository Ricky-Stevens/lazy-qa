/**
 * Tests for the `walk_wizard` playbook (WP2.E).
 *
 * Uses real Chromium via Playwright + `setContent`. The `PlaybookContext` is
 * stubbed following the same pattern as forms.test.ts and tables.test.ts.
 *
 * WizardSpec field notes (src/page-model/types.ts):
 *   - wizardLocator: string            — stable container locator
 *   - steps: { label, index, isCurrent }[]  — navigation indicators, no field descriptors
 *   - next?: ActionRef                 — { locator, disabled, label, type, intent }
 *   - finish?: ActionRef               — { locator, disabled, label, type, intent }
 *
 * Field filling uses label-based heuristics (getByLabel / [name=...] / etc.)
 * because WizardSpec.steps carry no field metadata.
 */

import { type Browser, chromium, type Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteMapAccessor } from '../crawler/types.ts';
import { createLogger } from '../logging/logger.ts';
import type { PageModel, WizardSpec } from '../page-model/types.ts';
import type { PlaybookContext } from './framework.ts';
import { walkWizard } from './wizards.ts';

// ---------------------------------------------------------------------------
// Stub SiteMapAccessor — pattern-matched from forms.test.ts / tables.test.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal WizardSpec. Uses `wizardLocator` (not `selector`) matching
 * the actual WizardSpec interface. next/finish are ActionRef objects.
 */
function makeWizard(overrides: Partial<WizardSpec> = {}): WizardSpec {
  return {
    id: 'wiz-signup',
    wizardLocator: '#signup-wizard',
    name: 'Sign-up Wizard',
    steps: [
      { label: 'Step 1', index: 0, isCurrent: true },
      { label: 'Step 2', index: 1, isCurrent: false },
    ],
    next: {
      locator: '#next-btn',
      label: 'Next',
      type: 'button',
      disabled: false,
      intent: 'action',
    },
    finish: {
      locator: '#finish-btn',
      label: 'Finish',
      type: 'button',
      disabled: false,
      intent: 'action',
    },
    ...overrides,
  };
}

function makeContext(page: Page, wizard: WizardSpec): PlaybookContext {
  const model: PageModel = {
    url: page.url(),
    route: page.url(),
    title: 'Test',
    forms: [],
    tables: [],
    modals: [],
    wizards: [wizard],
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('walk_wizard', () => {
  let browser: Browser;
  let page: Page;

  beforeEach(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterEach(async () => {
    await browser.close();
  });

  // -------------------------------------------------------------------------
  // Test 1: unknown wizardId → failed
  // -------------------------------------------------------------------------
  it('returns failed when wizardId is not in the page model', async () => {
    await page.setContent('<div>no wizard here</div>');
    const wizard = makeWizard();
    const ctx = makeContext(page, wizard);

    const result = await walkWizard.run({ wizardId: 'wiz-does-not-exist', stepInputs: [{}] }, ctx);

    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/not found/);
    expect(result.summary).toContain('wiz-does-not-exist');
  });

  // -------------------------------------------------------------------------
  // Test 2: 2-step walk + Finish → ok
  // -------------------------------------------------------------------------
  it('walks 2 steps, fills inputs, clicks Finish, returns ok', async () => {
    // Step 1 shows a name field + Next button.
    // Clicking Next reveals step 2 (email field) + Finish button, hides Next.
    // Clicking Finish marks #done visible.
    await page.setContent(`
      <div id="signup-wizard">
        <section id="step1">
          <label for="name-input">Full Name</label>
          <input id="name-input" name="Full Name" />
        </section>
        <section id="step2" style="display:none">
          <label for="email-input">Email</label>
          <input id="email-input" name="Email" />
        </section>
        <button id="next-btn">Next</button>
        <button id="finish-btn" style="display:none">Finish</button>
        <div id="done" style="display:none">Done!</div>
      </div>
      <script>
        document.getElementById('next-btn').addEventListener('click', () => {
          document.getElementById('step1').style.display = 'none';
          document.getElementById('step2').style.display = '';
          document.getElementById('next-btn').style.display = 'none';
          document.getElementById('finish-btn').style.display = '';
        });
        document.getElementById('finish-btn').addEventListener('click', () => {
          document.getElementById('done').style.display = '';
        });
      </script>
    `);

    const wizard = makeWizard();
    const ctx = makeContext(page, wizard);

    const result = await walkWizard.run(
      {
        wizardId: 'wiz-signup',
        stepInputs: [{ 'Full Name': 'Alice Smith' }, { Email: 'alice@example.com' }],
        expectFinish: true,
      },
      ctx,
    );

    expect(result.status).toBe('ok');
    expect(result.summary).toMatch(/2 step\(s\)/);
    expect(result.summary).toMatch(/Finish/i);
    expect(result.evidence.finishClicked).toBe(true);

    // Verify DOM state: fields were filled and Finish was actually clicked.
    expect(await page.locator('#name-input').inputValue()).toBe('Alice Smith');
    expect(await page.locator('#done').isVisible()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: no Finish button on last step → suspicious
  // -------------------------------------------------------------------------
  it('flags suspicious when finish button is absent and expectFinish is true', async () => {
    // Allow extra time: the Playwright click on a non-existent locator waits
    // up to STEP_TIMEOUT_MS (5s) before giving up.
    // Single-step wizard: field is present but there is no Finish button anywhere.
    // The spec's finish locator (#finish-btn) does not exist in DOM, and there
    // are no heuristic "finish/complete/submit/done" buttons either.
    await page.setContent(`
      <div id="signup-wizard">
        <section id="step1">
          <label for="name-input">Full Name</label>
          <input id="name-input" />
        </section>
        <!-- intentionally no finish button -->
      </div>
    `);

    const wizard = makeWizard({
      steps: [{ label: 'Step 1', index: 0, isCurrent: true }],
      next: undefined,
      finish: {
        locator: '#finish-btn',
        label: 'Finish',
        type: 'button',
        disabled: false,
        intent: 'action',
      },
    });
    const ctx = makeContext(page, wizard);

    const result = await walkWizard.run(
      {
        wizardId: 'wiz-signup',
        stepInputs: [{ 'Full Name': 'Bob Jones' }],
        expectFinish: true,
      },
      ctx,
    );

    expect(result.status).toBe('suspicious');
    expect(result.evidence.finishClicked).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4: no Next button at non-final step → suspicious, stuckAt = 0
  // -------------------------------------------------------------------------
  it('flags suspicious and records stuckAt when stuck mid-wizard (Next click fails)', async () => {
    // Two-step wizard DOM, but #next-btn-missing is not in the DOM so the
    // click times out and the playbook records stuckAt=0.
    await page.setContent(`
      <div id="signup-wizard">
        <section id="step1">
          <label for="name-input">Full Name</label>
          <input id="name-input" />
        </section>
        <!-- #next-btn is absent; the spec will try to click #next-btn-missing -->
      </div>
    `);

    const wizard = makeWizard({
      next: {
        locator: '#next-btn-missing',
        label: 'Next',
        type: 'button',
        disabled: false,
        intent: 'action',
      },
    });
    const ctx = makeContext(page, wizard);

    const result = await walkWizard.run(
      {
        wizardId: 'wiz-signup',
        stepInputs: [{ 'Full Name': 'Carol' }, { Email: 'carol@example.com' }],
      },
      ctx,
    );

    expect(result.status).toBe('suspicious');
    // stuckAt is the zero-based index of the step that couldn't advance.
    expect(result.evidence.stuckAt).toBe(0);
    expect(result.summary).toMatch(/stuck at step 1/i);
  });
});
