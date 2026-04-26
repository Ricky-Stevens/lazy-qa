/**
 * Modal playbooks (spec §6.4).
 *
 * Five playbooks exercise dialogs / modals in a uniform way:
 *  - `modal_lifecycle` — open + close via every available closer (X, Cancel,
 *    Escape, click-outside) and verify the dialog actually leaves the DOM.
 *  - `modal_form_inside_save` — fill the modal's form, submit, verify dismiss.
 *  - `modal_cancel_loses_data` — type values, cancel, re-open, assert empty.
 *  - `modal_to_edit_screen` — click "View Full"/"Edit"/"Open" affordance, verify
 *    URL changes and new page references the same entity.
 *  - `modal_nested` — open inner modal from outer, close inner, assert outer
 *    survives.
 *
 * Every playbook returns a `PlaybookOutcome`. Internal failures become
 * `PlaybookStep`s with `ok: false`; we never throw.
 */

import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { ModalSpec, PageModel } from '../page-model/types.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import type { PlaybookOutcome, PlaybookStep } from './outcome.ts';
import { fail, ok, suspicious } from './outcome.ts';

const DIALOG_SELECTOR = '[role=dialog], dialog[open], [aria-modal="true"]';
const MODAL_TIMEOUT_MS = 2_000;
const DISMISS_TIMEOUT_MS = 800;

/** Locate a modal by its `ModalSpec.modalLocator`, falling back to `[role=dialog]`. */
function locateModal(page: Page, modal: ModalSpec | undefined): Locator {
  if (modal?.modalLocator) return page.locator(modal.modalLocator).first();
  return page.locator(DIALOG_SELECTOR).first();
}

/** Find the spec for a given modalId in the latest PageModel. Returns undefined
 * if the model doesn't know about it; the playbook still runs against the
 * generic `[role=dialog]` selector when this happens. */
function findModalSpec(model: PageModel, modalId: string): ModalSpec | undefined {
  return model.modals.find((m) => m.id === modalId);
}

/**
 * Try to (re-)open the modal. Strategy:
 *   1. If a Playwright trigger is provided, click it.
 *   2. Else look for any element with `aria-haspopup="dialog"`,
 *      `data-modal-trigger`, or text matching the modal name on the page.
 * Returns `true` if the dialog became visible within the timeout.
 */
async function openModal(
  page: Page,
  modal: ModalSpec | undefined,
  explicitTrigger?: string,
): Promise<{ opened: boolean; how: string }> {
  // If already open, we're done.
  const existing = locateModal(page, modal);
  try {
    if (await existing.isVisible({ timeout: 100 }).catch(() => false)) {
      return { opened: true, how: 'already-open' };
    }
  } catch {
    // ignore — fall through
  }

  const candidates: { selector: string; how: string }[] = [];
  if (explicitTrigger) candidates.push({ selector: explicitTrigger, how: 'explicit' });
  if (modal?.name) {
    candidates.push({
      selector: `role=button[name="${modal.name.replace(/"/g, '\\"')}" i]`,
      how: 'role-by-name',
    });
    candidates.push({
      selector: `text="${modal.name.replace(/"/g, '\\"')}"`,
      how: 'text-by-name',
    });
  }
  candidates.push({ selector: '[aria-haspopup="dialog"]', how: 'aria-haspopup' });
  candidates.push({ selector: '[data-modal-trigger]', how: 'data-modal-trigger' });

  for (const { selector, how } of candidates) {
    try {
      const trigger = page.locator(selector).first();
      if (!(await trigger.isVisible({ timeout: 100 }).catch(() => false))) continue;
      await trigger.click({ timeout: 1_000 });
      const dialog = locateModal(page, modal);
      await dialog.waitFor({ state: 'visible', timeout: MODAL_TIMEOUT_MS });
      return { opened: true, how };
    } catch {
      // try next candidate
    }
  }
  return { opened: false, how: 'none' };
}

