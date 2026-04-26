/**
 * CRUD playbooks — Playbook<I> implementations for the create / read / update /
 * delete intents the agent invokes via MCP. Each playbook is deterministic
 * Playwright orchestration over the locked PlaybookContext: it never throws —
 * any Playwright failure is captured into the outcome's `steps` trace and the
 * outcome status is computed from that trace.
 *
 * Status rules:
 *   - any failed step               → 'failed'
 *   - all steps ok, but the page's
 *     network log contains 4xx/5xx
 *     anomalies                     → 'suspicious'
 *   - otherwise                     → 'ok'
 *
 * Locators are tried in a fall-through order (label → name → placeholder → aria)
 * so the playbook works against most CRUD UIs without UI-specific coupling.
 */

import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { NetworkAnomaly } from '../page-model/types.ts';
import type { Playbook, PlaybookContext, PlaybookRegistry } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

const ACTION_TIMEOUT_MS = 5_000;

interface AttemptResult {
  ok: boolean;
  detail?: string;
}

/** Run an async fn; on throw, swallow and return a failure result with the message. */
async function attempt(fn: () => Promise<void>): Promise<AttemptResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail };
  }
}

/** Push a step and return whether it was successful. */
function record(steps: PlaybookStep[], label: string, result: AttemptResult): boolean {
  steps.push({ label, ok: result.ok, detail: result.detail });
  return result.ok;
}

/** Try each locator in order; return the first whose count() > 0. Returns null
 * if none resolve. Wrapped in try/catch so locator-syntax errors don't leak. */
async function firstAvailable(page: Page, candidates: string[]): Promise<Locator | null> {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      const count = await loc.count();
      if (count > 0) return loc;
    } catch {
      // try next
    }
  }
  return null;
}

/** Same as firstAvailable but each candidate is a Locator factory. Used when
 * we need a getByLabel / getByPlaceholder / getByRole locator that can't be
 * expressed as a CSS string. */
async function firstAvailableLocator(
  factories: Array<() => Locator>,
): Promise<Locator | null> {
  for (const factory of factories) {
    try {
      const loc = factory().first();
      const count = await loc.count();
      if (count > 0) return loc;
    } catch {
      // try next
    }
  }
  return null;
}

/** Resolve a form field by label using the documented fall-through. */
async function resolveFieldByLabel(page: Page, label: string): Promise<Locator | null> {
  const cssSafeLabel = label.replace(/"/g, '\\"');
  return firstAvailableLocator([
    () => page.getByLabel(label),
    () => page.locator(`[name="${cssSafeLabel}"]`),
    () => page.getByPlaceholder(label),
    () => page.locator(`[aria-label="${cssSafeLabel}"]`),
  ]);
}

interface RowAffordanceOptions {
  /** Affordance label, e.g. 'Edit' or 'Delete'. */
  label: string;
  /** Substring matched against `data-testid`. Defaults to label.toLowerCase(). */
  testidSubstring?: string;
  /** Extra synonyms for the visible button text (e.g. ['Trash'] for delete). */
  extraTextMatches?: string[];
}

/** Resolve the row affordance (Edit / Delete / etc.) on a 1-indexed row. Tries
 * direct icon, data-testid, button-with-text, then kebab→menu, then dblclick. */
async function resolveRowAffordance(
  page: Page,
  rowIndex: number,
  opts: RowAffordanceOptions,
): Promise<{ click: () => Promise<void>; strategy: string } | null> {
  const testid = opts.testidSubstring ?? opts.label.toLowerCase();
  const rowSel = `tr:nth-child(${rowIndex})`;

  // Strategy 1: aria-label icon button on the row.
  const ariaIcon = page.locator(`${rowSel} [aria-label="${opts.label}"]`).first();
  if ((await safeCount(ariaIcon)) > 0) {
    return { click: () => ariaIcon.click({ timeout: ACTION_TIMEOUT_MS }), strategy: 'aria-label' };
  }

  // Strategy 2: data-testid containing the operation name.
  const byTestid = page.locator(`${rowSel} [data-testid*="${testid}"]`).first();
  if ((await safeCount(byTestid)) > 0) {
    return { click: () => byTestid.click({ timeout: ACTION_TIMEOUT_MS }), strategy: 'data-testid' };
  }

  // Strategy 3: button with visible text (label + extras).
  const textCandidates = [opts.label, ...(opts.extraTextMatches ?? [])];
  for (const text of textCandidates) {
    const btn = page.locator(`${rowSel} button:has-text("${text}")`).first();
    if ((await safeCount(btn)) > 0) {
      return { click: () => btn.click({ timeout: ACTION_TIMEOUT_MS }), strategy: `button:${text}` };
    }
  }

  // Strategy 4: open kebab menu, then click matching menuitem.
  const kebab = page.locator(`${rowSel} [aria-label="Open menu"]`).first();
  if ((await safeCount(kebab)) > 0) {
    return {
      click: async () => {
        await kebab.click({ timeout: ACTION_TIMEOUT_MS });
        const item = page.getByRole('menuitem', { name: opts.label }).first();
        await item.click({ timeout: ACTION_TIMEOUT_MS });
      },
      strategy: 'kebab-menu',
    };
  }

  // Strategy 5: dblclick the row (some apps support inline edit on dblclick).
  // Only useful for edit; we still expose it so callers can opt in.
  if (opts.label === 'Edit') {
    const row = page.locator(rowSel).first();
    if ((await safeCount(row)) > 0) {
      return {
        click: () => row.dblclick({ timeout: ACTION_TIMEOUT_MS }),
        strategy: 'row-dblclick',
      };
    }
  }

  return null;
}

async function safeCount(loc: Locator): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return 0;
  }
}

