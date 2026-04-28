/**
 * Form playbook — `fill_and_verify`. Single playbook that fills a form and
 * asserts post-submit conditions. Replaces the previous forms.ts which held
 * 5+ overlapping playbooks (validation, persistence, dirty-state, etc.).
 *
 * The persona drives form-finding and value choice; this playbook handles the
 * mechanical fill+submit+verify loop.
 */

import type { Page } from 'playwright';
import { z } from 'zod';
import type { FormFieldSpec, FormSpec } from '../page-model/types.ts';
import type { Playbook } from './framework.ts';
import { fail, ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

const SUBMIT_TIMEOUT_MS = 5_000;
const TOAST_OBSERVE_WINDOW_MS = 1_500;

const verifyCheck = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url-changed') }),
  z.object({ kind: z.literal('url-matches'), pattern: z.string() }),
  z.object({ kind: z.literal('success-toast') }),
  z.object({ kind: z.literal('error-shown') }),
  z.object({ kind: z.literal('value-persisted'), field: z.string(), expect: z.string() }),
  z.object({ kind: z.literal('redirect-to'), pathContains: z.string() }),
]);

const fillAndVerifyShape = {
  formId: z.string(),
  values: z.record(z.string(), z.string()),
  submit: z.boolean().optional(),
  verify: z.array(verifyCheck).optional(),
} satisfies z.ZodRawShape;

export interface FillAndVerifyInput {
  formId: string;
  values: Record<string, string>;
  submit?: boolean;
  verify?: z.infer<typeof verifyCheck>[];
}

interface VerifyResult {
  kind: string;
  ok: boolean;
  detail?: string;
}

// FormFieldSpec has no `id` or `name` — match is by `label` only (case-insensitive).
function findField(form: FormSpec, key: string): FormFieldSpec | null {
  const lower = key.toLowerCase();
  return form.fields.find((f: FormFieldSpec) => f.label.toLowerCase() === lower) ?? null;
}

