/**
 * Wizard playbooks (spec §6.6 / WP9). Each playbook walks a multi-step wizard
 * discovered on the current page via `PageModel.wizards`. Wizards are
 * identified by `wizardId`; the playbook resolves the matching `WizardSpec`,
 * then drives the wizard via the spec's `next`/`back`/`skip`/`finish`
 * `ActionRef` locators.
 *
 * Conventions (shared with other playbook modules):
 *   - Every Playwright action is wrapped in try/catch and emits a `step`
 *     entry. Failures inside a step never throw out of `run`; the runner
 *     framework already converts uncaught errors into `failed` outcomes, but
 *     the playbook prefers structured `fail()` results so callers see
 *     evidence.
 *   - Re-fetch `ctx.pageModel()` after every wizard mutation so we observe
 *     fresh `isCurrent` step / Next-button state.
 *   - Status semantics: `ok` = the playbook's hypothesis held; `suspicious` =
 *     the playbook found probable evidence of a bug (data lost, blank page,
 *     missing validation); `failed` = something the playbook depended on was
 *     missing (no wizard on page, no Next button, etc.).
 */

import type { Page } from 'playwright';
import { z } from 'zod';
import type { ActionRef, PageModel, WizardSpec } from '../page-model/types.ts';
import type { Playbook, PlaybookRegistry } from './framework.ts';
import { fail, ok, type PlaybookStep, suspicious } from './outcome.ts';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Find the wizard with a given id on the freshly-extracted PageModel, or
 * `undefined`. */
function findWizard(model: PageModel, wizardId: string): WizardSpec | undefined {
  return model.wizards.find((w) => w.id === wizardId);
}

/** Index of the current step (`isCurrent === true`), or -1 if none. */
function currentStepIndex(wizard: WizardSpec): number {
  return wizard.steps.findIndex((s) => s.isCurrent);
}

/** Click an `ActionRef`, recording a step. Returns true on success. */
async function clickAction(
  page: Page,
  action: ActionRef | undefined,
  label: string,
  steps: PlaybookStep[],
): Promise<boolean> {
  if (!action) {
    steps.push({ label, ok: false, detail: 'action ref missing' });
    return false;
  }
  if (action.disabled) {
    steps.push({ label, ok: false, detail: 'action disabled' });
    return false;
  }
  try {
    await page.locator(action.locator).first().click({ timeout: 5_000 });
    steps.push({ label, ok: true });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({ label, ok: false, detail: message });
    return false;
  }
}

/** Fill a single form field by label (best-effort). */
async function fillByLabel(
  page: Page,
  label: string,
  value: string,
): Promise<{ ok: boolean; detail?: string }> {
  // Try a series of locator strategies in order. Same approach used by other
  // playbook modules.
  const attempts: Array<() => Promise<void>> = [
    () => page.getByLabel(label, { exact: false }).first().fill(value, { timeout: 2_000 }),
    () => page.locator(`[name="${label}"]`).first().fill(value, { timeout: 2_000 }),
    () => page.getByPlaceholder(label, { exact: false }).first().fill(value, { timeout: 2_000 }),
    () => page.locator(`[aria-label="${label}"]`).first().fill(value, { timeout: 2_000 }),
  ];
  let lastError: string | undefined;
  for (const attempt of attempts) {
    try {
      await attempt();
      return { ok: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, detail: lastError ?? 'no matching field' };
}

/** Fill all fields in a values map for one step; collects per-field steps. */
async function fillStepValues(
  page: Page,
  values: Record<string, string>,
  stepIndex: number,
  steps: PlaybookStep[],
): Promise<{ filled: number; missed: number }> {
  let filled = 0;
  let missed = 0;
  for (const [label, value] of Object.entries(values)) {
    const result = await fillByLabel(page, label, value);
    steps.push({
      label: `step ${stepIndex} fill "${label}"`,
      ok: result.ok,
      detail: result.detail,
    });
    if (result.ok) filled += 1;
    else missed += 1;
  }
  return { filled, missed };
}

/** Read the current values of a labelled set of fields; used by
 * `wizard_back_in_middle` to assert data preservation. */
async function readByLabel(page: Page, label: string): Promise<string | null> {
  const candidates: Array<() => Promise<string>> = [
    () => page.getByLabel(label, { exact: false }).first().inputValue({ timeout: 1_000 }),
    () => page.locator(`[name="${label}"]`).first().inputValue({ timeout: 1_000 }),
    () => page.locator(`[aria-label="${label}"]`).first().inputValue({ timeout: 1_000 }),
  ];
  for (const attempt of candidates) {
    try {
      return await attempt();
    } catch {
      // try next strategy
    }
  }
  return null;
}

/** Look for any element commonly used to surface validation: aria-invalid, a
 * `[role=alert]`, or an `.error` / `:invalid` selector match. Only counts a
 * probe as "surfaced" if the matching element is visible — many real apps
 * keep error containers in the DOM and toggle visibility, which would
 * produce false positives if we just used `.count()`. */
async function hasValidationSurface(page: Page): Promise<boolean> {
  const probes = [
    '[aria-invalid="true"]',
    '[role="alert"]',
    '.error',
    '.field-error',
    '[data-error]',
    'input:invalid',
    'textarea:invalid',
    'select:invalid',
  ];
  for (const sel of probes) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (await loc.isVisible()) return true;
    } catch {
      // ignore selector errors and continue
    }
  }
  return false;
}

