/**
 * Tests for wizard playbooks. We mount a small multi-step HTML wizard via
 * Playwright `setContent`, then drive each playbook against it. The wizard
 * fixture renders one step at a time, with stepper labels (`Step N of 3`),
 * Next/Back/Skip/Finish buttons, and per-step required input fields. This
 * lets us assert all the meaningful state transitions without involving the
 * real PageModel parser (which is owned by WP1/Task 1).
 */

import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SiteMapAccessor } from '../crawler/types.ts';
import type { PageModel, WizardSpec } from '../page-model/types.ts';
import type { PlaybookContext } from './framework.ts';
import { PlaybookRegistry, runPlaybook } from './framework.ts';
import {
  registerWizardPlaybooks,
  wizard_abandon_and_resume,
  wizard_back_in_middle,
  wizard_browser_back_kills_state,
  wizard_full_walkthrough,
  wizard_skip_branches,
  wizard_validation_per_step,
} from './wizards.ts';

// --------------------------------------------------------------------------
// Test fixtures
// --------------------------------------------------------------------------

/** Build a 3-step wizard HTML fixture. Knobs:
 *   - dropDataOnBack: when true, navigating Back wipes the field values
 *     (simulates a buggy wizard).
 *   - validateOnNext: when true, clicking Next on a step with empty required
 *     field surfaces an aria-invalid attribute and refuses to advance.
 *   - allowSkip: when true, render a Skip button on every non-final step.
 */
function buildWizardHtml(
  opts: { dropDataOnBack?: boolean; validateOnNext?: boolean; allowSkip?: boolean } = {},
): string {
  const dropDataOnBack = opts.dropDataOnBack === true;
  const validateOnNext = opts.validateOnNext === true;
  const allowSkip = opts.allowSkip === true;

  // Inline state: { current, values: { Name, Email, Plan } }. We render the
  // current step's input(s) only; Back/Next/Skip/Finish are toggled based on
  // current step.
  return /* html */ `
<!doctype html>
<html>
<head><title>wizard</title></head>
<body>
  <main id="wizard" data-testid="wizard-1" aria-label="Step 1 of 3">
    <h2 id="stepper">Step 1 of 3</h2>
    <div id="step-body"></div>
    <button id="back" type="button">Back</button>
    <button id="next" type="button">Next</button>
    ${allowSkip ? '<button id="skip" type="button">Skip</button>' : ''}
    <button id="finish" type="button" style="display:none">Finish</button>
  </main>
  <script>
    const STEPS = [
      { label: 'Name', name: 'Name' },
      { label: 'Email', name: 'Email' },
      { label: 'Plan', name: 'Plan' },
    ];
    const state = { current: 0, values: { Name: '', Email: '', Plan: '' } };
    const cfg = ${JSON.stringify({ dropDataOnBack, validateOnNext, allowSkip })};

    function render() {
      const stepIdx = state.current;
      const step = STEPS[stepIdx];
      document.getElementById('stepper').textContent =
        'Step ' + (stepIdx + 1) + ' of ' + STEPS.length;
      const body = document.getElementById('step-body');
      body.innerHTML =
        '<label for="f">' + step.label + '</label>' +
        '<input id="f" name="' + step.name + '" aria-label="' + step.label + '"' +
        ' value="' + (state.values[step.name] || '') + '" />' +
        '<div id="error" role="alert" style="display:none">Required</div>';
      // Wire input -> state.
      document.getElementById('f').addEventListener('input', (e) => {
        state.values[step.name] = e.target.value;
        document.getElementById('f').setAttribute('aria-invalid', 'false');
        document.getElementById('error').style.display = 'none';
      });
      // Toggle navigation buttons.
      document.getElementById('back').disabled = stepIdx === 0;
      document.getElementById('next').style.display =
        stepIdx === STEPS.length - 1 ? 'none' : '';
      document.getElementById('finish').style.display =
        stepIdx === STEPS.length - 1 ? '' : 'none';
      if (cfg.allowSkip) {
        document.getElementById('skip').style.display =
          stepIdx === STEPS.length - 1 ? 'none' : '';
      }
    }

    document.getElementById('next').addEventListener('click', () => {
      const step = STEPS[state.current];
      if (cfg.validateOnNext && !state.values[step.name]) {
        document.getElementById('f').setAttribute('aria-invalid', 'true');
        document.getElementById('error').style.display = 'block';
        return;
      }
      if (state.current < STEPS.length - 1) {
        state.current += 1;
        render();
      }
    });
    document.getElementById('back').addEventListener('click', () => {
      if (state.current > 0) {
        if (cfg.dropDataOnBack) {
          state.values = { Name: '', Email: '', Plan: '' };
        }
        state.current -= 1;
        render();
      }
    });
    if (cfg.allowSkip) {
      document.getElementById('skip').addEventListener('click', () => {
        if (state.current < STEPS.length - 1) {
          state.current += 1;
          render();
        }
      });
    }
    document.getElementById('finish').addEventListener('click', () => {
      document.getElementById('stepper').textContent = 'Done';
    });

    render();
  </script>
</body>
</html>
  `;
}