/** Wait until the modal is absent or hidden. Returns true if dismissed.
 * Polls for hidden-or-detached rather than waiting for `detached`, because
 * many real modals just hide (display:none) instead of removing. */
async function waitForDismissed(dialog: Locator, timeoutMs = DISMISS_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await dialog.isVisible().catch(() => false);
    if (!visible) return true;
    await dialog.page().waitForTimeout(50);
  }
  return false;
}

/** Click the page body at coordinates outside the modal's bounding box. */
async function clickOutside(page: Page, dialog: Locator): Promise<boolean> {
  try {
    const box = await dialog.boundingBox();
    if (!box) {
      // No box → fall back to top-left corner.
      await page.mouse.click(5, 5);
      return true;
    }
    // Pick a point well outside the modal's bbox: prefer top-left of viewport,
    // else just below or to the right of the modal.
    const candidates: Array<[number, number]> = [
      [Math.max(2, box.x - 20), Math.max(2, box.y - 20)],
      [5, 5],
      [box.x + box.width + 20, box.y + box.height + 20],
    ];
    for (const [x, y] of candidates) {
      if (x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) {
        await page.mouse.click(x, y);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// modal_lifecycle
// --------------------------------------------------------------------------

interface LifecycleInputs {
  modalId: string;
  trigger?: string;
}

const lifecycle: Playbook<LifecycleInputs> = {
  name: 'modal_lifecycle',
  description:
    'Open the modal, then close it via each available method (X, Cancel, Escape, click-outside). Each closer is recorded as its own step. Status `ok` if at least one closer dismisses the modal; `suspicious` if every available closer fails.',
  categories: ['modal'],
  estimatedDurationMs: 8_000,
  inputShape: {
    modalId: z.string(),
    trigger: z.string().optional(),
  },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { modalId: input.modalId };
    const model = await ctx.pageModel();
    const modalSpec = findModalSpec(model, input.modalId);
    if (!modalSpec) {
      steps.push({
        label: 'lookup modal in PageModel',
        ok: false,
        detail: `modalId ${input.modalId} not in PageModel — using generic [role=dialog] selector`,
      });
    } else {
      steps.push({ label: 'lookup modal in PageModel', ok: true });
    }

    const closers: Array<{ name: string; run: () => Promise<{ ok: boolean; detail?: string }> }> = [
      {
        name: 'X button',
        run: async () => {
          const dialog = locateModal(ctx.page, modalSpec);
          const sel =
            modalSpec?.closers.x?.locator ??
            '[role=dialog] [aria-label="Close"], [role=dialog] button:has-text("×"), [role=dialog] [data-testid="close"]';
          const xBtn = (modalSpec?.closers.x ? ctx.page.locator(sel) : dialog.locator(sel)).first();
          if (!(await xBtn.isVisible({ timeout: 200 }).catch(() => false))) {
            return { ok: true, detail: 'no X close affordance present (skipped)' };
          }
          await xBtn.click();
          return { ok: await waitForDismissed(dialog) };
        },
      },
      {
        name: 'Cancel button',
        run: async () => {
          const dialog = locateModal(ctx.page, modalSpec);
          const sel =
            modalSpec?.closers.cancel?.locator ??
            '[role=dialog] button:has-text("Cancel"), [role=dialog] [data-testid="cancel"]';
          const cancelBtn = (
            modalSpec?.closers.cancel ? ctx.page.locator(sel) : dialog.locator(sel)
          ).first();
          if (!(await cancelBtn.isVisible({ timeout: 200 }).catch(() => false))) {
            return { ok: true, detail: 'no Cancel affordance present (skipped)' };
          }
          await cancelBtn.click();
          return { ok: await waitForDismissed(dialog) };
        },
      },
      {
        name: 'Escape key',
        run: async () => {
          const dialog = locateModal(ctx.page, modalSpec);
          await ctx.page.keyboard.press('Escape');
          const dismissed = await waitForDismissed(dialog);
          if (!dismissed) return { ok: false, detail: 'modal still visible after Escape' };
          return { ok: true };
        },
      },
      {
        name: 'click outside',
        run: async () => {
          const dialog = locateModal(ctx.page, modalSpec);
          const clicked = await clickOutside(ctx.page, dialog);
          if (!clicked) return { ok: false, detail: 'could not compute outside coords' };
          const dismissed = await waitForDismissed(dialog);
          if (!dismissed)
            return {
              ok: true,
              detail: 'click-outside did not close (modal may be intentionally sticky)',
            };
          return { ok: true };
        },
      },
    ];

    let dismissedCount = 0;
    let failedCount = 0;
    const closerResults: Record<string, { ok: boolean; detail?: string }> = {};

    for (const closer of closers) {
      // Re-open before each attempt (no-op if already open).
      const openResult = await openModal(ctx.page, modalSpec, input.trigger);
      if (!openResult.opened) {
        steps.push({
          label: `open before ${closer.name}`,
          ok: false,
          detail: 'could not open modal — aborting remaining closers',
        });
        break;
      }
      let res: { ok: boolean; detail?: string };
      try {
        res = await closer.run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res = { ok: false, detail: message };
      }
      closerResults[closer.name] = res;
      steps.push({
        label: `close via ${closer.name}`,
        ok: res.ok,
        detail: res.detail,
      });
      if (res.ok && !res.detail?.startsWith('no ') && !res.detail?.includes('did not close')) {
        dismissedCount += 1;
      } else if (!res.ok) {
        failedCount += 1;
      }
    }

    evidence.closerResults = closerResults;
    evidence.dismissedCount = dismissedCount;

    if (dismissedCount === 0 && failedCount > 0) {
      return suspicious(
        'modal_lifecycle',
        `No closer dismissed modal ${input.modalId}; ${failedCount} closers failed.`,
        evidence,
        steps,
      );
    }
    return ok(
      'modal_lifecycle',
      `Modal ${input.modalId} dismissed via ${dismissedCount} of ${closers.length} closers tried.`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// modal_form_inside_save
// --------------------------------------------------------------------------

interface FormInsideSaveInputs {
  modalId: string;
  valuesByLabel: Record<string, string>;
  trigger?: string;
}

const formInsideSave: Playbook<FormInsideSaveInputs> = {
  name: 'modal_form_inside_save',
  description:
    "Open a modal, fill its form by label, submit, and verify the modal dismisses. `valuesByLabel` is a label→value map matching the form's visible labels. Status `ok` if dismissed; `failed` otherwise.",
  categories: ['modal', 'form'],
  estimatedDurationMs: 6_000,
  inputShape: {
    modalId: z.string(),
    valuesByLabel: z.record(z.string(), z.string()),
    trigger: z.string().optional(),
  },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      modalId: input.modalId,
      attemptedFields: Object.keys(input.valuesByLabel),
    };
    const model = await ctx.pageModel();
    const modalSpec = findModalSpec(model, input.modalId);

    const opened = await openModal(ctx.page, modalSpec, input.trigger);
    steps.push({
      label: 'open modal',
      ok: opened.opened,
      detail: `via ${opened.how}`,
    });
    if (!opened.opened) {
      return fail(
        'modal_form_inside_save',
        `Could not open modal ${input.modalId}.`,
        evidence,
        steps,
      );
    }

    const dialog = locateModal(ctx.page, modalSpec);
    const filled: string[] = [];
    const skipped: Array<{ label: string; reason: string }> = [];

    for (const [label, value] of Object.entries(input.valuesByLabel)) {
      try {
        // getByLabel scoped to the dialog
        const field = dialog.getByLabel(label, { exact: false }).first();
        if (!(await field.isVisible({ timeout: 300 }).catch(() => false))) {
          skipped.push({ label, reason: 'not visible' });
          continue;
        }
        await field.fill(value);
        filled.push(label);
      } catch (err) {
        skipped.push({ label, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    steps.push({
      label: 'fill form fields',
      ok: filled.length > 0,
      detail: `filled=${filled.length} skipped=${skipped.length}`,
    });
    evidence.filled = filled;
    evidence.skipped = skipped;

    // Submit. Prefer the modal's primaryAction; else any submit-looking button.
    let submitted = false;
    try {
      const submit = modalSpec?.primaryAction
        ? ctx.page.locator(modalSpec.primaryAction.locator).first()
        : dialog
            .locator(
              'button[type=submit], button:has-text("Save"), button:has-text("Submit"), button:has-text("Create")',
            )
            .first();
      if (await submit.isVisible({ timeout: 500 }).catch(() => false)) {
        await submit.click();
        submitted = true;
      }
    } catch (err) {
      steps.push({
        label: 'click submit',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    steps.push({ label: 'click submit', ok: submitted });

    if (!submitted) {
      return fail(
        'modal_form_inside_save',
        `Could not locate submit affordance in modal ${input.modalId}.`,
        evidence,
        steps,
      );
    }

    const dismissed = await waitForDismissed(dialog, MODAL_TIMEOUT_MS);
    steps.push({ label: 'modal dismissed after submit', ok: dismissed });
    evidence.dismissed = dismissed;
    if (!dismissed) {
      return fail(
        'modal_form_inside_save',
        `Modal ${input.modalId} did not dismiss after submit.`,
        evidence,
        steps,
      );
    }
    return ok(
      'modal_form_inside_save',
      `Modal ${input.modalId} submitted and dismissed.`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// modal_cancel_loses_data
// --------------------------------------------------------------------------

interface CancelLosesDataInputs {
  modalId: string;
  partialValues: Record<string, string>;
  trigger?: string;
}

const cancelLosesData: Playbook<CancelLosesDataInputs> = {
  name: 'modal_cancel_loses_data',
  description:
    'Open a modal, type into fields by label, click Cancel, re-open and assert each field is empty. Status `ok` if data was lost (the expected behaviour); `suspicious` if any field retained the typed value across cancel/re-open.',
  categories: ['modal', 'form'],
  estimatedDurationMs: 6_000,
  inputShape: {
    modalId: z.string(),
    partialValues: z.record(z.string(), z.string()),
    trigger: z.string().optional(),
  },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { modalId: input.modalId };
    const model = await ctx.pageModel();
    const modalSpec = findModalSpec(model, input.modalId);

    const opened = await openModal(ctx.page, modalSpec, input.trigger);
    steps.push({ label: 'open modal', ok: opened.opened });
    if (!opened.opened) {
      return fail(
        'modal_cancel_loses_data',
        `Could not open modal ${input.modalId}.`,
        evidence,
        steps,
      );
    }
    let dialog = locateModal(ctx.page, modalSpec);

    const typed: string[] = [];
    for (const [label, value] of Object.entries(input.partialValues)) {
      try {
        const field = dialog.getByLabel(label, { exact: false }).first();
        if (!(await field.isVisible({ timeout: 300 }).catch(() => false))) continue;
        await field.fill(value);
        typed.push(label);
      } catch {
        // skip
      }
    }
    steps.push({
      label: 'type partial values',
      ok: typed.length > 0,
      detail: `typed=${typed.length}`,
    });
    evidence.typed = typed;

    // Cancel.
    let cancelClicked = false;
    try {
      const sel =
        modalSpec?.closers.cancel?.locator ??
        '[role=dialog] button:has-text("Cancel"), [role=dialog] [data-testid="cancel"]';
      const cancelBtn = (
        modalSpec?.closers.cancel ? ctx.page.locator(sel) : dialog.locator(sel)
      ).first();
      if (await cancelBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await cancelBtn.click();
        cancelClicked = true;
      }
    } catch {
      // fall through
    }
    if (!cancelClicked) {
      // Fall back to Escape so we can still verify the data-loss invariant.
      await ctx.page.keyboard.press('Escape');
    }
    const dismissed = await waitForDismissed(dialog, MODAL_TIMEOUT_MS);
    steps.push({
      label: 'cancel/escape dismisses modal',
      ok: dismissed,
      detail: cancelClicked ? 'via Cancel' : 'via Escape (no Cancel found)',
    });

    // Re-open.
    const reopened = await openModal(ctx.page, modalSpec, input.trigger);
    steps.push({ label: 're-open modal', ok: reopened.opened });
    if (!reopened.opened) {
      return fail(
        'modal_cancel_loses_data',
        `Could not re-open modal ${input.modalId} after cancel.`,
        evidence,
        steps,
      );
    }
    dialog = locateModal(ctx.page, modalSpec);

    const retained: Array<{ label: string; value: string }> = [];
    for (const label of typed) {
      try {
        const field = dialog.getByLabel(label, { exact: false }).first();
        if (!(await field.isVisible({ timeout: 300 }).catch(() => false))) continue;
        const current = await field.inputValue().catch(() => '');
        if (current && current === input.partialValues[label]) {
          retained.push({ label, value: current });
        }
      } catch {
        // skip
      }
    }
    evidence.retained = retained;
    steps.push({
      label: 'fields cleared after cancel',
      ok: retained.length === 0,
      detail: retained.length ? `retained: ${retained.map((r) => r.label).join(', ')}` : undefined,
    });

    if (retained.length > 0) {
      return suspicious(
        'modal_cancel_loses_data',
        `Modal ${input.modalId} retained ${retained.length} field(s) after Cancel.`,
        evidence,
        steps,
      );
    }
    return ok(
      'modal_cancel_loses_data',
      `Modal ${input.modalId} discarded all typed values on Cancel as expected.`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// modal_to_edit_screen
// --------------------------------------------------------------------------

interface ToEditScreenInputs {
  modalId: string;
  trigger?: string;
}

const toEditScreen: Playbook<ToEditScreenInputs> = {
  name: 'modal_to_edit_screen',
  description:
    'Open a modal and click any "View Full" / "Edit" / "Open" affordance. Verify the URL changes and the new route\'s title contains the modal\'s entity name (heuristic). Status `ok` on success; `suspicious` if the affordance exists but URL doesn\'t change.',
  categories: ['modal'],
  estimatedDurationMs: 6_000,
  inputShape: {
    modalId: z.string(),
    trigger: z.string().optional(),
  },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { modalId: input.modalId };
    const model = await ctx.pageModel();
    const modalSpec = findModalSpec(model, input.modalId);

    const opened = await openModal(ctx.page, modalSpec, input.trigger);
    steps.push({ label: 'open modal', ok: opened.opened });
    if (!opened.opened) {
      return fail(
        'modal_to_edit_screen',
        `Could not open modal ${input.modalId}.`,
        evidence,
        steps,
      );
    }
    const dialog = locateModal(ctx.page, modalSpec);

    // Try to capture the entity name BEFORE leaving the modal.
    let entityName: string | undefined = modalSpec?.name;
    try {
      const heading = dialog.locator('h1, h2, h3, [role=heading]').first();
      if (await heading.isVisible({ timeout: 200 }).catch(() => false)) {
        const t = await heading.textContent();
        if (t?.trim()) entityName = t.trim();
      }
    } catch {
      // ignore
    }
    evidence.entityName = entityName ?? null;

    const beforeUrl = ctx.page.url();
    evidence.beforeUrl = beforeUrl;

    // Find an "expand" affordance.
    const expandSel =
      'a:has-text("View Full"), a:has-text("Open"), a:has-text("Edit"), button:has-text("View Full"), button:has-text("Edit"), button:has-text("Open")';
    const expand = dialog.locator(expandSel).first();
    if (!(await expand.isVisible({ timeout: 500 }).catch(() => false))) {
      steps.push({
        label: 'find View Full / Edit / Open affordance',
        ok: false,
        detail: 'no expand affordance present',
      });
      return ok(
        'modal_to_edit_screen',
        `Modal ${input.modalId} has no "expand to edit screen" affordance — nothing to test.`,
        evidence,
        steps,
      );
    }
    steps.push({ label: 'find expand affordance', ok: true });

    try {
      await expand.click();
    } catch (err) {
      steps.push({
        label: 'click expand affordance',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return fail(
        'modal_to_edit_screen',
        `Click on expand affordance failed for modal ${input.modalId}.`,
        evidence,
        steps,
      );
    }

    // Wait briefly for navigation. We use `waitForLoadState` and a URL diff
    // instead of `waitForURL` so SPAs and full nav both work.
    await ctx.page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
    const afterUrl = ctx.page.url();
    evidence.afterUrl = afterUrl;
    const urlChanged = afterUrl !== beforeUrl;
    steps.push({ label: 'URL changed after click', ok: urlChanged });
    if (!urlChanged) {
      return suspicious(
        'modal_to_edit_screen',
        `Expand affordance for modal ${input.modalId} did not change URL.`,
        evidence,
        steps,
      );
    }

    // Heuristic: the new page's title (or primary heading) should contain the
    // entity name we captured in the modal.
    let titleMatches = true;
    if (entityName) {
      try {
        const fresh = await ctx.pageModel();
        const title = fresh.title || '';
        const heading = fresh.primaryHeading || '';
        evidence.newTitle = title;
        evidence.newHeading = heading;
        const needle = entityName.toLowerCase();
        titleMatches =
          title.toLowerCase().includes(needle) || heading.toLowerCase().includes(needle);
      } catch {
        titleMatches = true; // can't fetch model — don't penalise
      }
    }
    steps.push({
      label: 'new route references entity',
      ok: titleMatches,
      detail: entityName ? `looking for "${entityName}"` : 'no entity name available',
    });
    if (!titleMatches) {
      return suspicious(
        'modal_to_edit_screen',
        `URL changed but new route does not reference "${entityName}".`,
        evidence,
        steps,
      );
    }
    return ok(
      'modal_to_edit_screen',
      `Modal ${input.modalId} expanded to edit screen ${afterUrl}.`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// modal_nested
// --------------------------------------------------------------------------

interface NestedInputs {
  modalId: string;
  trigger?: string;
}

const nested: Playbook<NestedInputs> = {
  name: 'modal_nested',
  description:
    'Open the outer modal, then trigger an inner modal from inside it. Close the inner modal and assert the outer is still open. Status `suspicious` if closing the inner closes the outer (common bug); `ok` if the inner modal cannot be triggered (nothing to test).',
  categories: ['modal'],
  estimatedDurationMs: 7_000,
  inputShape: {
    modalId: z.string(),
    trigger: z.string().optional(),
  },
  async run(input, ctx) {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { modalId: input.modalId };
    const model = await ctx.pageModel();
    const modalSpec = findModalSpec(model, input.modalId);

    const outerOpen = await openModal(ctx.page, modalSpec, input.trigger);
    steps.push({ label: 'open outer modal', ok: outerOpen.opened });
    if (!outerOpen.opened) {
      return fail('modal_nested', `Could not open outer modal ${input.modalId}.`, evidence, steps);
    }
    const outer = locateModal(ctx.page, modalSpec);

    // Snapshot dialog count before triggering inner.
    const dialogsBefore = await ctx.page.locator(DIALOG_SELECTOR).count();
    evidence.dialogsBefore = dialogsBefore;

    // Find a candidate inner-modal trigger inside the outer dialog.
    const innerTriggerSel =
      '[aria-haspopup="dialog"], [data-modal-trigger], button:has-text("Add"), button:has-text("Pick"), button:has-text("Choose")';
    const innerTrigger = outer.locator(innerTriggerSel).first();
    if (!(await innerTrigger.isVisible({ timeout: 500 }).catch(() => false))) {
      steps.push({
        label: 'find inner-modal trigger',
        ok: true,
        detail: 'no inner-modal trigger found — nothing to nest',
      });
      return ok(
        'modal_nested',
        `Outer modal ${input.modalId} has no inner-modal trigger; nothing to test.`,
        evidence,
        steps,
      );
    }
    try {
      await innerTrigger.click();
    } catch (err) {
      steps.push({
        label: 'click inner-modal trigger',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return fail('modal_nested', 'Could not click inner-modal trigger.', evidence, steps);
    }

    // Wait until dialog count exceeds the snapshot.
    let dialogsAfter = dialogsBefore;
    const deadline = Date.now() + MODAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      dialogsAfter = await ctx.page.locator(DIALOG_SELECTOR).count();
      if (dialogsAfter > dialogsBefore) break;
      await ctx.page.waitForTimeout(50);
    }
    evidence.dialogsAfter = dialogsAfter;
    if (dialogsAfter <= dialogsBefore) {
      steps.push({
        label: 'inner modal opened',
        ok: false,
        detail: 'dialog count did not increase',
      });
      return ok(
        'modal_nested',
        `Trigger clicked but no inner modal appeared on ${input.modalId}.`,
        evidence,
        steps,
      );
    }
    steps.push({ label: 'inner modal opened', ok: true });

    // Close inner modal: prefer Escape (which most stacks tie to topmost dialog).
    await ctx.page.keyboard.press('Escape');
    const dl = Date.now() + MODAL_TIMEOUT_MS;
    let dialogsClosed = dialogsAfter;
    while (Date.now() < dl) {
      dialogsClosed = await ctx.page.locator(DIALOG_SELECTOR).count();
      if (dialogsClosed < dialogsAfter) break;
      await ctx.page.waitForTimeout(50);
    }
    evidence.dialogsAfterCloseInner = dialogsClosed;
    steps.push({
      label: 'close inner modal',
      ok: dialogsClosed === dialogsBefore,
      detail: `dialogs ${dialogsAfter} → ${dialogsClosed}`,
    });

    // Outer must still be open (i.e. count == dialogsBefore which was non-zero).
    const outerStillOpen = dialogsClosed >= dialogsBefore;
    if (!outerStillOpen || dialogsClosed === 0) {
      return suspicious(
        'modal_nested',
        `Closing inner modal also closed outer ${input.modalId}.`,
        evidence,
        steps,
      );
    }
    steps.push({ label: 'outer modal still open', ok: true });

    // Finally close the outer.
    await ctx.page.keyboard.press('Escape');
    await waitForDismissed(outer, MODAL_TIMEOUT_MS);

    return ok(
      'modal_nested',
      `Inner modal opened and closed independently of outer ${input.modalId}.`,
      evidence,
      steps,
    );
  },
};

// --------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------

export function registerModalPlaybooks(r: PlaybookRegistry): void {
  r.register(lifecycle);
  r.register(formInsideSave);
  r.register(cancelLosesData);
  r.register(toEditScreen);
  r.register(nested);
}

// Internal exports for tests.
export const __modalPlaybooks = {
  lifecycle,
  formInsideSave,
  cancelLosesData,
  toEditScreen,
  nested,
};

export type {
  CancelLosesDataInputs,
  FormInsideSaveInputs,
  LifecycleInputs,
  NestedInputs,
  ToEditScreenInputs,
};

// Re-export helpers used by tests for direct invocation.
export type ModalPlaybookCtx = PlaybookContext;
export type ModalPlaybookOutcome = PlaybookOutcome;