/** Visible body text length; used as a "page is empty" heuristic. */
async function bodyTextLength(page: Page): Promise<number> {
  try {
    const text = await page.locator('body').innerText({ timeout: 2_000 });
    return text.trim().length;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------------------------
// Playbook 1: wizard_full_walkthrough
// --------------------------------------------------------------------------

const fullWalkthroughInput = {
  wizardId: z.string(),
  valuesPerStep: z.record(z.string(), z.record(z.string(), z.string())).optional(),
};

type FullWalkthroughInput = {
  wizardId: string;
  valuesPerStep?: Record<string, Record<string, string>>;
};

export const wizard_full_walkthrough: Playbook<FullWalkthroughInput> = {
  name: 'wizard_full_walkthrough',
  description:
    'Walk a wizard end-to-end: at each step fill fields from valuesPerStep, click Next, and at the last step click Finish. Suspicious if Next is disabled when expected enabled.',
  categories: ['wizard'],
  estimatedDurationMs: 12_000,
  inputShape: fullWalkthroughInput,
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const stepEvidence: Array<{
      stepIndex: number;
      label: string;
      filled: number;
      missed: number;
      advanced: boolean;
    }> = [];

    let model = await ctx.pageModel();
    let wizard = findWizard(model, input.wizardId);
    if (!wizard) {
      return fail(
        'wizard_full_walkthrough',
        `no wizard with id "${input.wizardId}" on current page`,
        { wizardId: input.wizardId, foundWizards: model.wizards.map((w) => w.id) },
        steps,
      );
    }

    const totalSteps = wizard.steps.length;
    if (totalSteps === 0) {
      return fail(
        'wizard_full_walkthrough',
        'wizard reports zero steps',
        { wizardId: input.wizardId },
        steps,
      );
    }

    let nextDisabledUnexpectedly = false;

    for (let i = 0; i < totalSteps; i += 1) {
      const valuesForStep =
        input.valuesPerStep?.[String(i)] ?? input.valuesPerStep?.[String(i + 1)] ?? {};
      const fillStats = await fillStepValues(ctx.page, valuesForStep, i, steps);

      const isLast = i === totalSteps - 1;
      const action = isLast ? wizard.finish : wizard.next;
      const actionLabel = isLast ? 'Finish' : 'Next';

      // Tracking the spec-level disabled flag separately from click failure:
      // a wizard whose Next is disabled with all required fields filled is
      // probable-bug evidence (suspicious), distinct from a missing button
      // (failed).
      if (action?.disabled && !isLast) {
        nextDisabledUnexpectedly = true;
      }

      const advanced = await clickAction(ctx.page, action, `step ${i} click ${actionLabel}`, steps);
      stepEvidence.push({
        stepIndex: i,
        label: wizard.steps[i]?.label ?? `step ${i}`,
        filled: fillStats.filled,
        missed: fillStats.missed,
        advanced,
      });

      if (!advanced) {
        // Re-check fresh model — maybe Next was rendered after a microtask.
        model = await ctx.pageModel();
        wizard = findWizard(model, input.wizardId) ?? wizard;
        return fail(
          'wizard_full_walkthrough',
          `failed to advance past step ${i} (${actionLabel})`,
          { wizardId: input.wizardId, stepEvidence },
          steps,
        );
      }

      if (!isLast) {
        model = await ctx.pageModel();
        const refreshed = findWizard(model, input.wizardId);
        if (refreshed) wizard = refreshed;
      }
    }

    if (nextDisabledUnexpectedly) {
      return suspicious(
        'wizard_full_walkthrough',
        'Next button was disabled mid-wizard with values filled',
        { wizardId: input.wizardId, stepEvidence },
        steps,
      );
    }

    return ok(
      'wizard_full_walkthrough',
      `walked ${totalSteps} steps and clicked Finish`,
      { wizardId: input.wizardId, stepEvidence },
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// Playbook 2: wizard_skip_branches
// --------------------------------------------------------------------------

const skipBranchesInput = { wizardId: z.string() };

export const wizard_skip_branches: Playbook<{ wizardId: string }> = {
  name: 'wizard_skip_branches',
  description:
    'Walk each wizard step; if a Skip affordance exists, click it; verify the wizard advances. Records which steps offered Skip vs Next.',
  categories: ['wizard'],
  estimatedDurationMs: 10_000,
  inputShape: skipBranchesInput,
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const branches: Array<{
      stepIndex: number;
      hadSkip: boolean;
      advanced: boolean;
      via: 'skip' | 'next' | 'finish' | 'none';
    }> = [];

    let model = await ctx.pageModel();
    let wizard = findWizard(model, input.wizardId);
    if (!wizard) {
      return fail(
        'wizard_skip_branches',
        `no wizard with id "${input.wizardId}" on current page`,
        { wizardId: input.wizardId },
        steps,
      );
    }

    const totalSteps = wizard.steps.length;
    if (totalSteps === 0) {
      return fail(
        'wizard_skip_branches',
        'wizard reports zero steps',
        { wizardId: input.wizardId },
        steps,
      );
    }

    for (let i = 0; i < totalSteps; i += 1) {
      const indexBefore = currentStepIndex(wizard);
      const isLast = i === totalSteps - 1;
      const hasSkip = !!wizard.skip && !wizard.skip.disabled;

      let advanced = false;
      let via: 'skip' | 'next' | 'finish' | 'none' = 'none';

      if (hasSkip && !isLast) {
        advanced = await clickAction(ctx.page, wizard.skip, `step ${i} click Skip`, steps);
        via = advanced ? 'skip' : 'none';
      }
      if (!advanced) {
        const fallback = isLast ? wizard.finish : wizard.next;
        const fallbackLabel = isLast ? 'Finish' : 'Next';
        advanced = await clickAction(ctx.page, fallback, `step ${i} click ${fallbackLabel}`, steps);
        if (advanced) via = isLast ? 'finish' : 'next';
      }

      branches.push({ stepIndex: i, hadSkip: hasSkip, advanced, via });

      if (!advanced) {
        return fail(
          'wizard_skip_branches',
          `step ${i} could not advance via Skip or Next`,
          { wizardId: input.wizardId, branches },
          steps,
        );
      }

      if (!isLast) {
        model = await ctx.pageModel();
        const refreshed = findWizard(model, input.wizardId);
        if (refreshed) {
          wizard = refreshed;
          const indexAfter = currentStepIndex(wizard);
          // Suspicious: clicked Skip but step index didn't change.
          if (via === 'skip' && indexBefore >= 0 && indexAfter === indexBefore) {
            return suspicious(
              'wizard_skip_branches',
              `Skip on step ${i} did not advance the wizard`,
              { wizardId: input.wizardId, branches, indexBefore, indexAfter },
              steps,
            );
          }
        }
      }
    }

    return ok(
      'wizard_skip_branches',
      `walked ${totalSteps} steps, ${branches.filter((b) => b.via === 'skip').length} via Skip`,
      { wizardId: input.wizardId, branches },
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// Playbook 3: wizard_back_in_middle
// --------------------------------------------------------------------------

const backInMiddleInput = {
  wizardId: z.string(),
  valuesPerStep: z.record(z.string(), z.record(z.string(), z.string())).optional(),
};

type BackInMiddleInput = {
  wizardId: string;
  valuesPerStep?: Record<string, Record<string, string>>;
};

export const wizard_back_in_middle: Playbook<BackInMiddleInput> = {
  name: 'wizard_back_in_middle',
  description:
    'Walk forward to step 3, click Back twice, then assert previously-entered values are still in the step-1 fields. Suspicious if data was lost.',
  categories: ['wizard'],
  estimatedDurationMs: 12_000,
  inputShape: backInMiddleInput,
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    let model = await ctx.pageModel();
    let wizard = findWizard(model, input.wizardId);
    if (!wizard) {
      return fail(
        'wizard_back_in_middle',
        `no wizard with id "${input.wizardId}" on current page`,
        { wizardId: input.wizardId },
        steps,
      );
    }

    if (wizard.steps.length < 3) {
      return fail(
        'wizard_back_in_middle',
        `wizard has only ${wizard.steps.length} steps; needs at least 3`,
        { wizardId: input.wizardId },
        steps,
      );
    }

    // Walk forward until current step >= 2 (i.e. third step).
    const targetIndex = 2;
    for (let i = 0; i < targetIndex; i += 1) {
      const valuesForStep =
        input.valuesPerStep?.[String(i)] ?? input.valuesPerStep?.[String(i + 1)] ?? {};
      await fillStepValues(ctx.page, valuesForStep, i, steps);
      const advanced = await clickAction(ctx.page, wizard.next, `step ${i} click Next`, steps);
      if (!advanced) {
        return fail(
          'wizard_back_in_middle',
          `failed to advance past step ${i}`,
          { wizardId: input.wizardId },
          steps,
        );
      }
      model = await ctx.pageModel();
      const refreshed = findWizard(model, input.wizardId);
      if (refreshed) wizard = refreshed;
    }

    // Back x 2, refreshing the wizard each time so we have a current Back ref.
    for (let i = 0; i < 2; i += 1) {
      const wentBack = await clickAction(ctx.page, wizard.back, `click Back #${i + 1}`, steps);
      if (!wentBack) {
        return fail(
          'wizard_back_in_middle',
          `failed to click Back #${i + 1}`,
          { wizardId: input.wizardId },
          steps,
        );
      }
      model = await ctx.pageModel();
      const refreshed = findWizard(model, input.wizardId);
      if (refreshed) wizard = refreshed;
    }

    // Verify step-0 values are still present.
    const expected = input.valuesPerStep?.['0'] ?? input.valuesPerStep?.['1'] ?? {};
    const lostFields: string[] = [];
    const preservedFields: string[] = [];
    for (const [label, want] of Object.entries(expected)) {
      const got = await readByLabel(ctx.page, label);
      if (got === want) preservedFields.push(label);
      else lostFields.push(`${label}: expected="${want}" got="${got ?? '<missing>'}"`);
    }
    steps.push({
      label: 'verify step-0 values preserved',
      ok: lostFields.length === 0,
      detail: lostFields.length > 0 ? lostFields.join(', ') : undefined,
    });

    if (lostFields.length > 0) {
      return suspicious(
        'wizard_back_in_middle',
        `${lostFields.length} field(s) lost when navigating back`,
        { wizardId: input.wizardId, lostFields, preservedFields },
        steps,
      );
    }

    return ok(
      'wizard_back_in_middle',
      `${preservedFields.length} field(s) preserved across back-navigation`,
      { wizardId: input.wizardId, preservedFields },
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// Playbook 4: wizard_browser_back_kills_state
// --------------------------------------------------------------------------

const browserBackInput = { wizardId: z.string() };

export const wizard_browser_back_kills_state: Playbook<{ wizardId: string }> = {
  name: 'wizard_browser_back_kills_state',
  description:
    'Walk to step 2, then call page.goBack() to use the browser back-button. Suspicious if the wizard lands on about:blank or an empty page; ok if the wizard recovers gracefully.',
  categories: ['wizard', 'chaos'],
  estimatedDurationMs: 10_000,
  inputShape: browserBackInput,
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];

    let model = await ctx.pageModel();
    let wizard = findWizard(model, input.wizardId);
    if (!wizard) {
      return fail(
        'wizard_browser_back_kills_state',
        `no wizard with id "${input.wizardId}" on current page`,
        { wizardId: input.wizardId },
        steps,
      );
    }

    if (wizard.steps.length < 2) {
      return fail(
        'wizard_browser_back_kills_state',
        `wizard has only ${wizard.steps.length} steps; needs at least 2`,
        { wizardId: input.wizardId },
        steps,
      );
    }

    // Walk to step 2 (index 1).
    const advanced = await clickAction(ctx.page, wizard.next, 'step 0 click Next', steps);
    if (!advanced) {
      return fail(
        'wizard_browser_back_kills_state',
        'failed to advance past step 0',
        { wizardId: input.wizardId },
        steps,
      );
    }

    model = await ctx.pageModel();
    const refreshed = findWizard(model, input.wizardId);
    if (refreshed) wizard = refreshed;

    // Call page.goBack(). This may resolve to null if there's nothing to go
    // back to, which itself is suspicious (the wizard wasn't pushed onto the
    // history stack).
    let goBackError: string | undefined;
    let goBackOk = false;
    try {
      const response = await ctx.page.goBack({ timeout: 5_000, waitUntil: 'load' });
      goBackOk = true;
      steps.push({
        label: 'page.goBack',
        ok: true,
        detail: response ? `status=${response.status()}` : 'no response (no history)',
      });
    } catch (err) {
      goBackError = err instanceof Error ? err.message : String(err);
      steps.push({ label: 'page.goBack', ok: false, detail: goBackError });
    }

    const url = ctx.page.url();
    const textLen = await bodyTextLength(ctx.page);
    const recoveredModel = await ctx.pageModel();
    const recoveredWizard = findWizard(recoveredModel, input.wizardId);

    const evidence = {
      wizardId: input.wizardId,
      goBackOk,
      goBackError,
      urlAfterBack: url,
      bodyTextLen: textLen,
      wizardStillPresent: !!recoveredWizard,
      pageLooksBroken: recoveredModel.looksBroken,
    };

    if (url === 'about:blank' || textLen === 0) {
      return suspicious(
        'wizard_browser_back_kills_state',
        `browser back left page in unrecoverable state (url=${url}, body length=${textLen})`,
        evidence,
        steps,
      );
    }

    return ok(
      'wizard_browser_back_kills_state',
      `browser back returned to a non-empty page (wizard ${
        recoveredWizard ? 'still present' : 'gone'
      })`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// Playbook 5: wizard_validation_per_step
// --------------------------------------------------------------------------

const validationInput = { wizardId: z.string() };

export const wizard_validation_per_step: Playbook<{ wizardId: string }> = {
  name: 'wizard_validation_per_step',
  description:
    'At each wizard step, click Next without filling required fields and assert validation surfaces. Suspicious if a step advances despite missing required input.',
  categories: ['wizard', 'form'],
  estimatedDurationMs: 10_000,
  inputShape: validationInput,
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const perStep: Array<{
      stepIndex: number;
      validationSurfaced: boolean;
      advanced: boolean;
    }> = [];

    let model = await ctx.pageModel();
    let wizard = findWizard(model, input.wizardId);
    if (!wizard) {
      return fail(
        'wizard_validation_per_step',
        `no wizard with id "${input.wizardId}" on current page`,
        { wizardId: input.wizardId },
        steps,
      );
    }
    if (wizard.steps.length === 0) {
      return fail(
        'wizard_validation_per_step',
        'wizard reports zero steps',
        { wizardId: input.wizardId },
        steps,
      );
    }

    const totalSteps = wizard.steps.length;
    let leakedAdvances = 0;

    for (let i = 0; i < totalSteps; i += 1) {
      const indexBefore = currentStepIndex(wizard);
      const isLast = i === totalSteps - 1;
      const action = isLast ? wizard.finish : wizard.next;
      const label = isLast ? 'Finish' : 'Next';

      // Click Next/Finish without filling anything.
      const clicked = await clickAction(
        ctx.page,
        action,
        `step ${i} click ${label} (empty)`,
        steps,
      );

      const surfaced = await hasValidationSurface(ctx.page);

      // Re-fetch model to see if step advanced.
      model = await ctx.pageModel();
      const refreshed = findWizard(model, input.wizardId);
      let advanced = false;
      if (refreshed) {
        const indexAfter = currentStepIndex(refreshed);
        advanced = indexBefore >= 0 && indexAfter > indexBefore;
        wizard = refreshed;
      }

      perStep.push({ stepIndex: i, validationSurfaced: surfaced, advanced });
      steps.push({
        label: `step ${i} validation`,
        ok: surfaced || !advanced,
        detail: `surfaced=${surfaced} advanced=${advanced} clicked=${clicked}`,
      });

      // If the wizard advanced anyway, we want to keep walking the rest of
      // the wizard for full coverage but record the leak.
      if (advanced && !surfaced) leakedAdvances += 1;

      // If we didn't advance, we're stuck on this step — fill nothing,
      // simulate a forced-advance by clicking once more after dismissing
      // validation: the simplest portable approach is to break out and
      // accept partial coverage. Real apps differ. We attempt to skip past
      // by filling no values and breaking when stuck twice.
      if (!advanced) break;
    }

    if (leakedAdvances > 0) {
      return suspicious(
        'wizard_validation_per_step',
        `${leakedAdvances} step(s) advanced despite missing required input and no validation surface`,
        { wizardId: input.wizardId, perStep, leakedAdvances },
        steps,
      );
    }

    const surfacedCount = perStep.filter((s) => s.validationSurfaced).length;
    if (surfacedCount === 0) {
      return suspicious(
        'wizard_validation_per_step',
        'no validation surfaced on any step (and wizard did not advance)',
        { wizardId: input.wizardId, perStep },
        steps,
      );
    }

    return ok(
      'wizard_validation_per_step',
      `${surfacedCount} step(s) surfaced validation when Next was clicked empty`,
      { wizardId: input.wizardId, perStep },
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// Playbook 6: wizard_abandon_and_resume
// --------------------------------------------------------------------------

const abandonInput = {
  wizardId: z.string(),
  valuesPerStep: z.record(z.string(), z.record(z.string(), z.string())).optional(),
};

type AbandonInput = {
  wizardId: string;
  valuesPerStep?: Record<string, Record<string, string>>;
};

export const wizard_abandon_and_resume: Playbook<AbandonInput> = {
  name: 'wizard_abandon_and_resume',
  description:
    'Walk halfway through a wizard, navigate to the site root, then back to the wizard URL, and observe whether state was preserved or the user is re-prompted.',
  categories: ['wizard', 'chaos'],
  estimatedDurationMs: 15_000,
  inputShape: abandonInput,
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];

    let model = await ctx.pageModel();
    let wizard = findWizard(model, input.wizardId);
    if (!wizard) {
      return fail(
        'wizard_abandon_and_resume',
        `no wizard with id "${input.wizardId}" on current page`,
        { wizardId: input.wizardId },
        steps,
      );
    }

    if (wizard.steps.length < 2) {
      return fail(
        'wizard_abandon_and_resume',
        `wizard has only ${wizard.steps.length} steps; needs at least 2`,
        { wizardId: input.wizardId },
        steps,
      );
    }

    const wizardUrl = ctx.page.url();
    const halfway = Math.max(1, Math.floor(wizard.steps.length / 2));

    // Walk forward halfway, filling whatever values were supplied.
    for (let i = 0; i < halfway; i += 1) {
      const valuesForStep =
        input.valuesPerStep?.[String(i)] ?? input.valuesPerStep?.[String(i + 1)] ?? {};
      await fillStepValues(ctx.page, valuesForStep, i, steps);
      const advanced = await clickAction(ctx.page, wizard.next, `step ${i} click Next`, steps);
      if (!advanced) {
        return fail(
          'wizard_abandon_and_resume',
          `failed to advance past step ${i}`,
          { wizardId: input.wizardId },
          steps,
        );
      }
      model = await ctx.pageModel();
      const refreshed = findWizard(model, input.wizardId);
      if (refreshed) wizard = refreshed;
    }

    const stepBeforeAbandon = currentStepIndex(wizard);

    // Navigate to root.
    let rootUrl: string;
    try {
      const u = new URL(wizardUrl);
      rootUrl = `${u.origin}/`;
      await ctx.page.goto(rootUrl, { timeout: 5_000, waitUntil: 'load' });
      steps.push({ label: `goto root ${rootUrl}`, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ label: 'goto root', ok: false, detail: message });
      return fail(
        'wizard_abandon_and_resume',
        `failed to navigate away: ${message}`,
        { wizardId: input.wizardId },
        steps,
      );
    }

    // Navigate back to wizard URL.
    try {
      await ctx.page.goto(wizardUrl, { timeout: 5_000, waitUntil: 'load' });
      steps.push({ label: `goto wizard url ${wizardUrl}`, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ label: 'goto wizard url', ok: false, detail: message });
      return fail(
        'wizard_abandon_and_resume',
        `failed to return to wizard: ${message}`,
        { wizardId: input.wizardId },
        steps,
      );
    }

    const resumedModel = await ctx.pageModel();
    const resumedWizard = findWizard(resumedModel, input.wizardId);
    const stepAfterResume = resumedWizard ? currentStepIndex(resumedWizard) : -1;

    // Check whether values from step 0 are still present.
    const expected = input.valuesPerStep?.['0'] ?? input.valuesPerStep?.['1'] ?? {};
    const preservedFields: string[] = [];
    const reprompedFields: string[] = [];
    for (const [label, want] of Object.entries(expected)) {
      const got = await readByLabel(ctx.page, label);
      if (got === want) preservedFields.push(label);
      else reprompedFields.push(label);
    }

    const statePreserved = stepAfterResume === stepBeforeAbandon && reprompedFields.length === 0;

    return ok(
      'wizard_abandon_and_resume',
      statePreserved
        ? `state preserved: resumed at step ${stepAfterResume}`
        : `re-prompted: started at step ${stepAfterResume} (was ${stepBeforeAbandon})`,
      {
        wizardId: input.wizardId,
        statePreserved,
        stepBeforeAbandon,
        stepAfterResume,
        preservedFields,
        reprompedFields,
      },
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

/** Register every wizard playbook on the given registry. Called by the
 * default-aggregator built in WP3 (`src/playbooks/index.ts`). */
export function registerWizardPlaybooks(r: PlaybookRegistry): void {
  r.register(wizard_full_walkthrough);
  r.register(wizard_skip_branches);
  r.register(wizard_back_in_middle);
  r.register(wizard_browser_back_kills_state);
  r.register(wizard_validation_per_step);
  r.register(wizard_abandon_and_resume);
}