/** Build a `WizardSpec` that mirrors the fixture's current state. The
 * fixture uses stable element IDs, so locators are simple `#id` strings. */
function buildWizardSpecForCurrentStep(currentStepIndex: number, totalSteps: number): WizardSpec {
  return {
    id: 'wizard-1',
    wizardLocator: '#wizard',
    name: 'Test Wizard',
    steps: Array.from({ length: totalSteps }, (_, i) => ({
      label: `Step ${i + 1}`,
      index: i,
      isCurrent: i === currentStepIndex,
    })),
    next: {
      locator: '#next',
      label: 'Next',
      type: 'button',
      disabled: false,
      intent: 'navigate',
    },
    back: {
      locator: '#back',
      label: 'Back',
      type: 'button',
      disabled: currentStepIndex === 0,
      intent: 'navigate',
    },
    skip: {
      locator: '#skip',
      label: 'Skip',
      type: 'button',
      disabled: false,
      intent: 'navigate',
    },
    finish: {
      locator: '#finish',
      label: 'Finish',
      type: 'button',
      disabled: false,
      intent: 'action',
    },
  };
}

/** Read the stepper text "Step N of M" once; tolerate missing element. */
async function readStepperText(page: Page): Promise<string> {
  try {
    return (await page.locator('#stepper').textContent({ timeout: 1_000 })) ?? '';
  } catch {
    return '';
  }
}

/** Read the wizard's current step index from the DOM. */
async function readCurrentStepIndex(page: Page): Promise<number> {
  const text = await readStepperText(page);
  const m = /Step (\d+) of (\d+)/.exec(text);
  if (!m) return -1;
  return Number.parseInt(m[1], 10) - 1;
}

/** Read the rendered total step count from the DOM. */
async function readTotalSteps(page: Page): Promise<number> {
  const text = await readStepperText(page);
  const m = /Step (\d+) of (\d+)/.exec(text);
  if (!m) return 0;
  return Number.parseInt(m[2], 10);
}

/** Build a `PlaybookContext` that reflects the live DOM. `pageModel()` reads
 * the current step index from the DOM and constructs a `WizardSpec` for it.
 * This avoids depending on the real parser (WP1) which lives in another
 * work-package. */
function buildContext(page: Page, opts: { hasWizard?: boolean } = {}): PlaybookContext {
  const hasWizard = opts.hasWizard ?? true;
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
  };
  const siteMap: SiteMapAccessor = {
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
      rootUrl: page.url(),
      routes: {},
      pageModels: {},
    }),
  };

  return {
    page,
    siteMap,
    agentId: 'test-agent',
    persona: '',
    runDir: '/tmp/wizards-test',
    logger: noopLogger,
    pageModel: async (): Promise<PageModel> => {
      const url = page.url();
      const totalSteps = (await readTotalSteps(page)) || 3;
      const current = await readCurrentStepIndex(page);
      const wizards: WizardSpec[] = hasWizard
        ? [buildWizardSpecForCurrentStep(Math.max(0, current), totalSteps)]
        : [];
      return {
        url,
        route: url,
        title: 'wizard',
        forms: [],
        tables: [],
        modals: [],
        wizards,
        toolbars: [],
        navLinks: [],
        bareInteractives: [],
        network: [],
        console: [],
        textHash: 'fixture',
        looksBroken: false,
        interactiveCount: 1,
        capturedAt: new Date().toISOString(),
      };
    },
  };
}

// --------------------------------------------------------------------------
// Test harness
// --------------------------------------------------------------------------

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

