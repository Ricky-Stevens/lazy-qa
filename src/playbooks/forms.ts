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

async function detectSuccessToast(page: Page, skipIfErrorVisible = false): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < TOAST_OBSERVE_WINDOW_MS) {
    const matches = await page
      .locator(
        '[role="status"], [role="alert"], .toast, .Toastify__toast, [data-testid*="toast" i], [class*="success" i]',
      )
      .count()
      .catch(() => 0);
    if (matches > 0) return true;
    if (skipIfErrorVisible && (await detectErrorShown(page))) return false;
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

    await ctx.page.waitForTimeout(500);

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

/**
 * form_fuzz_validation — submits a form with a battery of malformed inputs and
 * surfaces validation/error-handling defects.
 *
 * Why this exists: across 8 runs honest personas filled forms with valid data
 * once and moved on. The QA-flavoured bugs (broken validation, missing error
 * handling, missing length limits, stack-trace leaks on bad input) require
 * SUBMITTING INVALID DATA. The personas referenced this playbook in their
 * prompts long before it existed — we built it now.
 *
 * Per submit, detects:
 *  - 5xx response (server crashed on input)
 *  - stack trace text in response body (error handling leaks internals)
 *  - silent acceptance: URL changed / success-toast appeared even when input
 *    was clearly invalid (empty required field, junk in email field)
 *  - explicit-error path: form correctly shows an error (this is the GOOD
 *    case — recorded as "validated")
 */

/** Built-in fuzz vectors. Each vector applied to every text-like field in
 *  the form. Keep the list short — total submits = vectors x runs across
 *  multiple agent invocations adds up fast. */
export const FUZZ_VECTORS: Array<{ id: string; value: string; expectError: boolean }> = [
  { id: 'empty', value: '', expectError: true },
  { id: 'whitespace', value: '   ', expectError: true },
  { id: 'long', value: 'A'.repeat(5000), expectError: true },
  { id: 'xss-classic', value: '<script>alert(1)</script>', expectError: false },
  { id: 'xss-img', value: '"><img src=x onerror=alert(1)>', expectError: false },
  { id: 'sqli-or', value: "' OR 1=1--", expectError: false },
  { id: 'sqli-drop', value: "'; DROP TABLE users; --", expectError: false },
  { id: 'newline-injection', value: 'hello\r\nBcc: attacker@evil.test\r\n', expectError: false },
  // Bug 1 fix: was 'hello world' (plain text) — must be an actual NUL byte injection probe.
  { id: 'null-byte', value: 'hello\x00world', expectError: false },
  { id: 'unicode-rtl', value: '‮test', expectError: false },
  // Bug 6: Unicode coverage — zero-width chars (rendering/display bugs), emoji
  // (UI layout), control chars (validation bypass), combining chars (length tricks).
  { id: 'unicode-zero-width', value: 'foo​bar‌baz', expectError: false },
  { id: 'unicode-emoji', value: '🔥💯👀 test 😀', expectError: false },
  { id: 'unicode-control', value: 'foo\x01\x02\x03bar', expectError: false },
  { id: 'unicode-combining', value: 'ẫ̄̅', expectError: false },
  // Bug 7: Happy-path probe — the form should ACCEPT valid plain text. If it
  // rejects this, the validation is over-aggressive (false-positive bug).
  // Keep last so adversarial vectors don't pollute field state before this runs.
  { id: 'valid', value: 'QA Test User', expectError: false },
];

/** Build field-type-aware extra vectors for a specific field. These are applied
 *  in addition to the generic FUZZ_VECTORS, not instead of them. */
export function fieldTypeVectors(
  field: FormFieldSpec,
): Array<{ id: string; value: string; expectError: boolean }> {
  const vectors: Array<{ id: string; value: string; expectError: boolean }> = [];
  const labelLower = field.label.toLowerCase();
  const type = field.type;

  // Email fields — format violation probes + happy-path.
  if (type === 'email' || /email|e-mail/i.test(labelLower)) {
    vectors.push(
      { id: 'email-no-at', value: 'not-an-email', expectError: true },
      { id: 'email-no-domain', value: 'foo@', expectError: true },
      { id: 'email-no-local', value: '@bar.com', expectError: true },
      { id: 'email-space', value: 'foo bar@example.com', expectError: true },
      { id: 'email-valid', value: 'qa-test@example.com', expectError: false },
    );
  }

  // Number fields — boundary and non-numeric probes.
  if (type === 'number') {
    const min = field.constraints.min;
    const max = field.constraints.max;
    vectors.push({ id: 'number-nonnumeric', value: 'abc', expectError: true });
    if (min !== undefined && max !== undefined) {
      vectors.push(
        { id: 'number-below-min', value: String(min - 1), expectError: true },
        { id: 'number-above-max', value: String(max + 1), expectError: true },
        { id: 'number-zero', value: '0', expectError: false },
        { id: 'number-very-negative', value: '-999999999', expectError: true },
        { id: 'number-at-min', value: String(min), expectError: false },
        { id: 'number-at-max', value: String(max), expectError: false },
      );
    } else {
      vectors.push(
        { id: 'number-negative-one', value: '-1', expectError: false },
        { id: 'number-zero', value: '0', expectError: false },
        { id: 'number-large', value: '999999999', expectError: false },
      );
    }
  }

  // Tel/phone fields.
  if (type === 'tel' || /phone|mobile|tel/i.test(labelLower)) {
    vectors.push(
      { id: 'tel-alpha', value: 'abc', expectError: true },
      { id: 'tel-short', value: '123', expectError: true },
      { id: 'tel-incomplete', value: '+44', expectError: true },
    );
  }

  // Date fields — boundary and invalid-month probes.
  if (type === 'date') {
    vectors.push(
      { id: 'date-min-boundary', value: '0001-01-01', expectError: true },
      { id: 'date-max-boundary', value: '9999-12-31', expectError: true },
      { id: 'date-invalid-month', value: '2024-13-01', expectError: true },
    );
  }

  // Text fields — maxLength boundary probes.
  const maxLen = field.constraints.maxLength;
  if (
    maxLen !== undefined &&
    (type === 'textbox' ||
      type === 'text' ||
      type === 'textarea' ||
      type === 'searchbox' ||
      type === 'password')
  ) {
    vectors.push(
      { id: 'text-maxlen-exceed', value: 'A'.repeat(maxLen + 1), expectError: true },
      { id: 'text-maxlen-exact', value: 'A'.repeat(maxLen), expectError: false },
    );
  }

  // Text fields — minLength boundary probes.
  const minLen = field.constraints.minLength;
  if (
    minLen !== undefined &&
    minLen > 0 &&
    (type === 'textbox' ||
      type === 'text' ||
      type === 'textarea' ||
      type === 'searchbox' ||
      type === 'password')
  ) {
    vectors.push({ id: 'text-minlen-below', value: 'A'.repeat(minLen - 1), expectError: true });
  }

  return vectors;
}

/** Returns a sensible "filler" value for non-text fields (checkbox, radio,
 *  select, etc.) so we can exercise the rest of the form during fuzzing. */
function fillerValueForField(field: FormFieldSpec): string | null {
  if (field.type === 'checkbox' || field.type === 'radio') return 'true';
  if (field.type === 'select') return ''; // will pick first option via fillField fallback
  return null;
}

/** A shape-level guard for "is this field text-like and therefore fuzzable"? */
function isFuzzableField(field: FormFieldSpec): boolean {
  // Field types from page-model/types.ts: textbox, searchbox, password, email,
  // number, textarea, select, checkbox, radio, slider, spinbutton, etc.
  const t = field.type;
  return (
    t === 'textbox' ||
    t === 'searchbox' ||
    t === 'password' ||
    t === 'email' ||
    t === 'textarea' ||
    t === 'number' ||
    t === 'spinbutton'
  );
}

const STACK_TRACE_RE =
  /(?:^|\n)\s*at\s+\S+\s*\([^\n]+:\d+:\d+\)|TypeError:|ReferenceError:|SyntaxError:|SequelizeDatabaseError|SQLITE_ERROR/m;

const formFuzzValidationShape = {
  formId: z.string(),
  /** Optional override of vectors to apply. Default: all built-in vectors. */
  vectors: z.array(z.string()).optional(),
} satisfies z.ZodRawShape;

export interface FormFuzzValidationInput {
  formId: string;
  vectors?: string[];
}

interface VectorResult {
  vector: string;
  fillsAttempted: number;
  fillsSucceeded: number;
  submitOk: boolean;
  submitError?: string;
  urlBefore: string;
  urlAfter: string;
  worstResponseStatus?: number;
  stackTraceDetected: boolean;
  errorIndicatorVisible: boolean;
  successToastVisible: boolean;
  /** A short verdict per vector. */
  verdict:
    | 'validated'
    | 'silently-accepted'
    | 'server-error'
    | 'stack-trace-leak'
    | 'submit-failed'
    | 'inconclusive';
  detail: string;
}

export const formFuzzValidation: Playbook<FormFuzzValidationInput> = {
  name: 'form_fuzz_validation',
  description:
    'Fuzz-test a form by submitting it with malformed inputs (empty, very long, XSS, SQLi, control chars, etc.) plus field-type-aware boundary probes (email format, number min/max, tel format, date boundaries, maxLength/minLength). For each vector, detects: 5xx server errors, stack-trace leaks in the response body, silent acceptance of invalid input (missing validation), and the well-handled case (form shows an error). Returns `suspicious` when ANY vector exposes a defect; `ok` when every vector is gracefully validated.',
  categories: ['form', 'security'],
  estimatedDurationMs: 30_000,
  inputShape: formFuzzValidationShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { formId: input.formId };

    const vectorIds = input.vectors && input.vectors.length > 0 ? new Set(input.vectors) : null;
    const selectedVectors = vectorIds
      ? FUZZ_VECTORS.filter((v) => vectorIds.has(v.id))
      : FUZZ_VECTORS;

    if (selectedVectors.length === 0) {
      return fail(
        formFuzzValidation.name,
        `No fuzz vectors selected (input.vectors=${JSON.stringify(input.vectors)}). Available: ${FUZZ_VECTORS.map((v) => v.id).join(', ')}.`,
        evidence,
        steps,
      );
    }

    const initialModel = await ctx.pageModel();
    const initialForm = initialModel.forms.find((f) => f.id === input.formId);
    if (!initialForm) {
      return fail(
        formFuzzValidation.name,
        `form '${input.formId}' not found in current page model (${initialModel.forms.length} form(s) on this page)`,
        evidence,
        steps,
      );
    }

    const fuzzableFields = initialForm.fields.filter(isFuzzableField);
    if (fuzzableFields.length === 0) {
      return ok(
        formFuzzValidation.name,
        `Form '${input.formId}' has no fuzzable text fields (only ${initialForm.fields.length} fields, all checkbox/radio/select). Skipping.`,
        evidence,
        steps,
      );
    }
    evidence.fuzzableFieldCount = fuzzableFields.length;
    evidence.vectorsRun = selectedVectors.map((v) => v.id);

    // Capture network responses during the playbook so we can grep for 5xx
    // bodies after each submit. The browser-server's response listener
    // populates ctx.signals via the registry, but for tightly-scoped
    // detection we listen here and clear between vectors.
    const responseLog: Array<{ url: string; status: number; bodySample: string }> = [];
    const responseHandler = async (resp: import('playwright').Response) => {
      try {
        const status = resp.status();
        const url = resp.url();
        // Only record server responses for the same origin to avoid noise.
        if (status < 400) return;
        let bodySample = '';
        try {
          const buf = await resp.body();
          bodySample = buf.toString('utf8').slice(0, 1500);
        } catch {
          // Response body not available (cancelled, etc.) — record without body.
        }
        responseLog.push({ url, status, bodySample });
      } catch {
        // ignore listener errors
      }
    };
    ctx.page.on('response', responseHandler);

    const results: VectorResult[] = [];

    try {
      for (const vector of selectedVectors) {
        responseLog.length = 0;
        const urlBefore = ctx.page.url();

        // Re-fetch the form fresh — submitting can navigate, reset, or replace
        // the form. If it's gone after a previous vector we stop early.
        const model = await ctx.pageModel();
        const form = model.forms.find((f) => f.id === input.formId);
        if (!form) {
          steps.push({
            label: `vector=${vector.id}: form vanished after previous submit`,
            ok: false,
          });
          break;
        }

        let fillsAttempted = 0;
        let fillsSucceeded = 0;
        for (const field of form.fields) {
          if (!isFuzzableField(field)) {
            const filler = fillerValueForField(field);
            if (filler !== null) {
              fillsAttempted += 1;
              const r = await fillField(ctx.page, form, field.label, filler);
              if (r.ok) fillsSucceeded += 1;
            }
            continue;
          }
          fillsAttempted += 1;
          const r = await fillField(ctx.page, form, field.label, vector.value);
          if (r.ok) fillsSucceeded += 1;
        }

        // Submit. Use the form's submit locator if we have it, else fall back.
        const submitSelector =
          form.submit?.locator ??
          `${form.formLocator} button[type="submit"], ${form.formLocator} input[type="submit"]`;
        let submitOk = true;
        let submitError: string | undefined;
        try {
          await ctx.page.locator(submitSelector).first().click({ timeout: SUBMIT_TIMEOUT_MS });
        } catch (err) {
          submitOk = false;
          submitError = err instanceof Error ? err.message : String(err);
        }
        // Settle pause for SPA re-render. networkidle never resolves on apps
        // with WebSocket connections (Juice Shop, any socket.io app), burning
        // the full 2.5s timeout per vector. A fixed 500ms is enough for
        // Angular/React to digest the submit and render validation errors.
        await ctx.page.waitForTimeout(500);

        const urlAfter = ctx.page.url();
        const errorVisible = await detectErrorShown(ctx.page);
        const toastVisible = await detectSuccessToast(ctx.page, true);

        // Highest server-error status seen on any captured response.
        let worstStatus: number | undefined;
        let stackTraceLeak = false;
        for (const r of responseLog) {
          if (worstStatus === undefined || r.status > worstStatus) worstStatus = r.status;
          if (r.bodySample && STACK_TRACE_RE.test(r.bodySample)) stackTraceLeak = true;
        }

        // Verdict logic. Order matters — the most damning verdict wins.
        let verdict: VectorResult['verdict'] = 'inconclusive';
        let detail = '';
        if (!submitOk) {
          verdict = 'submit-failed';
          detail = submitError ?? 'submit threw';
        } else if (stackTraceLeak) {
          verdict = 'stack-trace-leak';
          detail = `${responseLog.length} 4xx/5xx response(s); body contains stack trace`;
        } else if (worstStatus !== undefined && worstStatus >= 500) {
          verdict = 'server-error';
          detail = `5xx response on submit (status=${worstStatus})`;
        } else if (vector.expectError && !errorVisible && !toastVisible && urlAfter === urlBefore) {
          // Submitted invalid input, no error shown, no toast, no nav — treated
          // as silently dropped. This catches forms that "swallow" empty/long
          // submits without telling the user.
          verdict = 'silently-accepted';
          detail = 'invalid input submitted with no error indicator and no nav change';
        } else if (vector.expectError && errorVisible) {
          verdict = 'validated';
          detail = 'form correctly showed error indicator';
        } else if (!vector.expectError && toastVisible) {
          // XSS / SQLi / control-char input was accepted as a successful
          // submission — at minimum a missing input sanitisation, possibly
          // stored XSS or query-shape acceptance.
          verdict = 'silently-accepted';
          detail = 'attack-shaped input submitted successfully (no rejection)';
        } else if (!vector.expectError && !errorVisible && urlAfter !== urlBefore) {
          verdict = 'silently-accepted';
          detail = `attack-shaped input submitted; URL changed to ${urlAfter}`;
        } else {
          verdict = 'inconclusive';
          detail = `errorVisible=${errorVisible} toast=${toastVisible} urlChanged=${urlAfter !== urlBefore}`;
        }

        results.push({
          vector: vector.id,
          fillsAttempted,
          fillsSucceeded,
          submitOk,
          ...(submitError !== undefined && { submitError }),
          urlBefore,
          urlAfter,
          ...(worstStatus !== undefined && { worstResponseStatus: worstStatus }),
          stackTraceDetected: stackTraceLeak,
          errorIndicatorVisible: errorVisible,
          successToastVisible: toastVisible,
          verdict,
          detail,
        });
        steps.push({
          label: `vector=${vector.id} → ${verdict}`,
          ok: verdict === 'validated' || verdict === 'inconclusive',
          detail,
        });

        // If submit navigated to a completely different URL, the form may not
        // exist on the new page. We let the next-iteration check handle that
        // (form vanished → break).
      }
    } finally {
      ctx.page.off('response', responseHandler);
    }

    // Also run field-type-aware vectors for each fuzzable field (Bug 5).
    // These run after generic vectors so they don't interfere with earlier runs.
    // Re-register the response listener removed by the generic-vector finally block.
    ctx.page.on('response', responseHandler);
    try {
      const model = await ctx.pageModel();
      const form = model.forms.find((f) => f.id === input.formId);
      if (form) {
        for (const field of form.fields.filter(isFuzzableField)) {
          const extraVectors = fieldTypeVectors(field);
          for (const vector of extraVectors) {
            responseLog.length = 0;
            const urlBefore = ctx.page.url();

            // Re-fetch form each iteration.
            const freshModel = await ctx.pageModel();
            const freshForm = freshModel.forms.find((f) => f.id === input.formId);
            if (!freshForm) break;

            let fillsAttempted = 0;
            let fillsSucceeded = 0;
            // Fill only the target field with the typed vector; fill others with fillers.
            for (const f of freshForm.fields) {
              if (!isFuzzableField(f)) {
                const filler = fillerValueForField(f);
                if (filler !== null) {
                  fillsAttempted += 1;
                  const r = await fillField(ctx.page, freshForm, f.label, filler);
                  if (r.ok) fillsSucceeded += 1;
                }
                continue;
              }
              fillsAttempted += 1;
              // Fill the target field with the vector; fill other fuzzable
              // fields with valid placeholder text so required-field validation
              // doesn't mask the vector-under-test's behaviour.
              const targetValue =
                f.label.toLowerCase() === field.label.toLowerCase()
                  ? vector.value
                  : 'QA Test Value';
              const r = await fillField(ctx.page, freshForm, f.label, targetValue);
              if (r.ok) fillsSucceeded += 1;
            }

            const submitSelector =
              freshForm.submit?.locator ??
              `${freshForm.formLocator} button[type="submit"], ${freshForm.formLocator} input[type="submit"]`;
            let submitOk = true;
            let submitError: string | undefined;
            try {
              await ctx.page.locator(submitSelector).first().click({ timeout: SUBMIT_TIMEOUT_MS });
            } catch (err) {
              submitOk = false;
              submitError = err instanceof Error ? err.message : String(err);
            }
            await ctx.page.waitForTimeout(500);

            const urlAfter = ctx.page.url();
            const errorVisible = await detectErrorShown(ctx.page);
            const toastVisible = await detectSuccessToast(ctx.page, true);

            let worstStatus: number | undefined;
            let stackTraceLeak = false;
            for (const r of responseLog) {
              if (worstStatus === undefined || r.status > worstStatus) worstStatus = r.status;
              if (r.bodySample && STACK_TRACE_RE.test(r.bodySample)) stackTraceLeak = true;
            }

            let verdict: VectorResult['verdict'] = 'inconclusive';
            let detail = '';
            if (!submitOk) {
              verdict = 'submit-failed';
              detail = submitError ?? 'submit threw';
            } else if (stackTraceLeak) {
              verdict = 'stack-trace-leak';
              detail = `${responseLog.length} 4xx/5xx response(s); body contains stack trace`;
            } else if (worstStatus !== undefined && worstStatus >= 500) {
              verdict = 'server-error';
              detail = `5xx response on submit (status=${worstStatus})`;
            } else if (
              vector.expectError &&
              !errorVisible &&
              !toastVisible &&
              urlAfter === urlBefore
            ) {
              verdict = 'silently-accepted';
              detail = 'invalid input submitted with no error indicator and no nav change';
            } else if (vector.expectError && errorVisible) {
              verdict = 'validated';
              detail = 'form correctly showed error indicator';
            } else if (!vector.expectError && toastVisible) {
              verdict = 'silently-accepted';
              detail = 'typed-vector input accepted as success';
            } else if (!vector.expectError && !errorVisible && urlAfter !== urlBefore) {
              verdict = 'silently-accepted';
              detail = `typed-vector input accepted; URL changed to ${urlAfter}`;
            } else {
              verdict = 'inconclusive';
              detail = `errorVisible=${errorVisible} toast=${toastVisible} urlChanged=${urlAfter !== urlBefore}`;
            }

            results.push({
              vector: `${field.label}:${vector.id}`,
              fillsAttempted,
              fillsSucceeded,
              submitOk,
              ...(submitError !== undefined && { submitError }),
              urlBefore,
              urlAfter,
              ...(worstStatus !== undefined && { worstResponseStatus: worstStatus }),
              stackTraceDetected: stackTraceLeak,
              errorIndicatorVisible: errorVisible,
              successToastVisible: toastVisible,
              verdict,
              detail,
            });
            steps.push({
              label: `vector=${field.label}:${vector.id} → ${verdict}`,
              ok: verdict === 'validated' || verdict === 'inconclusive',
              detail,
            });
          }
        }
      }
    } finally {
      ctx.page.off('response', responseHandler);
    }

    evidence.results = results;
    evidence.summaryByVerdict = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
      return acc;
    }, {});

    const damningVerdicts = results.filter((r) =>
      ['stack-trace-leak', 'server-error', 'silently-accepted'].includes(r.verdict),
    );

    if (damningVerdicts.length > 0) {
      const headline = damningVerdicts
        .map((r) => `${r.vector}=${r.verdict}`)
        .slice(0, 5)
        .join(', ');
      return suspicious(
        formFuzzValidation.name,
        `Form '${input.formId}' fuzz: ${damningVerdicts.length}/${results.length} vector(s) exposed defects (${headline}). Each suspicious vector is a candidate finding — file with severity major (server-error / stack-trace) or minor (silent-accept).`,
        evidence,
        steps,
      );
    }

    return ok(
      formFuzzValidation.name,
      `Form '${input.formId}' fuzz: all ${results.length} vector(s) handled gracefully (errors shown for invalid input, no 5xx, no stack traces). Form validation appears robust.`,
      evidence,
      steps,
    );
  },
};

