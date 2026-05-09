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
  testBackNav: z.boolean().optional(),
} satisfies z.ZodRawShape;

export interface WalkWizardInput {
  wizardId: string;
  stepInputs: Record<string, string>[];
  expectFinish?: boolean;
  /** When true, after completing step 2+ click Back and verify that the
   * previous step's values are still present. Default: false. */
  testBackNav?: boolean;
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
 * Read a field value by label for back-navigation verification. Tries the
 * same multi-strategy locators as fillByLabel.
 */
async function readFieldValue(page: Page, label: string): Promise<{ ok: boolean; value: string }> {
  const attempts: Array<() => Promise<string>> = [
    () => page.getByLabel(label, { exact: false }).first().inputValue({ timeout: FILL_TIMEOUT_MS }),
    () => page.locator(`[name="${label}"]`).first().inputValue({ timeout: FILL_TIMEOUT_MS }),
    () =>
      page
        .getByPlaceholder(label, { exact: false })
        .first()
        .inputValue({ timeout: FILL_TIMEOUT_MS }),
    () => page.locator(`[aria-label="${label}"]`).first().inputValue({ timeout: FILL_TIMEOUT_MS }),
  ];
  for (const attempt of attempts) {
    try {
      const value = await attempt();
      return { ok: true, value };
    } catch {
      // try next strategy
    }
  }
  return { ok: false, value: '' };
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
    "Step through a multi-step wizard. `stepInputs[i]` is the field-values map for step i+1 (keys are field labels, values are strings to fill). Clicks Next between steps and Finish on the last step when `expectFinish` is true (the default). Set `testBackNav: true` to verify that navigating Back from the last step preserves the previous step's field values (catches state-loss bugs). Status: `ok` on completion, `suspicious` if stuck mid-walk, back-nav loses state, or Finish missing/failed; `failed` if `wizardId` is unknown.",
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
    // Back-navigation test: after completing at least 2 steps, click Back
    // and verify the previous step's field values are preserved.
    // ------------------------------------------------------------------
    const backNavResults: Array<{ step: number; preserved: boolean; detail: string }> = [];
    if (input.testBackNav && stuckAt === null && stepResults.length >= 2) {
      const backRef = wizard.back;
      if (backRef && !backRef.disabled) {
        const backCount = await ctx.page
          .locator(backRef.locator)
          .count()
          .catch(() => 0);
        if (backCount > 0) {
          // We're currently on the last step; go back one step and verify
          // the previous step's values persisted.
          const prevStepIndex = stepResults.length - 2;
          const prevInputs = input.stepInputs[prevStepIndex];
          try {
            await ctx.page.locator(backRef.locator).first().click({ timeout: STEP_TIMEOUT_MS });
            await ctx.page
              .waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS })
              .catch(() => {});

            // Read back each value and compare
            let allPreserved = true;
            const mismatches: string[] = [];
            for (const [label, expected] of Object.entries(prevInputs)) {
              const readResult = await readFieldValue(ctx.page, label);
              if (readResult.ok && readResult.value !== expected) {
                allPreserved = false;
                mismatches.push(`'${label}': expected='${expected}' actual='${readResult.value}'`);
              }
            }
            backNavResults.push({
              step: prevStepIndex + 1,
              preserved: allPreserved,
              detail: allPreserved
                ? 'all values preserved after back-nav'
                : `mismatches: ${mismatches.join('; ')}`,
            });
            steps.push({
              label: `back-nav to step ${prevStepIndex + 1}: ${allPreserved ? 'values preserved' : 'values lost'}`,
              ok: allPreserved,
              detail: allPreserved ? undefined : mismatches.join('; '),
            });

            // Re-advance to the last step so Finish can proceed
            const nextRef = wizard.next;
            if (nextRef && !nextRef.disabled) {
              try {
                await ctx.page.locator(nextRef.locator).first().click({ timeout: STEP_TIMEOUT_MS });
                await ctx.page
                  .waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS })
                  .catch(() => {});
              } catch {
                steps.push({
                  label: 'back-nav: failed to re-advance after back test',
                  ok: false,
                });
              }
            }
          } catch (err) {
            steps.push({
              label: 'back-nav: Back click failed',
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          steps.push({
            label: 'back-nav: Back button not found in DOM — skipped',
            ok: true,
          });
        }
      } else {
        steps.push({
          label: `back-nav: Back button ${backRef ? 'disabled' : 'not in page model'} — skipped`,
          ok: true,
        });
      }
    }
    evidence.backNavResults = backNavResults;

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

    // Back-nav state-loss is suspicious even if the forward walk succeeded.
    const backNavFailed = backNavResults.some((r) => !r.preserved);
    if (backNavFailed) {
      return suspicious(
        walkWizard.name,
        `Wizard '${input.wizardId}' completed forward walk, but back-navigation lost field state: ${backNavResults
          .filter((r) => !r.preserved)
          .map((r) => `step ${r.step}: ${r.detail}`)
          .join('; ')}`,
        evidence,
        steps,
      );
    }

    return ok(
      walkWizard.name,
      `Walked ${stepResults.length} step(s) of '${input.wizardId}'${finishClicked ? ' and clicked Finish' : ''}${backNavResults.length > 0 ? '; back-nav state preserved' : ''}.`,
      evidence,
      steps,
    );
  },
};