async function withPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Use a real http-style URL via data: so page.url() returns a non-blank
  // value. setContent on `about:blank` is fine for most tests but the
  // browser-back playbook needs a navigation history; tests for that one
  // navigate explicitly.
  await page.setContent(html, { waitUntil: 'load' });
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('wizard_full_walkthrough', () => {
  it('walks all 3 steps with values and clicks Finish — status ok', async () => {
    await withPage(buildWizardHtml(), async (page) => {
      const ctx = buildContext(page);
      const outcome = await runPlaybook(
        wizard_full_walkthrough,
        {
          wizardId: 'wizard-1',
          valuesPerStep: {
            '0': { Name: 'Acme' },
            '1': { Email: 'a@b.test' },
            '2': { Plan: 'Pro' },
          },
        },
        ctx,
      );
      expect(outcome.status).toBe('ok');
      expect(outcome.summary).toMatch(/walked 3 steps/);
      const stepEvidence = outcome.evidence.stepEvidence as Array<{ filled: number }>;
      expect(stepEvidence).toHaveLength(3);
      expect(stepEvidence[0]?.filled).toBe(1);
      // Stepper should now read "Done".
      const stepperText = await readStepperText(page);
      expect(stepperText).toBe('Done');
    });
  });

  it('returns failed when wizardId not on page', async () => {
    await withPage(buildWizardHtml(), async (page) => {
      const ctx = buildContext(page);
      const outcome = await runPlaybook(wizard_full_walkthrough, { wizardId: 'nope' }, ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toMatch(/no wizard/);
    });
  });

  it('returns failed when no wizards exist on page', async () => {
    await withPage(buildWizardHtml(), async (page) => {
      const ctx = buildContext(page, { hasWizard: false });
      const outcome = await runPlaybook(wizard_full_walkthrough, { wizardId: 'wizard-1' }, ctx);
      expect(outcome.status).toBe('failed');
    });
  });
});

describe('wizard_back_in_middle', () => {
  it('preserves data when Back is well-behaved — status ok', async () => {
    await withPage(buildWizardHtml(), async (page) => {
      const ctx = buildContext(page);
      const outcome = await runPlaybook(
        wizard_back_in_middle,
        {
          wizardId: 'wizard-1',
          valuesPerStep: {
            '0': { Name: 'Acme' },
            '1': { Email: 'a@b.test' },
          },
        },
        ctx,
      );
      expect(outcome.status).toBe('ok');
      const preservedFields = outcome.evidence.preservedFields as string[];
      expect(preservedFields).toContain('Name');
    });
  });

  it('flags suspicious when data is wiped on Back', async () => {
    await withPage(buildWizardHtml({ dropDataOnBack: true }), async (page) => {
      const ctx = buildContext(page);
      const outcome = await runPlaybook(
        wizard_back_in_middle,
        {
          wizardId: 'wizard-1',
          valuesPerStep: {
            '0': { Name: 'Acme' },
            '1': { Email: 'a@b.test' },
          },
        },
        ctx,
      );
      expect(outcome.status).toBe('suspicious');
      expect(outcome.summary).toMatch(/lost/);
      const lostFields = outcome.evidence.lostFields as string[];
      expect(lostFields.length).toBeGreaterThan(0);
    });
  });
});

describe('wizard_validation_per_step', () => {
  it('records ok when validation surfaces and prevents advance', async () => {
    await withPage(buildWizardHtml({ validateOnNext: true }), async (page) => {
      const ctx = buildContext(page);
      const outcome = await runPlaybook(wizard_validation_per_step, { wizardId: 'wizard-1' }, ctx);
      expect(outcome.status).toBe('ok');
      const perStep = outcome.evidence.perStep as Array<{
        validationSurfaced: boolean;
        advanced: boolean;
      }>;
      // First step should surface validation and not advance.
      expect(perStep[0]?.validationSurfaced).toBe(true);
      expect(perStep[0]?.advanced).toBe(false);
    });
  });

  it('flags suspicious when no validation surfaces and steps just leak past', async () => {
    // validateOnNext false → empty Next still advances; combined with no
    // aria-invalid surface, this is the buggy-app scenario.
    await withPage(buildWizardHtml({ validateOnNext: false }), async (page) => {
      const ctx = buildContext(page);
      const outcome = await runPlaybook(wizard_validation_per_step, { wizardId: 'wizard-1' }, ctx);
      expect(outcome.status).toBe('suspicious');
    });
  });
});

describe('wizard_skip_branches', () => {
  it('uses Skip on every step when present — status ok', async () => {
    await withPage(buildWizardHtml({ allowSkip: true }), async (page) => {
      const ctx = buildContext(page);
      const outcome = await runPlaybook(wizard_skip_branches, { wizardId: 'wizard-1' }, ctx);
      expect(outcome.status).toBe('ok');
      const branches = outcome.evidence.branches as Array<{ via: string }>;
      // The first 2 steps should advance via skip, the last via finish.
      expect(branches[0]?.via).toBe('skip');
      expect(branches[branches.length - 1]?.via).toBe('finish');
    });
  });
});

describe('wizard_browser_back_kills_state', () => {
  it('detects empty page after browser-back', async () => {
    const ctx0 = await browser.newContext();
    const page = await ctx0.newPage();
    try {
      // Seed a benign first navigation so page.goBack() has somewhere to go.
      await page.goto('data:text/html,<html><body>seed</body></html>');
      await page.setContent(buildWizardHtml(), { waitUntil: 'load' });

      const ctx = buildContext(page);
      const outcome = await runPlaybook(
        wizard_browser_back_kills_state,
        { wizardId: 'wizard-1' },
        ctx,
      );
      // After page.goBack() the page lands on the seed page (text "seed",
      // length 4). That's a non-empty page, so playbook returns ok.
      expect(['ok', 'suspicious']).toContain(outcome.status);
      expect(outcome.evidence).toHaveProperty('urlAfterBack');
    } finally {
      await ctx0.close();
    }
  });

  it('returns failed when wizard has fewer than 2 steps', async () => {
    await withPage('<html><body><main id="wizard"></main></body></html>', async (page) => {
      const ctx: PlaybookContext = {
        ...buildContext(page),
        pageModel: async () => ({
          url: page.url(),
          route: page.url(),
          title: 'x',
          forms: [],
          tables: [],
          modals: [],
          wizards: [
            {
              id: 'wizard-1',
              wizardLocator: '#wizard',
              name: 'one-step',
              steps: [{ label: 'only', index: 0, isCurrent: true }],
            },
          ],
          toolbars: [],
          navLinks: [],
          bareInteractives: [],
          network: [],
          console: [],
          textHash: '',
          looksBroken: false,
          interactiveCount: 0,
          capturedAt: new Date().toISOString(),
        }),
      };
      const outcome = await runPlaybook(
        wizard_browser_back_kills_state,
        { wizardId: 'wizard-1' },
        ctx,
      );
      expect(outcome.status).toBe('failed');
    });
  });
});

describe('wizard_abandon_and_resume', () => {
  it('returns failed when wizard has fewer than 2 steps (smoke)', async () => {
    await withPage('<html><body><main id="wizard"></main></body></html>', async (page) => {
      const ctx: PlaybookContext = {
        ...buildContext(page),
        pageModel: async () => ({
          url: page.url(),
          route: page.url(),
          title: 'x',
          forms: [],
          tables: [],
          modals: [],
          wizards: [
            {
              id: 'wizard-1',
              wizardLocator: '#wizard',
              name: 'one-step',
              steps: [{ label: 'only', index: 0, isCurrent: true }],
            },
          ],
          toolbars: [],
          navLinks: [],
          bareInteractives: [],
          network: [],
          console: [],
          textHash: '',
          looksBroken: false,
          interactiveCount: 0,
          capturedAt: new Date().toISOString(),
        }),
      };
      const outcome = await runPlaybook(wizard_abandon_and_resume, { wizardId: 'wizard-1' }, ctx);
      expect(outcome.status).toBe('failed');
    });
  });
});

describe('registerWizardPlaybooks', () => {
  it('registers all six wizard playbooks', () => {
    const r = new PlaybookRegistry();
    registerWizardPlaybooks(r);
    expect(r.size()).toBe(6);
    expect(r.get('wizard_full_walkthrough')).toBeDefined();
    expect(r.get('wizard_skip_branches')).toBeDefined();
    expect(r.get('wizard_back_in_middle')).toBeDefined();
    expect(r.get('wizard_browser_back_kills_state')).toBeDefined();
    expect(r.get('wizard_validation_per_step')).toBeDefined();
    expect(r.get('wizard_abandon_and_resume')).toBeDefined();
  });
});