async function fillField(
  page: Page,
  form: FormSpec,
  key: string,
  value: string,
): Promise<{ ok: boolean; detail: string }> {
  const field = findField(form, key);
  if (!field) {
    return { ok: false, detail: `field '${key}' not found in form '${form.id}'` };
  }
  const locator = page.locator(field.locator).first();
  try {
    if (field.type === 'select') {
      await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
    } else if (field.type === 'checkbox' || field.type === 'radio') {
      const checked = ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
      if (checked) await locator.check({ force: true });
      else await locator.uncheck({ force: true });
    } else {
      await locator.fill(value);
    }
    return {
      ok: true,
      detail: `filled '${key}' = '${value.length > 40 ? `${value.slice(0, 40)}…` : value}'`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function detectSuccessToast(page: Page): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < TOAST_OBSERVE_WINDOW_MS) {
    const matches = await page
      .locator(
        '[role="status"], [role="alert"], .toast, .Toastify__toast, [data-testid*="toast" i], [class*="success" i]',
      )
      .count()
      .catch(() => 0);
    if (matches > 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function detectErrorShown(page: Page): Promise<boolean> {
  const matches = await page
    .locator(
      '[role="alert"], [aria-invalid="true"], .error, [class*="error" i], [data-testid*="error" i]',
    )
    .count()
    .catch(() => 0);
  return matches > 0;
}

async function runVerify(
  page: Page,
  form: FormSpec,
  check: z.infer<typeof verifyCheck>,
  urlBefore: string,
  urlAfter: string,
): Promise<VerifyResult> {
  switch (check.kind) {
    case 'url-changed':
      return {
        kind: check.kind,
        ok: urlBefore !== urlAfter,
        detail: `before=${urlBefore} after=${urlAfter}`,
      };
    case 'url-matches': {
      const re = (() => {
        try {
          return new RegExp(check.pattern);
        } catch {
          return null;
        }
      })();
      if (!re) return { kind: check.kind, ok: false, detail: `invalid regex: ${check.pattern}` };
      return {
        kind: check.kind,
        ok: re.test(urlAfter),
        detail: `pattern=${check.pattern} url=${urlAfter}`,
      };
    }
    case 'success-toast':
      return { kind: check.kind, ok: await detectSuccessToast(page) };
    case 'error-shown':
      return { kind: check.kind, ok: await detectErrorShown(page) };
    case 'value-persisted': {
      const field = findField(form, check.field);
      if (!field)
        return { kind: check.kind, ok: false, detail: `field '${check.field}' not found` };
      const actual = await page
        .locator(field.locator)
        .first()
        .inputValue()
        .catch(() => '');
      return {
        kind: check.kind,
        ok: actual === check.expect,
        detail: `expected='${check.expect}' actual='${actual}'`,
      };
    }
    case 'redirect-to': {
      const path = (() => {
        try {
          return new URL(urlAfter).pathname;
        } catch {
          return urlAfter;
        }
      })();
      return {
        kind: check.kind,
        ok: path.includes(check.pathContains),
        detail: `path=${path} contains=${check.pathContains}`,
      };
    }
  }
}

export const fillAndVerify: Playbook<FillAndVerifyInput> = {
  name: 'fill_and_verify',
  description:
    'Fill a form (looked up by `formId` from the latest snapshot) with a `values` map keyed by field label (case-insensitive), then assert post-submit conditions in `verify`. Status: `ok` if all checks pass, `suspicious` if any check fails, `failed` if the fill or submit threw. Set `submit: false` to fill without submitting (useful for validation probes).',
  categories: ['form'],
  estimatedDurationMs: 5_000,
  inputShape: fillAndVerifyShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { formId: input.formId };
    const verify = input.verify ?? [];
    const submit = input.submit !== false;

    const model = await ctx.pageModel();
    const form = model.forms.find((f) => f.id === input.formId);
    if (!form) {
      return fail(
        fillAndVerify.name,
        `form '${input.formId}' not found in current page model (${model.forms.length} form(s) on this page)`,
        evidence,
        steps,
      );
    }
    evidence.formLocator = form.formLocator;

    const filled: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.values)) {
      const r = await fillField(ctx.page, form, key, value);
      steps.push({ label: r.detail, ok: r.ok });
      if (r.ok) filled[key] = value;
    }
    evidence.valuesFilled = filled;

    if (!submit) {
      return ok(
        fillAndVerify.name,
        `Filled ${Object.keys(filled).length} field(s); submit suppressed.`,
        evidence,
        steps,
      );
    }

    const urlBefore = ctx.page.url();
    evidence.urlBefore = urlBefore;

    // ActionRef uses `.locator`; fall back to a generic selector scoped to the form.
    const submitSelector =
      form.submit?.locator ??
      `${form.formLocator} button[type="submit"], ${form.formLocator} input[type="submit"]`;
    try {
      await ctx.page.locator(submitSelector).first().click({ timeout: SUBMIT_TIMEOUT_MS });
      steps.push({ label: `submit click ('${submitSelector}')`, ok: true });
    } catch (err) {
      steps.push({
        label: 'submit click',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return fail(
        fillAndVerify.name,
        `submit failed: ${err instanceof Error ? err.message : String(err)}`,
        evidence,
        steps,
      );
    }

    await ctx.page.waitForLoadState('networkidle', { timeout: SUBMIT_TIMEOUT_MS }).catch(() => {
      steps.push({ label: 'wait for networkidle', ok: false, detail: 'timeout (continuing)' });
    });

    const urlAfter = ctx.page.url();
    evidence.urlAfter = urlAfter;

    const verifyResults: VerifyResult[] = [];
    for (const check of verify) {
      verifyResults.push(await runVerify(ctx.page, form, check, urlBefore, urlAfter));
    }
    evidence.verifyResults = verifyResults;

    const anyFailed = verifyResults.some((r) => !r.ok);
    if (verifyResults.length > 0 && anyFailed) {
      return suspicious(
        fillAndVerify.name,
        `Submitted; ${verifyResults.filter((r) => !r.ok).length}/${verifyResults.length} verify check(s) failed.`,
        evidence,
        steps,
      );
    }

    return ok(
      fillAndVerify.name,
      verifyResults.length === 0
        ? `Submitted '${input.formId}'; no verify checks supplied.`
        : `Submitted '${input.formId}'; all ${verifyResults.length} verify check(s) passed.`,
      evidence,
      steps,
    );
  },
};