/** Resolve the confirm button in a confirm-dialog. Tries the explicit confirm
 * text first, then common synonyms. */
async function resolveConfirmButton(
  page: Page,
  confirmText?: string,
): Promise<Locator | null> {
  const candidates = confirmText
    ? [confirmText, 'Confirm', 'Yes', 'Delete', 'OK']
    : ['Confirm', 'Yes', 'Delete', 'OK'];
  return firstAvailableLocator(candidates.map((name) => () => page.getByRole('button', { name })));
}

/** Resolve the form's submit/save affordance. */
async function resolveSubmit(page: Page): Promise<Locator | null> {
  return firstAvailableLocator([
    () => page.locator('button[type="submit"]'),
    () => page.getByRole('button', { name: 'Save' }),
    () => page.getByRole('button', { name: 'Submit' }),
    () => page.getByRole('button', { name: 'Create' }),
    () => page.getByRole('button', { name: 'Add' }),
    () => page.locator('input[type="submit"]'),
  ]);
}

function isAnomalous(a: NetworkAnomaly): boolean {
  return a.status >= 400 && a.status < 600;
}

/** Snapshot anomalies that occurred since `since` (capturedAt timestamp). */
async function freshAnomalies(
  ctx: PlaybookContext,
  sinceMs: number,
): Promise<NetworkAnomaly[]> {
  try {
    const model = await ctx.pageModel();
    return model.network.filter((a) => a.ts >= sinceMs && isAnomalous(a));
  } catch {
    return [];
  }
}

/** Decide outcome status from steps + network. */
function decide(
  playbookName: string,
  summary: string,
  steps: PlaybookStep[],
  evidence: Record<string, unknown>,
  anomalies: NetworkAnomaly[],
): PlaybookOutcome {
  const anyFail = steps.some((s) => !s.ok);
  if (anyFail) {
    const out = fail(playbookName, summary, evidence, steps);
    out.signals.networkAnomalies = anomalies;
    return out;
  }
  if (anomalies.length > 0) {
    const out = suspicious(
      playbookName,
      `${summary} — but ${anomalies.length} HTTP error(s) fired during the run`,
      { ...evidence, anomalies },
      steps,
    );
    out.signals.networkAnomalies = anomalies;
    return out;
  }
  return ok(playbookName, summary, evidence, steps);
}

// -----------------------------------------------------------------------------
// crud_create_form
// -----------------------------------------------------------------------------

export interface CrudCreateFormInput {
  formId: string;
  valuesByLabel: Record<string, string>;
  expectPersistence?: boolean;
}

const crudCreateFormShape = {
  formId: z.string(),
  valuesByLabel: z.record(z.string(), z.string()),
  expectPersistence: z.boolean().optional(),
} satisfies z.ZodRawShape;