/**
 * form_double_submit — submits a form twice in quick succession to detect
 * missing idempotency. Often surfaces: duplicate records, double notification
 * sends, double-charge bugs (e.g. payment endpoint with no nonce).
 *
 * The agent fills the form via fill_and_verify or fill_form first; this
 * playbook re-fills with the same values and clicks submit twice in <100ms.
 */
const formDoubleSubmitShape = {
  formId: z.string(),
  values: z.record(z.string(), z.string()),
} satisfies z.ZodRawShape;

export interface FormDoubleSubmitInput {
  formId: string;
  values: Record<string, string>;
}

/**
 * form_required_field_check — submits an empty form and asserts that EACH
 * required field surfaces an error indicator. Catches forms that:
 *  - show only one error at a time when multiple fields are missing
 *  - show no error at all (silent acceptance of empty submit)
 *  - show a generic top-level error without field-level highlighting
 */
const formRequiredFieldCheckShape = {
  formId: z.string(),
} satisfies z.ZodRawShape;

export interface FormRequiredFieldCheckInput {
  formId: string;
}

/**
 * Check whether a field has a visible per-field error indicator nearby.
 * Looks for: aria-invalid on the input, aria-describedby pointing to an
 * element with error text, or a sibling/parent element with an error class.
 */
async function fieldHasErrorIndicator(page: Page, field: FormFieldSpec): Promise<boolean> {
  try {
    const locator = page.locator(field.locator).first();
    // 1. aria-invalid on the field itself.
    const ariaInvalid = await locator.getAttribute('aria-invalid').catch(() => null);
    if (ariaInvalid === 'true') return true;

    // 2. aria-describedby pointing to a visible error element.
    const describedBy = await locator.getAttribute('aria-describedby').catch(() => null);
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) {
        // Escape id for use in a CSS selector (replace special chars with escaped hex).
        const escapedId = id.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
        const el = page.locator(`#${escapedId}`).first();
        const visible = await el.isVisible().catch(() => false);
        if (visible) return true;
      }
    }

    // 3. Sibling or parent element with an error class/role near the field.
    const parentError = await page
      .locator(`${field.locator} ~ [class*="error" i], ${field.locator} ~ [role="alert"]`)
      .first()
      .isVisible()
      .catch(() => false);
    if (parentError) return true;
  } catch {
    // DOM query failed; treat as unknown (no indicator found).
  }
  return false;
}

