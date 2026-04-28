/**
 * Wizard playbook — `walk_wizard`. Replaces the previous wizards.ts which
 * held 6 playbooks (full-walkthrough, skip-branches, back-in-middle,
 * browser-back, validation-per-step, abandon-and-resume).
 *
 * WizardSpec (src/page-model/types.ts) exposes:
 *   - wizardLocator: string          — stable CSS/role locator for container
 *   - steps: { label, index, isCurrent }[]  — step indicators only, no fields
 *   - next?: ActionRef               — Next button (locator + disabled flag)
 *   - finish?: ActionRef             — Finish/Submit button
 *   - back/skip/cancel?: ActionRef
 *
 * Because steps carry no field descriptors, field filling uses label-based
 * heuristics identical to the previous wizard_full_walkthrough helper:
 *   page.getByLabel → [name=...] → getByPlaceholder → [aria-label=...]
 *
 * The persona drives input choice; this playbook handles the mechanical
 * step-by-step traversal.
 */

import type { Page } from 'playwright';
import { z } from 'zod';
import type { WizardSpec } from '../page-model/types.ts';
import type { Playbook } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

const STEP_TIMEOUT_MS = 5_000;
const FILL_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const walkWizardShape = {
  wizardId: z.string(),
  stepInputs: z.array(z.record(z.string(), z.string())),
  expectFinish: z.boolean().optional(),
} satisfies z.ZodRawShape;