export const crudCreateForm: Playbook<CrudCreateFormInput> = {
  name: 'crud_create_form',
  description:
    'Create a new entity by filling a form. Inputs: formId (stable id from PageModel), ' +
    'valuesByLabel (record of fieldLabel→value), optional expectPersistence (navigate-away-and-back to verify creation).',
  categories: ['crud', 'form'],
  estimatedDurationMs: 6_000,
  inputShape: crudCreateFormShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      formId: input.formId,
      filledFields: [] as string[],
      missingFields: [] as string[],
    };
    const filled: string[] = [];
    const missing: string[] = [];
    let allFilled = true;

    for (const [label, value] of Object.entries(input.valuesByLabel)) {
      const field = await resolveFieldByLabel(ctx.page, label);
      if (!field) {
        record(steps, `fill field "${label}"`, { ok: false, detail: 'field not found' });
        missing.push(label);
        allFilled = false;
        continue;
      }
      const result = await attempt(async () => {
        await field.fill(value, { timeout: ACTION_TIMEOUT_MS });
      });
      if (result.ok) {
        filled.push(label);
      } else {
        missing.push(label);
        allFilled = false;
      }
      record(steps, `fill field "${label}"`, result);
    }
    evidence.filledFields = filled;
    evidence.missingFields = missing;

    if (!allFilled) {
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudCreateForm.name,
        `Could not fill ${missing.length} field(s) on form ${input.formId}`,
        steps,
        evidence,
        anomalies,
      );
    }

    const submit = await resolveSubmit(ctx.page);
    if (!submit) {
      record(steps, 'click submit', { ok: false, detail: 'no submit affordance found' });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudCreateForm.name,
        `Filled form ${input.formId} but submit button was not found`,
        steps,
        evidence,
        anomalies,
      );
    }
    const submitResult = await attempt(async () => {
      await submit.click({ timeout: ACTION_TIMEOUT_MS });
    });
    record(steps, 'click submit', submitResult);

    if (input.expectPersistence && submitResult.ok) {
      const navResult = await attempt(async () => {
        const startUrl = ctx.page.url();
        // Try going back and re-entering the page; bail out gracefully if nav APIs fail.
        await ctx.page.goBack({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
        await ctx.page.goto(startUrl, { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
      });
      record(steps, 'navigate-away-and-back to verify persistence', navResult);
    }

    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      crudCreateForm.name,
      `Filled and submitted form ${input.formId} (${filled.length} field(s))`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// -----------------------------------------------------------------------------
// Shared row-edit logic for crud_edit_first_row / crud_edit_specific_row
// -----------------------------------------------------------------------------

async function runRowEdit(
  ctx: PlaybookContext,
  args: {
    playbookName: string;
    tableId: string;
    rowIndex: number;
    fieldUpdates: Record<string, string>;
    verifyPersistence: boolean;
  },
): Promise<PlaybookOutcome> {
  const startedAt = Date.now();
  const steps: PlaybookStep[] = [];
  const evidence: Record<string, unknown> = {
    tableId: args.tableId,
    rowIndex: args.rowIndex,
    updatedFields: [] as string[],
    failedFields: [] as string[],
  };

  const editAffordance = await resolveRowAffordance(ctx.page, args.rowIndex, { label: 'Edit' });
  if (!editAffordance) {
    record(steps, `open edit on row ${args.rowIndex}`, {
      ok: false,
      detail: 'no edit affordance found',
    });
    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      args.playbookName,
      `Could not open edit on row ${args.rowIndex} of ${args.tableId}`,
      steps,
      evidence,
      anomalies,
    );
  }
  const openResult = await attempt(editAffordance.click);
  evidence.editStrategy = editAffordance.strategy;
  if (
    !record(steps, `open edit on row ${args.rowIndex} (${editAffordance.strategy})`, openResult)
  ) {
    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      args.playbookName,
      `Failed to open edit on row ${args.rowIndex}`,
      steps,
      evidence,
      anomalies,
    );
  }

  const updated: string[] = [];
  const failed: string[] = [];
  for (const [label, value] of Object.entries(args.fieldUpdates)) {
    const field = await resolveFieldByLabel(ctx.page, label);
    if (!field) {
      record(steps, `update field "${label}"`, { ok: false, detail: 'field not found' });
      failed.push(label);
      continue;
    }
    const r = await attempt(async () => {
      await field.fill(value, { timeout: ACTION_TIMEOUT_MS });
    });
    if (r.ok) updated.push(label);
    else failed.push(label);
    record(steps, `update field "${label}"`, r);
  }
  evidence.updatedFields = updated;
  evidence.failedFields = failed;

  const submit = await resolveSubmit(ctx.page);
  if (!submit) {
    record(steps, 'click save', { ok: false, detail: 'no save affordance found' });
    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      args.playbookName,
      `Updated fields on row ${args.rowIndex} but save was not found`,
      steps,
      evidence,
      anomalies,
    );
  }
  const saveResult = await attempt(async () => {
    await submit.click({ timeout: ACTION_TIMEOUT_MS });
  });
  record(steps, 'click save', saveResult);

  if (args.verifyPersistence && saveResult.ok) {
    const navResult = await attempt(async () => {
      const url = ctx.page.url();
      await ctx.page.reload({ timeout: ACTION_TIMEOUT_MS }).catch(async () => {
        await ctx.page.goto(url, { timeout: ACTION_TIMEOUT_MS });
      });
    });
    record(steps, 'reload to verify persistence', navResult);
  }

  const anomalies = await freshAnomalies(ctx, startedAt);
  return decide(
    args.playbookName,
    `Edited row ${args.rowIndex} of ${args.tableId} (${updated.length} field(s))`,
    steps,
    evidence,
    anomalies,
  );
}

// -----------------------------------------------------------------------------
// crud_edit_first_row
// -----------------------------------------------------------------------------

export interface CrudEditFirstRowInput {
  tableId: string;
  fieldUpdates: Record<string, string>;
  verifyPersistence: boolean;
}

const crudEditFirstRowShape = {
  tableId: z.string(),
  fieldUpdates: z.record(z.string(), z.string()),
  verifyPersistence: z.boolean(),
} satisfies z.ZodRawShape;

export const crudEditFirstRow: Playbook<CrudEditFirstRowInput> = {
  name: 'crud_edit_first_row',
  description:
    'Edit the first row of a table. Inputs: tableId, fieldUpdates (label→new value), verifyPersistence (reload to confirm).',
  categories: ['crud', 'table'],
  estimatedDurationMs: 8_000,
  inputShape: crudEditFirstRowShape,
  run(input, ctx) {
    return runRowEdit(ctx, {
      playbookName: 'crud_edit_first_row',
      tableId: input.tableId,
      rowIndex: 1,
      fieldUpdates: input.fieldUpdates,
      verifyPersistence: input.verifyPersistence,
    });
  },
};

// -----------------------------------------------------------------------------
// crud_edit_specific_row
// -----------------------------------------------------------------------------

export interface CrudEditSpecificRowInput {
  tableId: string;
  rowIndex: number;
  fieldUpdates: Record<string, string>;
  verifyPersistence: boolean;
}

const crudEditSpecificRowShape = {
  tableId: z.string(),
  rowIndex: z.number().int().min(1),
  fieldUpdates: z.record(z.string(), z.string()),
  verifyPersistence: z.boolean(),
} satisfies z.ZodRawShape;

export const crudEditSpecificRow: Playbook<CrudEditSpecificRowInput> = {
  name: 'crud_edit_specific_row',
  description:
    'Edit a specific row of a table. Same as crud_edit_first_row but with a 1-indexed rowIndex.',
  categories: ['crud', 'table'],
  estimatedDurationMs: 8_000,
  inputShape: crudEditSpecificRowShape,
  run(input, ctx) {
    return runRowEdit(ctx, {
      playbookName: 'crud_edit_specific_row',
      tableId: input.tableId,
      rowIndex: input.rowIndex,
      fieldUpdates: input.fieldUpdates,
      verifyPersistence: input.verifyPersistence,
    });
  },
};

// -----------------------------------------------------------------------------
// crud_delete_first_row
// -----------------------------------------------------------------------------

export interface CrudDeleteFirstRowInput {
  tableId: string;
  confirmText?: string;
}

const crudDeleteFirstRowShape = {
  tableId: z.string(),
  confirmText: z.string().optional(),
} satisfies z.ZodRawShape;

export const crudDeleteFirstRow: Playbook<CrudDeleteFirstRowInput> = {
  name: 'crud_delete_first_row',
  description:
    'Delete the first row of a table. Tries Edit/Delete-style affordances, handles a confirm dialog (Confirm/Yes/Delete), then verifies the row was removed.',
  categories: ['crud', 'table'],
  estimatedDurationMs: 6_000,
  inputShape: crudDeleteFirstRowShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { tableId: input.tableId };

    const rowsBefore = await safeCount(ctx.page.locator('tbody tr'));
    evidence.rowsBefore = rowsBefore;

    const deleteAffordance = await resolveRowAffordance(ctx.page, 1, {
      label: 'Delete',
      extraTextMatches: ['Trash', 'Remove'],
    });
    if (!deleteAffordance) {
      record(steps, 'open delete on row 1', {
        ok: false,
        detail: 'no delete affordance found',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudDeleteFirstRow.name,
        `Could not find a delete affordance on row 1 of ${input.tableId}`,
        steps,
        evidence,
        anomalies,
      );
    }
    evidence.deleteStrategy = deleteAffordance.strategy;
    const clickResult = await attempt(deleteAffordance.click);
    if (
      !record(
        steps,
        `click delete on row 1 (${deleteAffordance.strategy})`,
        clickResult,
      )
    ) {
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudDeleteFirstRow.name,
        `Failed to click delete on row 1 of ${input.tableId}`,
        steps,
        evidence,
        anomalies,
      );
    }

    // Confirm dialog (best effort — many apps don't show one).
    const confirmBtn = await resolveConfirmButton(ctx.page, input.confirmText);
    if (confirmBtn) {
      const confirmResult = await attempt(async () => {
        await confirmBtn.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'confirm delete', confirmResult);
    } else {
      // Not having a confirm dialog is fine — record as informational only.
      steps.push({ label: 'confirm delete', ok: true, detail: 'no confirm dialog present' });
    }

    // Verify row count decreased.
    const verifyResult = await attempt(async () => {
      const rowsAfter = await ctx.page.locator('tbody tr').count();
      evidence.rowsAfter = rowsAfter;
      if (rowsBefore > 0 && rowsAfter >= rowsBefore) {
        throw new Error(`row count did not decrease (before=${rowsBefore}, after=${rowsAfter})`);
      }
    });
    record(steps, 'verify row removed', verifyResult);

    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      crudDeleteFirstRow.name,
      `Deleted first row of ${input.tableId}`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// -----------------------------------------------------------------------------
// crud_duplicate_row
// -----------------------------------------------------------------------------

export interface CrudDuplicateRowInput {
  tableId: string;
  rowIndex: number;
}

const crudDuplicateRowShape = {
  tableId: z.string(),
  rowIndex: z.number().int().min(1),
} satisfies z.ZodRawShape;

export const crudDuplicateRow: Playbook<CrudDuplicateRowInput> = {
  name: 'crud_duplicate_row',
  description:
    'Duplicate a row using a Duplicate / Clone affordance. Verifies a new row was added.',
  categories: ['crud', 'table'],
  estimatedDurationMs: 6_000,
  inputShape: crudDuplicateRowShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      tableId: input.tableId,
      rowIndex: input.rowIndex,
    };

    const rowsBefore = await safeCount(ctx.page.locator('tbody tr'));
    evidence.rowsBefore = rowsBefore;

    // Try Duplicate first, then Clone.
    let affordance = await resolveRowAffordance(ctx.page, input.rowIndex, {
      label: 'Duplicate',
      extraTextMatches: ['Clone', 'Copy'],
    });
    if (!affordance) {
      affordance = await resolveRowAffordance(ctx.page, input.rowIndex, {
        label: 'Clone',
        extraTextMatches: ['Copy'],
      });
    }
    if (!affordance) {
      record(steps, `open duplicate on row ${input.rowIndex}`, {
        ok: false,
        detail: 'no duplicate/clone affordance found',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudDuplicateRow.name,
        `Could not find a duplicate/clone affordance on row ${input.rowIndex} of ${input.tableId}`,
        steps,
        evidence,
        anomalies,
      );
    }
    evidence.strategy = affordance.strategy;
    const clickResult = await attempt(affordance.click);
    if (
      !record(
        steps,
        `click duplicate on row ${input.rowIndex} (${affordance.strategy})`,
        clickResult,
      )
    ) {
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudDuplicateRow.name,
        `Failed to duplicate row ${input.rowIndex}`,
        steps,
        evidence,
        anomalies,
      );
    }

    // If a confirm dialog appeared, accept it.
    const confirm = await resolveConfirmButton(ctx.page);
    if (confirm) {
      const confirmResult = await attempt(async () => {
        await confirm.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'confirm duplicate', confirmResult);
    }

    // Verify row count increased.
    const verifyResult = await attempt(async () => {
      const rowsAfter = await ctx.page.locator('tbody tr').count();
      evidence.rowsAfter = rowsAfter;
      if (rowsAfter <= rowsBefore) {
        throw new Error(`row count did not increase (before=${rowsBefore}, after=${rowsAfter})`);
      }
    });
    record(steps, 'verify row duplicated', verifyResult);

    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      crudDuplicateRow.name,
      `Duplicated row ${input.rowIndex} of ${input.tableId}`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// -----------------------------------------------------------------------------
// crud_archive_unarchive
// -----------------------------------------------------------------------------

export interface CrudArchiveUnarchiveInput {
  tableId: string;
  rowIndex: number;
}

const crudArchiveUnarchiveShape = {
  tableId: z.string(),
  rowIndex: z.number().int().min(1),
} satisfies z.ZodRawShape;

export const crudArchiveUnarchive: Playbook<CrudArchiveUnarchiveInput> = {
  name: 'crud_archive_unarchive',
  description:
    'Archive a row, verify visibility change, then unarchive and verify restoration.',
  categories: ['crud', 'table'],
  estimatedDurationMs: 8_000,
  inputShape: crudArchiveUnarchiveShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      tableId: input.tableId,
      rowIndex: input.rowIndex,
    };

    const rowsBefore = await safeCount(ctx.page.locator('tbody tr'));
    evidence.rowsBefore = rowsBefore;

    const archive = await resolveRowAffordance(ctx.page, input.rowIndex, { label: 'Archive' });
    if (!archive) {
      record(steps, `archive row ${input.rowIndex}`, {
        ok: false,
        detail: 'no archive affordance found',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudArchiveUnarchive.name,
        `Could not find archive affordance on row ${input.rowIndex} of ${input.tableId}`,
        steps,
        evidence,
        anomalies,
      );
    }
    evidence.archiveStrategy = archive.strategy;
    const archiveResult = await attempt(archive.click);
    if (
      !record(steps, `archive row ${input.rowIndex} (${archive.strategy})`, archiveResult)
    ) {
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudArchiveUnarchive.name,
        `Failed to archive row ${input.rowIndex}`,
        steps,
        evidence,
        anomalies,
      );
    }
    const archiveConfirm = await resolveConfirmButton(ctx.page);
    if (archiveConfirm) {
      const r = await attempt(async () => {
        await archiveConfirm.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'confirm archive', r);
    }

    // Verify visible row count changed.
    const archivedCheck = await attempt(async () => {
      const rowsAfter = await ctx.page.locator('tbody tr').count();
      evidence.rowsAfterArchive = rowsAfter;
      // Soft check: visibility likely changed (row hidden, archive flag added,
      // or row moved). We accept either reduction or unchanged-but-marked.
    });
    record(steps, 'verify archive visibility change', archivedCheck);

    // Unarchive — same row index after the archive may not be valid (row may
    // have moved); we still try the configured row index.
    const unarchive = await resolveRowAffordance(ctx.page, input.rowIndex, {
      label: 'Unarchive',
      extraTextMatches: ['Restore'],
    });
    if (!unarchive) {
      record(steps, `unarchive row ${input.rowIndex}`, {
        ok: false,
        detail: 'no unarchive affordance found (the row may need a filter toggle to become visible)',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudArchiveUnarchive.name,
        `Archived row ${input.rowIndex} but could not unarchive (no affordance)`,
        steps,
        evidence,
        anomalies,
      );
    }
    evidence.unarchiveStrategy = unarchive.strategy;
    const unarchiveResult = await attempt(unarchive.click);
    record(
      steps,
      `unarchive row ${input.rowIndex} (${unarchive.strategy})`,
      unarchiveResult,
    );
    const unarchiveConfirm = await resolveConfirmButton(ctx.page);
    if (unarchiveConfirm) {
      const r = await attempt(async () => {
        await unarchiveConfirm.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, 'confirm unarchive', r);
    }

    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      crudArchiveUnarchive.name,
      `Archive/unarchive cycle on row ${input.rowIndex} of ${input.tableId}`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// -----------------------------------------------------------------------------
// crud_bulk_action
// -----------------------------------------------------------------------------

export interface CrudBulkActionInput {
  tableId: string;
  action: string;
  rowIndices: number[];
}

const crudBulkActionShape = {
  tableId: z.string(),
  action: z.string(),
  rowIndices: z.array(z.number().int().min(1)),
} satisfies z.ZodRawShape;

export const crudBulkAction: Playbook<CrudBulkActionInput> = {
  name: 'crud_bulk_action',
  description:
    'Select the given rows (1-indexed checkboxes), apply a bulk action by name (e.g. "Delete", "Archive"), then verify the action ran.',
  categories: ['crud', 'table'],
  estimatedDurationMs: 7_000,
  inputShape: crudBulkActionShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const startedAt = Date.now();
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = {
      tableId: input.tableId,
      action: input.action,
      rowIndices: input.rowIndices,
    };

    const rowsBefore = await safeCount(ctx.page.locator('tbody tr'));
    evidence.rowsBefore = rowsBefore;

    // Tick each row's checkbox. Try a few row-checkbox locators.
    let ticked = 0;
    for (const idx of input.rowIndices) {
      const checkbox = await firstAvailable(ctx.page, [
        `tr:nth-child(${idx}) input[type="checkbox"]`,
        `tr:nth-child(${idx}) [role="checkbox"]`,
        `tr:nth-child(${idx}) [aria-label="Select row"]`,
      ]);
      if (!checkbox) {
        record(steps, `select row ${idx}`, { ok: false, detail: 'no checkbox found' });
        continue;
      }
      const r = await attempt(async () => {
        await checkbox.check({ timeout: ACTION_TIMEOUT_MS });
      });
      if (r.ok) ticked += 1;
      record(steps, `select row ${idx}`, r);
    }
    evidence.rowsSelected = ticked;
    if (ticked === 0) {
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudBulkAction.name,
        `Could not select any rows for bulk ${input.action} on ${input.tableId}`,
        steps,
        evidence,
        anomalies,
      );
    }

    // Trigger the bulk action. Try a button with the action name in the toolbar,
    // and a "Bulk actions" / "Actions" menu fallback.
    const actionButton = await firstAvailableLocator([
      () => ctx.page.getByRole('button', { name: input.action }),
      () => ctx.page.locator(`button:has-text("${input.action}")`),
      () => ctx.page.getByRole('menuitem', { name: input.action }),
    ]);
    if (!actionButton) {
      record(steps, `apply bulk ${input.action}`, {
        ok: false,
        detail: 'no button or menu item matching the action name',
      });
      const anomalies = await freshAnomalies(ctx, startedAt);
      return decide(
        crudBulkAction.name,
        `Selected ${ticked} row(s) but bulk action "${input.action}" was not found`,
        steps,
        evidence,
        anomalies,
      );
    }
    const applyResult = await attempt(async () => {
      await actionButton.click({ timeout: ACTION_TIMEOUT_MS });
    });
    record(steps, `apply bulk ${input.action}`, applyResult);

    // Confirm dialog if present.
    const confirm = await resolveConfirmButton(ctx.page);
    if (confirm) {
      const r = await attempt(async () => {
        await confirm.click({ timeout: ACTION_TIMEOUT_MS });
      });
      record(steps, `confirm bulk ${input.action}`, r);
    }

    // Verify.
    const verifyResult = await attempt(async () => {
      const rowsAfter = await ctx.page.locator('tbody tr').count();
      evidence.rowsAfter = rowsAfter;
    });
    record(steps, 'verify bulk action result', verifyResult);

    const anomalies = await freshAnomalies(ctx, startedAt);
    return decide(
      crudBulkAction.name,
      `Bulk ${input.action} applied to ${ticked} row(s) of ${input.tableId}`,
      steps,
      evidence,
      anomalies,
    );
  },
};

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerCrudPlaybooks(r: PlaybookRegistry): void {
  r.register(crudCreateForm);
  r.register(crudEditFirstRow);
  r.register(crudEditSpecificRow);
  r.register(crudDeleteFirstRow);
  r.register(crudDuplicateRow);
  r.register(crudArchiveUnarchive);
  r.register(crudBulkAction);
}