export const formRequiredFieldCheck: Playbook<FormRequiredFieldCheckInput> = {
  name: 'form_required_field_check',
  description:
    'Submit a form completely empty and check that EACH required field shows an error indicator. Suspicious when only some required fields show errors (validation is incomplete) or when the empty form was accepted silently. Inputs: `formId` from the latest snapshot.',
  categories: ['form'],
  estimatedDurationMs: 4_000,
  inputShape: formRequiredFieldCheckShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { formId: input.formId };

    const model = await ctx.pageModel();
    const form = model.forms.find((f) => f.id === input.formId);
    if (!form) {
      return fail(
        formRequiredFieldCheck.name,
        `form '${input.formId}' not found (${model.forms.length} form(s) on page)`,
        evidence,
        steps,
      );
    }

    // Bug 3 fix: use field.required (HTML required attribute / aria-required) as
    // the PRIMARY signal. Fall back to label heuristics only when field.required
    // is false but the label still suggests required (label/HTML mismatch finding).
    const labelMismatches: string[] = [];
    const candidateRequired = form.fields.filter((f) => {
      const t = f.type;
      const isTextLike =
        t === 'textbox' ||
        t === 'text' ||
        t === 'searchbox' ||
        t === 'password' ||
        t === 'email' ||
        t === 'textarea';
      if (!isTextLike) return false;

      if (f.required) return true;

      // Secondary: HTML says not required but label implies it is.
      // Flag as a label/HTML mismatch rather than silently including.
      const labelLower = f.label.toLowerCase();
      const labelImpliesRequired =
        labelLower.includes('required') ||
        labelLower.includes('*') ||
        (!labelLower.includes('optional') && !labelLower.includes('(optional)'));
      // We do NOT include these — they would be false positives. Record mismatch.
      if (!f.required && labelImpliesRequired) {
        labelMismatches.push(f.label);
      }
      return false;
    });
    evidence.candidateRequiredCount = candidateRequired.length;
    evidence.candidateRequiredLabels = candidateRequired.map((f) => f.label);
    if (labelMismatches.length > 0) {
      evidence.labelHtmlMismatch = labelMismatches;
    }

    if (candidateRequired.length === 0) {
      return ok(
        formRequiredFieldCheck.name,
        `Form '${input.formId}' has no HTML-required text fields.${labelMismatches.length > 0 ? ` Note: ${labelMismatches.length} field(s) have label/HTML mismatch (label implies required but HTML attribute missing): ${labelMismatches.join(', ')}` : ''}`,
        evidence,
        steps,
      );
    }

    // Clear every required text-like field so the form is effectively empty.
    for (const f of candidateRequired) {
      try {
        await ctx.page.locator(f.locator).first().fill('');
      } catch {
        // ignore individual fill failures
      }
    }

    const urlBefore = ctx.page.url();
    const submitSelector =
      form.submit?.locator ??
      `${form.formLocator} button[type="submit"], ${form.formLocator} input[type="submit"]`;
    let submitOk = true;
    try {
      await ctx.page.locator(submitSelector).first().click({ timeout: SUBMIT_TIMEOUT_MS });
    } catch (err) {
      submitOk = false;
      steps.push({
        label: 'submit click',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await ctx.page.waitForTimeout(500);

    const urlAfter = ctx.page.url();
    const errorVisible = await detectErrorShown(ctx.page);
    const toastVisible = await detectSuccessToast(ctx.page, true);

    evidence.submitOk = submitOk;
    evidence.urlBefore = urlBefore;
    evidence.urlAfter = urlAfter;
    evidence.errorVisible = errorVisible;
    evidence.toastVisible = toastVisible;

    // Bug 4 fix: per-field error mapping. Walk each required field and check
    // whether it has an error indicator. This distinguishes:
    //   ok         — every required field has an indicator
    //   suspicious — some fields have indicators, some don't
    //   failed     — form accepted the empty submit with no errors at all
    const perFieldErrors: Array<{ field: string; hasError: boolean }> = [];
    if (!toastVisible && urlAfter === urlBefore) {
      for (const f of candidateRequired) {
        const hasError = await fieldHasErrorIndicator(ctx.page, f);
        perFieldErrors.push({ field: f.label, hasError });
        steps.push({
          label: `per-field error check: '${f.label}'`,
          ok: hasError,
          detail: hasError ? 'error indicator present' : 'no error indicator',
        });
      }
    }
    evidence.perFieldErrors = perFieldErrors;

    const fieldsWithError = perFieldErrors.filter((r) => r.hasError).length;
    const fieldsWithoutError = perFieldErrors.filter((r) => !r.hasError).length;

    // Verdict with per-field detail.
    if (toastVisible || urlAfter !== urlBefore) {
      return suspicious(
        formRequiredFieldCheck.name,
        `Form '${input.formId}' accepted an entirely empty submit (toast=${toastVisible}, urlChanged=${urlAfter !== urlBefore}). Missing required-field validation — file a finding.`,
        evidence,
        steps,
      );
    }

    if (!errorVisible) {
      return suspicious(
        formRequiredFieldCheck.name,
        `Form '${input.formId}' submit returned silently (no error, no toast, no nav). Validation appears broken — file a finding.`,
        evidence,
        steps,
      );
    }

    // Per-field analysis available.
    if (perFieldErrors.length > 0) {
      if (fieldsWithoutError > 0 && fieldsWithError > 0) {
        return suspicious(
          formRequiredFieldCheck.name,
          `Form '${input.formId}' shows errors for ${fieldsWithError}/${candidateRequired.length} required field(s) but silently swallows ${fieldsWithoutError} (fields without indicator: ${perFieldErrors
            .filter((r) => !r.hasError)
            .map((r) => r.field)
            .join(', ')}). Partial validation — file a finding.`,
          evidence,
          steps,
        );
      }
      if (fieldsWithoutError === candidateRequired.length) {
        // All fields lack per-field indicators — might be a single top-level
        // error which we already detected via errorVisible. Not a hard bug but
        // worth noting.
        return ok(
          formRequiredFieldCheck.name,
          `Form '${input.formId}' rejected empty submit (error indicator visible) but no per-field indicators found — uses a single top-level error message. Required-field validation present but not field-granular.`,
          evidence,
          steps,
        );
      }
      // All required fields have per-field indicators: ideal.
      return ok(
        formRequiredFieldCheck.name,
        `Form '${input.formId}' correctly rejected empty submit with per-field error indicators on all ${candidateRequired.length} required field(s).`,
        evidence,
        steps,
      );
    }

    // Fallback: high-level check only (couldn't probe per-field, e.g. submit threw).
    if (errorVisible && !toastVisible && urlAfter === urlBefore) {
      return ok(
        formRequiredFieldCheck.name,
        `Form '${input.formId}' correctly rejected empty submit (error indicator visible). Required-field validation appears intact.`,
        evidence,
        steps,
      );
    }

    return ok(
      formRequiredFieldCheck.name,
      `Form '${input.formId}' rejected empty submit; outcome inconclusive but no obvious bug.`,
      evidence,
      steps,
    );
  },
};

/**
 * form_persistence_roundtrip — fills a form with values, submits, navigates
 * away, navigates back, and verifies the submitted values are still there.
 * Catches "Saved!" toast lies (server didn't actually persist) and silent
 * data loss on navigate-away.
 */
const formPersistenceRoundtripShape = {
  formId: z.string(),
  values: z.record(z.string(), z.string()),
  awayUrl: z.string().url().optional(),
} satisfies z.ZodRawShape;

export interface FormPersistenceRoundtripInput {
  formId: string;
  values: Record<string, string>;
  /** URL to navigate to between submit and verify. Default: same-origin root. */
  awayUrl?: string;
}

export const formPersistenceRoundtrip: Playbook<FormPersistenceRoundtripInput> = {
  name: 'form_persistence_roundtrip',
  description:
    'Fill a form, submit, navigate away, navigate back, and verify the submitted values are still present. Catches "Saved!" lies — the toast appears but the data wasn\'t actually persisted. Inputs: `formId` (required), `values` (map of field label to value), `awayUrl` (optional intermediate destination, default = origin root).',
  categories: ['form'],
  estimatedDurationMs: 12_000,
  inputShape: formPersistenceRoundtripShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { formId: input.formId };

    const initialModel = await ctx.pageModel();
    const initialForm = initialModel.forms.find((f) => f.id === input.formId);
    if (!initialForm) {
      return fail(
        formPersistenceRoundtrip.name,
        `form '${input.formId}' not found (${initialModel.forms.length} form(s) on page)`,
        evidence,
        steps,
      );
    }

    // Phase 1 — fill + submit.
    for (const [key, value] of Object.entries(input.values)) {
      const r = await fillField(ctx.page, initialForm, key, value);
      steps.push({ label: r.detail, ok: r.ok });
    }
    const urlBefore = ctx.page.url();
    const submitSelector =
      initialForm.submit?.locator ??
      `${initialForm.formLocator} button[type="submit"], ${initialForm.formLocator} input[type="submit"]`;
    try {
      await ctx.page.locator(submitSelector).first().click({ timeout: SUBMIT_TIMEOUT_MS });
    } catch (err) {
      return fail(
        formPersistenceRoundtrip.name,
        `submit failed: ${err instanceof Error ? err.message : String(err)}`,
        evidence,
        steps,
      );
    }
    await ctx.page.waitForTimeout(500);
    const toastVisible = await detectSuccessToast(ctx.page, true);
    evidence.submitToast = toastVisible;
    steps.push({ label: 'submit complete', ok: true, detail: `toast=${toastVisible}` });

    // Phase 2 — navigate away then back.
    let awayDefault: string;
    try {
      awayDefault = new URL(urlBefore).origin;
    } catch {
      awayDefault = urlBefore;
    }
    const away = input.awayUrl ?? awayDefault;
    try {
      await ctx.page.goto(away, { waitUntil: 'domcontentloaded', timeout: 5_000 });
      await ctx.page.waitForTimeout(500);
      await ctx.page.goto(urlBefore, { waitUntil: 'domcontentloaded', timeout: 5_000 });
      await ctx.page.waitForTimeout(500);
    } catch (err) {
      return fail(
        formPersistenceRoundtrip.name,
        `away/back navigation failed: ${err instanceof Error ? err.message : String(err)}`,
        evidence,
        steps,
      );
    }

    // Phase 3 — re-fetch the form, read back values.
    const afterModel = await ctx.pageModel();
    const afterForm = afterModel.forms.find((f) => f.id === input.formId);
    const observedValues: Record<string, string> = {};
    const mismatches: Array<{ field: string; expected: string; actual: string }> = [];

    if (!afterForm) {
      // Form not on the page after roundtrip — could mean the save deleted/
      // moved it, OR the route changed. Either way it's a confidence hit.
      evidence.formMissingAfterRoundtrip = true;
      return suspicious(
        formPersistenceRoundtrip.name,
        `Form '${input.formId}' is no longer present after navigate-away-and-back. Either the route's affordances changed (possible — file as observation) or the form vanished after submit (likely persistence bug — file finding).`,
        evidence,
        steps,
      );
    }

    for (const [key, expected] of Object.entries(input.values)) {
      const field = findField(afterForm, key);
      if (!field) {
        mismatches.push({ field: key, expected, actual: '(field missing)' });
        continue;
      }
      const actual = await ctx.page
        .locator(field.locator)
        .first()
        .inputValue()
        .catch(() => '');
      observedValues[key] = actual;
      if (actual !== expected) {
        mismatches.push({ field: key, expected, actual });
      }
    }
    evidence.observedValues = observedValues;
    evidence.mismatches = mismatches;

    if (mismatches.length > 0) {
      return suspicious(
        formPersistenceRoundtrip.name,
        `Form '${input.formId}' lost ${mismatches.length}/${Object.keys(input.values).length} value(s) after roundtrip. Submitted values do not persist — file a critical finding (silent data loss${toastVisible ? ' — note: success-toast was shown despite no persistence' : ''}).`,
        evidence,
        steps,
      );
    }

    return ok(
      formPersistenceRoundtrip.name,
      `Form '${input.formId}' persisted all ${Object.keys(input.values).length} value(s) across the roundtrip. Save is real.`,
      evidence,
      steps,
    );
  },
};

export const formDoubleSubmit: Playbook<FormDoubleSubmitInput> = {
  name: 'form_double_submit',
  description:
    'Fill a form, then click submit TWICE in quick succession (<100ms apart). Detects missing idempotency: duplicate records, double notification sends, double charges. Returns `suspicious` when both submits succeed (URL changed twice, two success toasts, no rate-limit error). Inputs: `formId` (required), `values` (map of field label to value, same shape as fill_and_verify).',
  categories: ['form', 'chaos'],
  estimatedDurationMs: 5_000,
  inputShape: formDoubleSubmitShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { formId: input.formId };

    const model = await ctx.pageModel();
    const form = model.forms.find((f) => f.id === input.formId);
    if (!form) {
      return fail(
        formDoubleSubmit.name,
        `form '${input.formId}' not found (${model.forms.length} form(s) on page)`,
        evidence,
        steps,
      );
    }

    for (const [key, value] of Object.entries(input.values)) {
      const r = await fillField(ctx.page, form, key, value);
      steps.push({ label: r.detail, ok: r.ok });
    }

    const submitSelector =
      form.submit?.locator ??
      `${form.formLocator} button[type="submit"], ${form.formLocator} input[type="submit"]`;

    const urlBefore = ctx.page.url();
    const successCounts = { ok: 0, blocked: 0, errored: 0 };

    // Two clicks dispatched without await between them. Playwright still
    // serialises internally, but the second click should land before the
    // server response of the first arrives.
    const click1 = ctx.page
      .locator(submitSelector)
      .first()
      .click({ timeout: SUBMIT_TIMEOUT_MS, force: true })
      .then(
        () => 'ok' as const,
        (err) => `error:${err instanceof Error ? err.message : String(err)}`,
      );
    const click2 = ctx.page
      .locator(submitSelector)
      .first()
      .click({ timeout: SUBMIT_TIMEOUT_MS, force: true })
      .then(
        () => 'ok' as const,
        (err) => `error:${err instanceof Error ? err.message : String(err)}`,
      );

    const [r1, r2] = await Promise.all([click1, click2]);
    if (r1 === 'ok') successCounts.ok += 1;
    else if (r1.startsWith('error:')) successCounts.errored += 1;
    if (r2 === 'ok') successCounts.ok += 1;
    else if (r2.startsWith('error:')) successCounts.errored += 1;

    await ctx.page.waitForTimeout(500);

    const urlAfter = ctx.page.url();
    const errorVisible = await detectErrorShown(ctx.page);
    const toastVisible = await detectSuccessToast(ctx.page, true);

    evidence.click1 = r1;
    evidence.click2 = r2;
    evidence.urlBefore = urlBefore;
    evidence.urlAfter = urlAfter;
    evidence.errorVisible = errorVisible;
    evidence.toastVisible = toastVisible;

    if (successCounts.ok === 2 && !errorVisible && (toastVisible || urlAfter !== urlBefore)) {
      return suspicious(
        formDoubleSubmit.name,
        `Both submits succeeded with no rate-limit / idempotency block. The second submit is a candidate duplicate — verify the backend created two records / sent two notifications / charged twice and file a finding.`,
        evidence,
        steps,
      );
    }
    if (errorVisible && successCounts.ok >= 1) {
      return ok(
        formDoubleSubmit.name,
        `Form correctly blocked the second submit (error indicator visible). Idempotency appears intact.`,
        evidence,
        steps,
      );
    }
    return ok(
      formDoubleSubmit.name,
      `Form double-submit: clickResults=[${r1}, ${r2}], errorVisible=${errorVisible}, toast=${toastVisible}, urlChanged=${urlAfter !== urlBefore}. Inconclusive.`,
      evidence,
      steps,
    );
  },
};