export interface WalkWizardInput {
  wizardId: string;
  stepInputs: Record<string, string>[];
  expectFinish?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fill a single field by label using the same multi-strategy approach as the
 * previous fillByLabel helper in the legacy wizard playbooks. Tries in order:
 *   1. getByLabel (fuzzy)
 *   2. [name="<label>"]
 *   3. getByPlaceholder (fuzzy)
 *   4. [aria-label="<label>"]
 */
async function fillByLabel(
  page: Page,
  label: string,
  value: string,
): Promise<{ ok: boolean; detail?: string }> {
  const attempts: Array<() => Promise<void>> = [
    () =>
      page.getByLabel(label, { exact: false }).first().fill(value, { timeout: FILL_TIMEOUT_MS }),
    () => page.locator(`[name="${label}"]`).first().fill(value, { timeout: FILL_TIMEOUT_MS }),
    () =>
      page
        .getByPlaceholder(label, { exact: false })
        .first()
        .fill(value, { timeout: FILL_TIMEOUT_MS }),
    () => page.locator(`[aria-label="${label}"]`).first().fill(value, { timeout: FILL_TIMEOUT_MS }),
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

/**
 * Fill all key/value pairs for one step. Records one sub-step per field.
 * Returns counts of filled vs missed fields.
 */
async function fillStepInputs(
  page: Page,
  inputs: Record<string, string>,
  stepIndex: number,
  steps: PlaybookStep[],
): Promise<{ filled: number; missing: string[] }> {
  let filled = 0;
  const missing: string[] = [];
  for (const [label, value] of Object.entries(inputs)) {
    const result = await fillByLabel(page, label, value);
    steps.push({
      label: `step ${stepIndex + 1} fill "${label}"`,
      ok: result.ok,
      detail: result.detail,
    });
    if (result.ok) {
      filled += 1;
    } else {
      missing.push(label);
    }
  }
  return { filled, missing };
}

// ---------------------------------------------------------------------------
// Playbook definition
// ---------------------------------------------------------------------------

export const walkWizard: Playbook<WalkWizardInput> = {
  name: 'walk_wizard',
  description:
    'Step through a multi-step wizard. `stepInputs[i]` is the field-values map for step i+1 (keys are field labels, values are strings to fill). Clicks Next between steps and Finish on the last step when `expectFinish` is true (the default). Status: `ok` on completion, `suspicious` if stuck mid-walk (no Next button at a non-final step, or Finish required but missing/failed), `failed` if `wizardId` is unknown.',
  categories: ['wizard'],
  estimatedDurationMs: 12_000,
  inputShape: walkWizardShape,

  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { wizardId: input.wizardId };
    const expectFinish = input.expectFinish !== false;

    // ------------------------------------------------------------------
    // Resolve wizard from page model
    // ------------------------------------------------------------------
    const model = await ctx.pageModel();
    const wizard: WizardSpec | undefined = model.wizards.find((w) => w.id === input.wizardId);
    if (!wizard) {
      return fail(
        walkWizard.name,
        `wizard '${input.wizardId}' not found in current page model (${model.wizards.length} wizard(s) on this page)`,
        evidence,
        steps,
      );
    }

    evidence.wizardLocator = wizard.wizardLocator;

    // ------------------------------------------------------------------
    // Walk each step
    // ------------------------------------------------------------------
    const stepResults: Array<{
      index: number;
      filled: number;
      missing: string[];
      advanced: boolean;
    }> = [];
    let stuckAt: number | null = null;

    for (let i = 0; i < input.stepInputs.length; i++) {
      const inputs = input.stepInputs[i];
      const isLast = i === input.stepInputs.length - 1;

      // Fill step fields
      const fillResult = await fillStepInputs(ctx.page, inputs, i, steps);

      // On non-final steps, click Next to advance
      let advanced = false;
      if (!isLast) {
        // Use the wizard's next ActionRef if available and not disabled
        const nextRef = wizard.next;
        if (!nextRef || nextRef.disabled) {
          stuckAt = i;
          steps.push({
            label: `step ${i + 1}: Next button ${nextRef ? 'disabled' : 'not in page model'}`,
            ok: false,
          });
          stepResults.push({
            index: i,
            filled: fillResult.filled,
            missing: fillResult.missing,
            advanced: false,
          });
          break;
        }

        // Fast existence check before committing to a full click timeout.
        const nextCount = await ctx.page
          .locator(nextRef.locator)
          .count()
          .catch(() => 0);
        if (nextCount === 0) {
          stuckAt = i;
          steps.push({
            label: `step ${i + 1}: Next button not found in DOM`,
            ok: false,
          });
          stepResults.push({
            index: i,
            filled: fillResult.filled,
            missing: fillResult.missing,
            advanced: false,
          });
          break;
        }

        try {
          await ctx.page.locator(nextRef.locator).first().click({ timeout: STEP_TIMEOUT_MS });
          await ctx.page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS }).catch(() => {
            // networkidle is best-effort; DOM transitions without network are fine
          });
          advanced = true;
        } catch (err) {
          stuckAt = i;
          steps.push({
            label: `step ${i + 1}: Next click failed`,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
          stepResults.push({
            index: i,
            filled: fillResult.filled,
            missing: fillResult.missing,
            advanced: false,
          });
          break;
        }
      }

      steps.push({
        label: `step ${i + 1}: filled ${fillResult.filled}/${Object.keys(inputs).length}${isLast ? ' (last step)' : ', advanced'}`,
        ok: true,
        detail: fillResult.missing.length
          ? `missing fields: ${fillResult.missing.join(', ')}`
          : undefined,
      });
      stepResults.push({
        index: i,
        filled: fillResult.filled,
        missing: fillResult.missing,
        advanced: advanced || isLast,
      });
    }

    evidence.stepResults = stepResults;

    // ------------------------------------------------------------------
    // Click Finish on the last step (when expectFinish is true)
    // ------------------------------------------------------------------
    let finishClicked = false;
    let finishFound = false;

    if (stuckAt === null && expectFinish) {
      const finishRef = wizard.finish;

      if (finishRef?.disabled) {
        // Spec has a finish ref but it's disabled — nothing to click.
        finishFound = false;
        steps.push({ label: 'finish button disabled', ok: false });
      } else if (finishRef) {
        // Spec provides a finish ref — fast existence check before clicking.
        const finishCount = await ctx.page
          .locator(finishRef.locator)
          .count()
          .catch(() => 0);
        if (finishCount === 0) {
          finishFound = false;
          steps.push({ label: 'finish button not found in DOM', ok: false });
        } else {
          finishFound = true;
          try {
            await ctx.page.locator(finishRef.locator).first().click({ timeout: STEP_TIMEOUT_MS });
            await ctx.page
              .waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS })
              .catch(() => {});
            finishClicked = true;
            steps.push({ label: 'finish clicked', ok: true });
          } catch (err) {
            steps.push({
              label: 'finish click failed',
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        // No finish ActionRef in page model — fall back to heuristic text search
        // scoped to the wizard container when possible.
        const scope = wizard.wizardLocator ? ctx.page.locator(wizard.wizardLocator) : ctx.page;
        const heuristicBtn = scope
          .locator('button:not([disabled])')
          .filter({ hasText: /finish|complete|submit|done/i })
          .first();

        if ((await heuristicBtn.count().catch(() => 0)) > 0) {
          finishFound = true;
          try {
            await heuristicBtn.click({ timeout: STEP_TIMEOUT_MS });
            await ctx.page
              .waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS })
              .catch(() => {});
            finishClicked = true;
            steps.push({ label: 'finish clicked (heuristic)', ok: true });
          } catch (err) {
            steps.push({
              label: 'finish click failed (heuristic)',
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          steps.push({ label: 'finish button not found', ok: false });
        }
      }
    }

    evidence.finishClicked = finishClicked;
    evidence.finishFound = finishFound;
    evidence.stuckAt = stuckAt;

    // ------------------------------------------------------------------
    // Determine final status
    // ------------------------------------------------------------------
    if (stuckAt !== null) {
      return suspicious(
        walkWizard.name,
        `Stuck at step ${stuckAt + 1}: could not advance.`,
        evidence,
        steps,
      );
    }

    if (expectFinish && !finishClicked) {
      return suspicious(
        walkWizard.name,
        finishFound
          ? 'Finish button found but click failed.'
          : 'Reached final step but no Finish button appeared.',
        evidence,
        steps,
      );
    }

    return ok(
      walkWizard.name,
      `Walked ${stepResults.length} step(s) of '${input.wizardId}'${finishClicked ? ' and clicked Finish' : ''}.`,
      evidence,
      steps,
    );
  },
};
